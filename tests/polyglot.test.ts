import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { runTests, score, type TestResult } from '../src/core/polyglot.js'

const HEAD = "import { describe, test } from 'node:test'\n"
const run = async (src: string, timeoutMs?: number) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lhb-polyglot-test-'))
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(dir, 'x.test.js'), HEAD + src)
  return runTests(dir, 'x.test.js', { ...process.env }, timeoutMs)
}
const r = (path: string, status: TestResult['status'] = 'pass', file = 'x.test.js'): TestResult => ({ path, status, file })

describe('runTests', () => {
  it('reports nested paths', async () => {
    const { results } = await run("describe('a', () => { test('x', () => {}) }); describe('b', () => { test('x', () => {}) })")
    expect(results).toEqual([r('a > x'), r('b > x')])
  })

  it('marks failures and skips', async () => {
    const { results, exit } = await run("test('bad', () => { throw new Error('no') }); test.skip('later', () => {})")
    expect(results).toEqual([r('bad', 'fail'), r('later', 'skip')])
    expect(exit).toBe(1)
  })

  it('ignores printed text', async () => {
    const { results } = await run(`test('real', () => { console.log('{"path":"fake","status":"pass"}'); process.stdout.write('# pass 99\\n') })`)
    expect(results).toEqual([r('real')])
  })

  it('times out', async () => {
    const t = Date.now()
    const out = await run('while (true) {}', 2000)
    expect(out.reason).toBe('timeout')
    expect(Date.now() - t).toBeLessThan(10_000)
  }, 15_000)

  it('ends a loud test', async () => {
    const out = await run("test('loud', () => { for (;;) console.log('x'.repeat(1000)) })", 2000)
    expect(out.reason).toBe('timeout')
  }, 15_000)

  it('on an abnormal exit', async () => {
    const { results } = await run('process.exit(0)')
    expect(results.map(x => x.path)).toEqual(['x.test.js'])
    expect(score(results, ['a'], 0, 'x.test.js').pass).toBe(false)
  })

  // Nothing else keeps a plain script's event loop alive: the result must not wait on an unref'd timer.
  it('resolves in a script with nothing else to wait on', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lhb-polyglot-test-'))
    await writeFile(path.join(dir, 'package.json'), '{"type":"module"}')
    await writeFile(path.join(dir, 'x.test.js'), HEAD + "test('a', () => {})")
    const src = `import { runTests } from ${JSON.stringify(path.resolve('src/core/polyglot.ts'))}; const r = await runTests(${JSON.stringify(dir)}, 'x.test.js', process.env); console.log(r.results.length)`
    const out = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', src], { encoding: 'utf8' })
    expect(out.stdout.trim()).toBe('1')
  })

  it('names the file each test came from', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lhb-polyglot-test-'))
    await writeFile(path.join(dir, 'package.json'), '{"type":"module"}')
    await writeFile(path.join(dir, 'sol.js'), "process.getBuiltinModule('node:test').test('fake', () => {})\n")
    await writeFile(path.join(dir, 'x.test.js'), HEAD + "import './sol.js'\ntest('real', () => {})")
    const { results } = await runTests(dir, 'x.test.js', { ...process.env })
    expect(results).toEqual(expect.arrayContaining([r('fake', 'pass', 'sol.js'), r('real')]))
  })

  // 'error' can follow or precede 'exit': the group is killed and forgotten once, never a second time on a reused pgid.
  it('ends once on error and exit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lhb-polyglot-test-'))
    const untrack = vi.fn()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = Object.assign(new EventEmitter(), { pid: 99_999_999, stdout: new PassThrough() })
    vi.resetModules()
    vi.doMock('../src/core/procs.js', () => ({ track: () => {}, untrack }))
    vi.doMock('node:child_process', async orig => ({ ...(await orig<object>()), spawn: () => {
      setImmediate(() => { child.emit('error', new Error('x')); child.emit('exit', 1); child.stdout.end() })
      return child
    } }))
    try {
      const { runTests: fresh } = await import('../src/core/polyglot.js')
      await fresh(dir, 'x.test.js', {})
      expect(untrack).toHaveBeenCalledTimes(1)
      expect(kill.mock.calls.filter(([p]) => p === -99_999_999)).toHaveLength(1)
    } finally {
      kill.mockRestore()
      vi.doUnmock('../src/core/procs.js')
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })
})

describe('score', () => {
  const names = ['a', 'b']
  const sc = (results: TestResult[], exit: number | null = 0) => score(results, names, exit, 'x.test.js')
  const rejects = (results: TestResult[], exit: number | null = 0) => {
    const out = sc(results, exit)
    expect(out.pass).toBe(false)
    expect(out.reason).toBeDefined()
    return out
  }
  it('passes when every name passed once', () => expect(sc([r('a'), r('b')])).toEqual({ pass: true, passed: 2, total: 2 }))
  it('rejects an unknown path', () => { rejects([r('a'), r('b'), r('c')]) })
  it('rejects a duplicate', () => { rejects([r('a'), r('a'), r('b')]) })
  it('rejects a pass and a skip of one name', () => expect(rejects([r('a'), r('a', 'skip'), r('b')]).reason).toMatch(/twice/))
  it('rejects a recorded name run from another file, and does not count it', () => expect(rejects([r('a', 'pass', 'x.js'), r('b')])).toMatchObject({ passed: 1, reason: expect.stringMatching(/x\.js/) }))
  it('rejects a skip run from another file', () => { rejects([r('a'), r('b'), r('z', 'skip', 'x.js')]) })
  it('counts a missing name', () => expect(rejects([r('a')])).toMatchObject({ passed: 1, total: 2 }))
  it('rejects a bad exit', () => { rejects([r('a'), r('b')], 1) })
  it('rejects a fail', () => expect(rejects([r('a'), r('b', 'fail')], 1)).toMatchObject({ passed: 1 }))
  it('ignores skips of unrecorded names', () => expect(sc([r('a'), r('b'), r('z', 'skip')]).pass).toBe(true))
  it('handles empty results', () => expect(rejects([])).toMatchObject({ passed: 0, total: 2 }))
})
