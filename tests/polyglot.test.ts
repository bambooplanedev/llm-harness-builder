import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runTests, score, type TestResult } from '../src/core/polyglot.js'

const HEAD = "import { describe, test } from 'node:test'\n"
const run = async (src: string, timeoutMs?: number) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lhb-polyglot-test-'))
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(dir, 'x.test.js'), HEAD + src)
  return runTests(dir, 'x.test.js', { ...process.env }, timeoutMs)
}
const r = (path: string, status: TestResult['status'] = 'pass'): TestResult => ({ path, status })

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
  })

  it('ends a loud test', async () => {
    const out = await run("test('loud', () => { for (;;) console.log('x'.repeat(1000)) })", 2000)
    expect(out.reason).toBe('timeout')
  }, 15_000)

  it('on an abnormal exit', async () => {
    const { results } = await run('process.exit(0)')
    expect(results.map(x => x.path)).toEqual(['x.test.js'])
    expect(score(results, ['a'], 0).pass).toBe(false)
  })
})

describe('score', () => {
  const names = ['a', 'b']
  it('passes when every name passed once', () => expect(score([r('a'), r('b')], names, 0)).toEqual({ pass: true, passed: 2, total: 2 }))
  it('rejects an unknown path', () => expect(score([r('a'), r('b'), r('c')], names, 0).pass).toBe(false))
  it('rejects a duplicate', () => expect(score([r('a'), r('a'), r('b')], names, 0).pass).toBe(false))
  it('counts a missing name', () => expect(score([r('a')], names, 0)).toMatchObject({ pass: false, passed: 1, total: 2 }))
  it('rejects a bad exit', () => expect(score([r('a'), r('b')], names, 1).pass).toBe(false))
  it('rejects a fail', () => expect(score([r('a'), r('b', 'fail')], names, 1)).toMatchObject({ pass: false, passed: 1 }))
  it('ignores skips of unrecorded names', () => expect(score([r('a'), r('b'), r('z', 'skip')], names, 0).pass).toBe(true))
  it('handles empty results', () => expect(score([], names, 0)).toMatchObject({ pass: false, passed: 0, total: 2 }))
})
