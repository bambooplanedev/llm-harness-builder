// src/core/polyglot.ts — runs an exercise's node:test file and scores it by the test names recorded at bench start.
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { track, untrack } from './procs.js'

export type TestResult = { path: string; status: 'pass' | 'fail' | 'skip' }

const REPORTER_FILE = 'lhb-reporter.mjs'
/** Runs inside `node --test`, outside the model's module: the child's prints reach it only as test:stdout events, which it drops.
 *  The describe path comes from test:start (declaration order, `nesting` is the depth); completion events can arrive before their start. */
const REPORTER = `export default async function* (source) {
  const stack = []
  for await (const { type, data } of source) {
    if (type === 'test:start') { stack.length = data.nesting; stack.push(data.name) }
    else if ((type === 'test:pass' || type === 'test:fail') && data.details?.type !== 'suite') {
      const path = [...stack.slice(0, data.nesting), data.name].join(' > ')
      yield JSON.stringify({ path, status: type === 'test:fail' ? 'fail' : data.skip === true ? 'skip' : 'pass' }) + '\\n'
    }
  }
}
`

const parse = (out: string): TestResult[] => out.split('\n').flatMap(line => {
  try {
    const x = JSON.parse(line)
    return typeof x?.path === 'string' && ['pass', 'fail', 'skip'].includes(x.status) ? [{ path: x.path, status: x.status }] : []
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
    const end = (exit: number | null) => {
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

/** PASS needs every recorded name to pass exactly once, nothing else recorded, no fail, exit 0. A skip of an unrecorded name is harmless. */
export function score(results: TestResult[], names: string[], exit: number | null): { pass: boolean; passed: number; total: number; reason?: string } {
  const known = new Set(names)
  const count = (p: string, s: TestResult['status']) => results.filter(x => x.path === p && x.status === s).length
  const passed = names.filter(n => count(n, 'pass') === 1 && !count(n, 'fail')).length
  const base = { passed, total: names.length }
  const seen = new Set<string>()
  for (const { path: p, status } of results) {
    if (status === 'skip' && !known.has(p)) continue
    if (!known.has(p)) return { pass: false, ...base, reason: `unexpected test "${p}"` }
    if (status !== 'skip' && seen.has(`${p}\0${status}`)) return { pass: false, ...base, reason: `test "${p}" reported twice` }
    seen.add(`${p}\0${status}`)
  }
  if (results.some(x => x.status === 'fail')) return { pass: false, ...base, reason: 'a test failed' }
  if (exit !== 0) return { pass: false, ...base, reason: `exit ${exit}` }
  if (passed !== names.length) return { pass: false, ...base, reason: `${names.length - passed} of ${names.length} tests did not pass` }
  return { pass: true, ...base }
}
