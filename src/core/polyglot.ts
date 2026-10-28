// src/core/polyglot.ts — runs an exercise's node:test file and scores it by the test names recorded at bench start.
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Task } from './tasks.js'
import { childEnv } from './tools/env.js'
import { track, untrack } from './procs.js'

/** `file`: the full path of the file that registered the test — the check dir's test file, unless the solution registered its own. */
export type TestResult = { path: string; status: 'pass' | 'fail' | 'skip'; file?: string }

const REPORTER_FILE = 'lhb-reporter.mjs'
/** Runs inside `node --test`, outside the model's module: the child's prints reach it only as test:stdout events, which it drops.
 *  The describe path comes from test:start (declaration order, `nesting` is the depth); completion events can arrive before their start. */
const REPORTER = `export default async function* (source) {
  const stack = []
  for await (const { type, data } of source) {
    if (type === 'test:start') { stack.length = data.nesting; stack.push(data.name) }
    else if ((type === 'test:pass' || type === 'test:fail') && data.details?.type !== 'suite') {
      const path = [...stack.slice(0, data.nesting), data.name].join(' > ')
      yield JSON.stringify({ path, status: type === 'test:fail' ? 'fail' : data.skip === true ? 'skip' : 'pass', file: data.file }) + '\\n'
    }
  }
}
`

const parse = (out: string): TestResult[] => out.split('\n').flatMap(line => {
  try {
    const x = JSON.parse(line)
    return typeof x?.path === 'string' && ['pass', 'fail', 'skip'].includes(x.status) ? [{ path: x.path, status: x.status, ...(typeof x.file === 'string' ? { file: x.file } : {}) }] : []
  } catch { return [] }
})

/** Async, like `checkSlug`: serve must not stall. On the timeout the whole group dies. Resolves on 'exit', not 'close':
 *  a grandchild that kept the pipe open would hold 'close' back past the timeout. */
export async function runTests(dir: string, testFile: string, env: NodeJS.ProcessEnv, timeoutMs = 60_000):
  Promise<{ results: TestResult[]; exit: number | null; reason?: 'timeout' }> {
  await writeFile(path.join(dir, REPORTER_FILE), REPORTER)
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--test', `--test-reporter=./${REPORTER_FILE}`, testFile], { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const pid = child.pid
    if (pid) track(pid)
    let out = '', timedOut = false
    child.stdout.on('data', d => { out += d })
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-pid!, 'SIGKILL') } catch {} }, timeoutMs)
    let ended = false
    const end = (exit: number | null) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      if (pid) { try { process.kill(-pid, 'SIGKILL') } catch {}; untrack(pid) }
      // The last chunk may still be in the pipe at 'exit'; a stray holder of the pipe cannot delay us past this.
      const done = () => resolve({ results: parse(out), exit, ...(timedOut ? { reason: 'timeout' as const } : {}) })
      child.stdout.once('close', done)
      setTimeout(done, 200)
    }
    child.on('exit', code => end(code))
    child.on('error', () => end(null))
  })
}

/** PASS needs every recorded name to pass exactly once from `testFile`, nothing else recorded, no fail, exit 0.
 *  A skip of an unrecorded name in `testFile` is harmless; any test registered elsewhere (by the solution) is not. */
export function score(results: TestResult[], names: string[], exit: number | null, testFile: string): { pass: boolean; passed: number; total: number; reason?: string } {
  const known = new Set(names)
  const count = (p: string, s: TestResult['status']) => results.filter(x => x.path === p && x.status === s && x.file === testFile).length
  const passed = names.filter(n => count(n, 'pass') === 1 && !count(n, 'fail')).length
  const base = { passed, total: names.length }
  const seen = new Set<string>()
  for (const { path: p, status, file } of results) {
    if (file !== testFile) return { pass: false, ...base, reason: `unexpected test "${p}" from ${file ? path.relative(path.dirname(testFile), file) : 'an unknown file'}` }
    if (status === 'skip' && !known.has(p)) continue
    if (!known.has(p)) return { pass: false, ...base, reason: `unexpected test "${p}"` }
    if (seen.has(p)) return { pass: false, ...base, reason: `test "${p}" reported twice` }
    seen.add(p)
  }
  const failed = results.find(x => x.status === 'fail')
  if (failed) return { pass: false, ...base, reason: `a test failed: ${failed.path.slice(0, 200)}` }
  if (exit !== 0) return { pass: false, ...base, reason: `exit ${exit}` }
  if (passed !== names.length) return { pass: false, ...base, reason: `${names.length - passed} of ${names.length} tests did not pass` }
  return { pass: true, ...base }
}

export type Exercise = { name: string; difficulty: number; tests: string[]; stub: string; test: string; instructions: string }
export type Polyglot = { exercises: Exercise[]; expect: string; pkg: string }
export const POLYGLOT_MAX = 47

const SET_ROOT = path.join(fileURLToPath(new URL('../..', import.meta.url)), 'examples-polyglot')

/** Reads the whole set once; everything after (prepare, check) works from these bytes, never from the disk again. */
export function loadPolyglot(root = SET_ROOT): Polyglot {
  const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8')
  const set: { exercises: { name: string; difficulty: number; tests: string[] }[] } = JSON.parse(read('set.json'))
  return {
    exercises: set.exercises.map(e => ({ ...e, stub: read(e.name, `${e.name}.js`), test: read(e.name, `${e.name}.test.js`), instructions: read(e.name, 'INSTRUCTIONS.md') })),
    expect: read('expect.js'),
    pkg: read('package.json'),
  }
}

// Every workdir not yet removed, for a Ctrl-C handler that exits right after it.
const LIVE = new Set<string>()
const drop = async (dir: string) => { await rm(dir, { recursive: true, force: true }); LIVE.delete(dir) }
/** Each polyglot workdir that is still there (the model's and a check's), removed now. */
export function removeAllPolyglotSync(): void {
  for (const d of [...LIVE]) { rmSync(d, { recursive: true, force: true }); LIVE.delete(d) }
}

const lay = async (p: Polyglot, e: Exercise, solution: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lhb-polyglot-'))
  LIVE.add(dir)
  try {
    await Promise.all([[`${e.name}.js`, solution], [`${e.name}.test.js`, e.test], ['expect.js', p.expect], ['package.json', p.pkg], ['INSTRUCTIONS.md', e.instructions]]
      .map(([f, c]) => writeFile(path.join(dir, f), c)))
  } catch (err) { await drop(dir); throw err }
  return dir
}

const promptOf = (n: string) => `Implement ${n}.js so that the tests in ${n}.test.js pass: run \`node --test ${n}.test.js\`. INSTRUCTIONS.md describes the exercise. Keep the whole solution in ${n}.js. Do not edit ${n}.test.js or expect.js. Finally answer with a one-line summary.`

export function polyglotTasks(p: Polyglot, size: number, timeoutMs = 60_000): Task[] {
  return p.exercises.slice(0, size).map(e => ({
    name: e.name,
    tests: e.tests.length,
    prompt: promptOf(e.name),
    prepare: () => lay(p, e, e.stub),
    async check(workdir, _size, _answer, env) {
      const tests = { passed: 0, total: e.tests.length }
      let src: string
      try { src = await readFile(path.join(workdir, `${e.name}.js`), 'utf8') } catch { return { pass: false, reason: 'missing solution file', tests } }
      const dir = await lay(p, e, src)
      try {
        const testFile = path.join(await realpath(dir), `${e.name}.test.js`)
        const run = await runTests(dir, `${e.name}.test.js`, env ?? childEnv(), timeoutMs)
        // A killed run's partial passes do not count: a timeout is passed 0.
        if (run.reason === 'timeout') return { pass: false, reason: `timeout after ${timeoutMs} ms`, tests }
        const s = score(run.results, e.tests, run.exit, testFile)
        return { pass: s.pass, ...(s.reason ? { reason: s.reason } : {}), tests: { passed: s.passed, total: s.total } }
      } finally { await drop(dir) }
    },
    dispose: drop,
  }))
}

/** What ties a paragraph to these exercises, for bindingTokens: its recorded test names and a hyphenated name
 *  (`affine-cipher`) as words kept at any length, its files and prompt. A one-word name (`say`, `poker`) is an ordinary
 *  word: refusing it would burn a round's candidates. A hyphenated name the set no longer has is still a word. */
export function polyglotBinding(p: Polyglot, names: string[]): { names: string[]; words: string[]; paths: string[]; prompts: string[] } {
  const known = names.flatMap(n => p.exercises.filter(e => e.name === n))
  return {
    names: [], words: [...names.filter(n => n.includes('-')), ...known.flatMap(e => e.tests)],
    paths: [...known.flatMap(e => [`${e.name}/${e.name}.js`, `${e.name}/${e.name}.test.js`, `${e.name}/INSTRUCTIONS.md`]), ...(known.length ? ['expect.js'] : [])],
    prompts: known.map(e => promptOf(e.name)),
  }
}
