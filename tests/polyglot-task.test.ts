import { describe, test, expect, vi, afterEach } from 'vitest'
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { childEnv } from '../src/core/tools/env.js'
import { loadPolyglot, polyglotTasks, POLYGLOT_MAX } from '../src/core/polyglot.js'
import { tmp } from './helpers.js'

vi.setConfig({ testTimeout: 120_000 })

const p = loadPolyglot()
const [first, second] = p.exercises
const total = first.tests.length
const proof = readFile(path.join('polyglot-proofs', `${first.name}.js`), 'utf8')
const env = childEnv()
const made: string[] = []
afterEach(async () => { await Promise.all(made.splice(0).map(d => rm(d, { recursive: true, force: true }))) })

/** A workdir holding `src` as the model's solution; the test file in it is the one given or the shipped one. */
const run = async (src: string, opts: { test?: string; timeoutMs?: number; task?: ReturnType<typeof polyglotTasks>[number] } = {}) => {
  const task = opts.task ?? polyglotTasks(p, 1, opts.timeoutMs)[0]
  const dir = await task.prepare()
  made.push(dir)
  await writeFile(path.join(dir, `${first.name}.js`), src)
  if (opts.test !== undefined) await writeFile(path.join(dir, `${first.name}.test.js`), opts.test)
  return task.check(dir, 1, undefined, env) as Promise<{ pass: boolean; reason?: string; tests: { passed: number; total: number } }>
}

test('the set loads', () => {
  expect(POLYGLOT_MAX).toBe(47)
  expect(p.exercises).toHaveLength(POLYGLOT_MAX)
  expect(p.expect).toContain('assert')
  expect(JSON.parse(p.pkg)).toEqual({ type: 'module', scripts: { test: 'node --test' } })
})

test('prepare writes the five files; polyglotTasks takes the first size exercises', async () => {
  const tasks = polyglotTasks(p, 2)
  expect(tasks.map(t => [t.name, t.tests])).toEqual([[first.name, total], [second.name, second.tests.length]])
  expect(tasks[0].prompt).toBe(`Implement ${first.name}.js so that the tests in ${first.name}.test.js pass: run \`node --test ${first.name}.test.js\`. INSTRUCTIONS.md describes the exercise. Keep the whole solution in ${first.name}.js. Do not edit ${first.name}.test.js or expect.js. Finally answer with a one-line summary.`)
  const dir = await tasks[0].prepare()
  made.push(dir)
  expect((await readdir(dir)).sort()).toEqual(['INSTRUCTIONS.md', 'expect.js', `${first.name}.js`, `${first.name}.test.js`, 'package.json'].sort())
})

test('npm test in a prepared workdir runs node --test', async () => {
  const dir = await polyglotTasks(p, 1)[0].prepare()
  made.push(dir)
  await writeFile(path.join(dir, `${first.name}.js`), await proof)
  const r = spawnSync('npm', ['test'], { cwd: dir, encoding: 'utf8', env })
  expect(r.status).toBe(0)
  expect(r.stdout).toMatch(/pass \d+/)
})

describe('check', () => {
  test('on the proof passes', async () => {
    expect(await run(await proof)).toEqual({ pass: true, tests: { passed: total, total } })
  })

  test('on the stub fails with passed < total', async () => {
    const r = await run(p.exercises[0].stub)
    expect(r.pass).toBe(false)
    expect(r.tests.passed).toBeLessThan(total)
    expect(r.tests.total).toBe(total)
  })

  test('ignores the workdir test', async () => {
    expect((await run(p.exercises[0].stub, { test: "import test from 'node:test'\ntest('x', () => {})\n" })).pass).toBe(false)
    expect((await run(await proof, { test: "import test from 'node:test'\ntest('x', () => { throw new Error('no') })\n" })).pass).toBe(true)
  })

  test('uses the bytes loaded at start', async () => {
    const root = await tmp('lhb-polyglot-root-')
    made.push(root)
    await cp('examples-polyglot', root, { recursive: true })
    const q = loadPolyglot(root)
    await writeFile(path.join(root, first.name, `${first.name}.test.js`), "import test from 'node:test'\ntest('x', () => {})\n")
    await writeFile(path.join(root, 'set.json'), '{}')
    expect(await run(await proof, { task: polyglotTasks(q, 1)[0] })).toEqual({ pass: true, tests: { passed: total, total } })
  })

  test('syntax error keeps the total from the set', async () => {
    const r = await run('export const x = (')
    expect(r.pass).toBe(false)
    expect(r.tests).toEqual({ passed: 0, total })
  })

  test('timeout gives passed 0 and says so', async () => {
    const r = await run(`${await proof}\nwhile (true) {}\n`, { timeoutMs: 2000 })
    expect(r.pass).toBe(false)
    expect(r.tests).toEqual({ passed: 0, total })
    expect(r.reason).toMatch(/timeout/)
  })

  // The old tripwire's cheats still fail: by the file check, the unknown-test check or the frozen assert, with no rule of its own.
  test('patching assert or exiting at the top does not pass', async () => {
    // Each dies before its tests report: the only result left is the file's own, under a name not in the set.
    const reason = `unexpected test "${first.name}.test.js"`
    for (const extra of ["import assert from 'assert'; assert.equal = () => {}\n", 'process.exit(0)\n'])
      expect(await run(`${await proof}\n${extra}`)).toMatchObject({ pass: false, tests: { total }, reason })
    expect(await run(`process.exit(0)\n${await proof}`)).toMatchObject({ pass: false, reason })
  })

  test('a correct solution that imports node:assert passes', async () => {
    expect((await run(`import assert from 'node:assert'\nassert.ok(true)\n${await proof}`)).pass).toBe(true)
    expect((await run(`${await proof}\nawait import(\`node:assert\`)\n`)).pass).toBe(true)
  })

  test('a correct solution using new Function passes', async () => {
    expect((await run(`${await proof}\nexport const one = new Function('return 1')()\nexport const two = eval('1 + 1')\n`)).pass).toBe(true)
  })

  test('process.exitCode = 0 and a comment about process.exit do not fail a correct solution; a non-zero exitCode does', async () => {
    expect((await run(`${await proof}\n// never process.exit here\nprocess.exitCode = 0\n`)).pass).toBe(true)
    expect((await run(`${await proof}\nprocess.exitCode = 1\n`)).pass).toBe(false)
  })

  // The solution registers its own tests under the recorded names, then exits before the real ones report.
  test('a solution that registers the recorded names itself fails', async () => {
    const cheat = `const t = process['getBuiltin' + 'Module']('node:test')
for (const n of ${JSON.stringify(first.tests)}) t.test(n, () => {})
t.test('end', async () => { await new Promise(r => setTimeout(r, 200)); process['ex' + 'it'](0) })
export const age = () => 0
`
    const r = await run(cheat)
    expect(r.pass).toBe(false)
    expect(r.reason).toMatch(/unexpected test/)
    expect(r.tests).toEqual({ passed: 0, total })
  })

  test('fake top-level tests through getBuiltinModule fail', async () => {
    const r = await run(`${await proof}\nconst t = process.getBuiltinModule('node:test')\nfor (const n of ${JSON.stringify(first.tests)}) t.test(n, () => {})\n`)
    expect(r.pass).toBe(false)
    expect(r.reason).toMatch(/unexpected test .* from /)
  })

  // The check lays the solution alone in a fresh dir, so the cheat writes its fake test file at import time.
  test('a fake test file in a subdirectory does not count', async () => {
    const fake = `const { test } = await import('node:' + 'test')\nfor (const n of ${JSON.stringify(first.tests)}) test(n, () => {})\n`
    const cheat = `import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('sub', { recursive: true })
writeFileSync('sub/${first.name}.test.js', ${JSON.stringify(fake)})
await import('./sub/${first.name}.test.js')
export const age = () => 0
`
    const r = await run(cheat)
    expect(r.pass).toBe(false)
    expect(r.reason).toMatch(/sub/)
  })

  test('the fail reason names the first failed test', async () => {
    const r = await run(first.stub)
    expect(r.reason).toBe(`a test failed: ${first.tests[0]}`)
  })

  test('a word list holding "test" and "assert" is no tripwire', async () => {
    expect((await run(`${await proof}\nexport const words = ['test', 'assert']\n`)).pass).toBe(true)
  })

  test('the bridge holds against patched built-ins', async () => {
    const r = await run(`${p.exercises[0].stub}\nObject.is = () => true; String.prototype.includes = () => true\n`)
    expect(r.pass).toBe(false)
  })

  test('a missing solution is passed: 0, and its reason names no exercise', async () => {
    const task = polyglotTasks(p, 1)[0]
    const dir = await task.prepare()
    made.push(dir)
    await rm(path.join(dir, `${first.name}.js`))
    expect(await task.check(dir, 1, undefined, env)).toEqual({ pass: false, reason: 'missing solution file', tests: { passed: 0, total } })
  })
})

test('dispose removes the workdir', async () => {
  const task = polyglotTasks(p, 1)[0]
  const dir = await task.prepare()
  made.push(dir)
  await task.dispose!(dir)
  await expect(readdir(dir)).rejects.toThrow()
})
