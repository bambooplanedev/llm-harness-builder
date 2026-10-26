import { describe, test, expect, vi } from 'vitest'
import { cp, copyFile, mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { runTests, score } from '../src/core/polyglot.js'
import { childEnv } from '../src/core/tools/env.js'

vi.setConfig({ testTimeout: 120_000 })

const SET = 'examples-polyglot'
const set: { source: { repo: string; commit: string }; excluded: { name: string; reason: string }[]; exercises: { name: string; difficulty: number; tests: string[] }[] } =
  JSON.parse(readFileSync(path.join(SET, 'set.json'), 'utf8'))
const { exercises } = set

/** The exercise as the bench lays it out: flat, with the bridge and the module marker, and `solution` as `<slug>.js`. */
const check = async (name: string, solution: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lhb-polyglot-set-'))
  await cp(path.join(SET, name), dir, { recursive: true })
  for (const f of ['expect.js', 'package.json']) await copyFile(path.join(SET, f), path.join(dir, f))
  await copyFile(solution, path.join(dir, `${name}.js`))
  const { results, exit } = await runTests(dir, `${name}.test.js`, childEnv())
  return score(results, exercises.find(e => e.name === name)!.tests, exit, `${name}.test.js`)
}

test('the set', () => {
  expect(exercises).toHaveLength(47)
  expect(new Set(exercises.map(e => e.name)).size).toBe(47)
  expect(set.excluded.map(e => e.name)).toEqual(['grep', 'ledger'])
  for (const e of set.excluded) expect([e.name, e.reason.length > 0, exercises.some(x => x.name === e.name)]).toEqual([e.name, true, false])
  expect(set.source).toEqual({ repo: 'exercism/javascript', commit: 'ff04f35158cdf61eebfdf18a774010495a1fd6d9' })
  for (const e of exercises) {
    expect([e.name, e.tests.length > 0, new Set(e.tests).size === e.tests.length]).toEqual([e.name, true, true])
  }
  const first = exercises.slice(0, 5).map(e => e.difficulty)
  expect(Math.min(...first)).toBeLessThanOrEqual(3)
  expect(Math.max(...first)).toBeGreaterThanOrEqual(6)
})

test('every exercise ships stub, test, instructions, and the test imports the bridge first', () => {
  for (const { name } of exercises) {
    for (const f of [`${name}.js`, `${name}.test.js`, 'INSTRUCTIONS.md']) expect([name, f, existsSync(path.join(SET, name, f))]).toEqual([name, f, true])
    const spec = readFileSync(path.join(SET, name, `${name}.test.js`), 'utf8')
    expect([name, /^import\s.*$/m.exec(spec)?.[0]]).toEqual([name, "import { expect } from './expect.js';"])
    expect([name, spec.includes(`from './${name}.js'`), /@jest\/globals|\bxtest\b|\bxit\b/.test(spec)]).toEqual([name, true, false])
  }
})

describe.concurrent('each exercise', () => {
  test.each(exercises.map(e => e.name))('%s: proof passes every recorded test', async name => {
    const n = exercises.find(e => e.name === name)!.tests.length
    expect(await check(name, path.join('polyglot-proofs', `${name}.js`))).toEqual({ pass: true, passed: n, total: n })
  })

  test.each(exercises.map(e => e.name))('%s: stub fails', async name => {
    const r = await check(name, path.join(SET, name, `${name}.js`))
    expect(r.passed).toBeLessThan(r.total)
  })
})

test.each(['node:assert', 'node:assert/strict'])('expect.js freezes %s', async mod => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lhb-polyglot-freeze-'))
  for (const f of ['expect.js', 'package.json']) await copyFile(path.join(SET, f), path.join(dir, f))
  await writeFile(path.join(dir, 'x.js'), `import './expect.js'\ntry { (await import('${mod}')).default.equal = () => {}; console.log('patched') } catch (e) { console.log(e.constructor.name) }\n`)
  const out = spawnSync(process.execPath, ['x.js'], { cwd: dir, env: childEnv(), encoding: 'utf8' })
  expect(out.stdout.trim()).toBe('TypeError')
})

// A solution runs after the bridge loads; accessors it puts on Object.prototype must not reach the matchers.
test('a solution cannot hand the tests its own matchers through Object.prototype', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lhb-polyglot-proto-'))
  for (const f of ['expect.js', 'package.json']) await copyFile(path.join(SET, f), path.join(dir, f))
  await writeFile(path.join(dir, 'x.js'), `for (const k of ['toEqual', 'toBe', 'toThrow', 'not', 'resolves', 'rejects', 'message', 'depth'])
  Object.defineProperty(Object.prototype, k, { configurable: true, set() {}, get() { return () => {} } })
export const answer = () => 1
`)
  await writeFile(path.join(dir, 'x.test.js'), `import { expect } from './expect.js';
import { test } from 'node:test';
import { answer } from './x.js';
test('equal', () => { expect(answer()).toEqual(2) });
test('be', () => { expect(answer()).toBe(2) });
test('throw', () => { expect(answer).toThrow() });
test('not', () => { expect(answer()).not.toBe(1) });
test('deep', () => { expect({ a: answer() }).toEqual({ a: 2 }) });
`)
  const { results, exit } = await runTests(dir, 'x.test.js', childEnv())
  expect(score(results, ['equal', 'be', 'throw', 'not', 'deep'], exit, 'x.test.js')).toMatchObject({ pass: false, passed: 0, total: 5 })
})
