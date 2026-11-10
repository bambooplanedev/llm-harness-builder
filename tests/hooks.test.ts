import { test, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { tmp } from './helpers.js'
import { runPromptHook } from '../src/core/hooks.js'
import { killTracked } from '../src/core/procs.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/prompt-hook.mjs', import.meta.url))
const hook = (mode: string) => ({ command: process.execPath, args: [FIXTURE, mode] })
const run = async (mode: string, opts?: { signal?: AbortSignal; timeoutMs?: number }, task = 'TASK') =>
  runPromptHook(hook(mode), { task, workdir: await tmp('lhb-hook-') }, opts)

test('stdin carries the four fields and the env holds CLAUDE_PROJECT_DIR, not the key', async () => {
  const before = process.env.LHB_TEST_API_KEY
  process.env.LHB_TEST_API_KEY = 'sk-secret'
  try {
    const wd = await tmp('lhb-hook-')
    const r = await runPromptHook(hook('echo-stdin'), { task: 'TASK', workdir: wd })
    expect(r.exitCode).toBe(0)
    const [json, ...rest] = r.context!.split('\n')
    const got = JSON.parse(json)
    expect(got).toMatchObject({ hook_event_name: 'UserPromptSubmit', prompt: 'TASK', cwd: wd })
    expect(got.session_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rest).toContain(`CLAUDE_PROJECT_DIR=${wd}`)
    expect(rest).toContain('KEY_SEEN=no')
  } finally {
    if (before === undefined) delete process.env.LHB_TEST_API_KEY
    else process.env.LHB_TEST_API_KEY = before
  }
})

test('plain stdout is the trimmed context', async () => {
  expect(await run('plain')).toMatchObject({ exitCode: 0, context: 'ctx line' })
})

test('additionalContext is the context; a JSON object without it gives none', async () => {
  expect(await run('json-ctx')).toMatchObject({ exitCode: 0, context: 'from json' })
  const r = await run('json-empty')
  expect(r.exitCode).toBe(0)
  expect(r.context).toBeUndefined()
})

test('non-zero exit gives no context', async () => {
  const r = await run('fail')
  expect(r.exitCode).toBe(1)
  expect(r.context).toBeUndefined()
  expect(r.error).toBeUndefined()
})

test('exit 2 and decision block are blocked with a reason', async () => {
  const a = await run('exit2')
  expect(a).toMatchObject({ error: 'blocked', exitCode: 2, reason: 'no secrets please' })
  expect(a.context).toBeUndefined()
  const b = await run('block')
  expect(b).toMatchObject({ error: 'blocked', exitCode: 0, reason: 'R' })
  expect(b.context).toBeUndefined()
})

test('spawn error', async () => {
  const r = await runPromptHook({ command: '/nonexistent/hook' }, { task: 'T', workdir: await tmp('lhb-hook-') })
  expect(r.error).toBe('spawn')
  expect(r.exitCode).toBeUndefined()
})

test('timeout', async () => {
  const r = await run('hang', { timeoutMs: 300 })
  expect(r.error).toBe('timeout')
  expect(r.ms).toBeLessThan(2000)
  expect(r.context).toBeUndefined()
  expect(r.exitCode).toBeUndefined()
})

test('grandchild holding stdout', async () => {
  const t0 = Date.now()
  const r = await run('grandchild', { timeoutMs: 300 })
  expect(Date.now() - t0).toBeLessThan(2000)
  expect(r.error).toBe('timeout')
  const grandPid = Number(r.stderr!.trim().split('\n')[0])
  expect(grandPid).toBeGreaterThan(0)
  // SIGKILL is immediate, but the orphan is reaped by init a moment later.
  for (let i = 0; i < 50; i++) { try { process.kill(grandPid, 0) } catch { break } await new Promise(res => setTimeout(res, 20)) }
  expect(() => process.kill(grandPid, 0)).toThrow()
})

test('a hook that exits leaving a background child holding stdout settles at once, and the child stays tracked', async () => {
  const t0 = Date.now()
  const r = await run('background')
  const grandPid = Number(r.stderr!.trim().split('\n')[0])
  try {
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(r).toMatchObject({ exitCode: 0, context: 'ctx' })
    expect(r.error).toBeUndefined()
    expect(() => process.kill(grandPid, 0)).not.toThrow()
    await killTracked()
    for (let i = 0; i < 50; i++) { try { process.kill(grandPid, 0) } catch { break } await new Promise(res => setTimeout(res, 20)) }
    expect(() => process.kill(grandPid, 0)).toThrow()
  } finally { try { process.kill(grandPid, 'SIGKILL') } catch {} }
})

test('exits without reading 2 MB', async () => {
  const r = await run('no-read', undefined, 'x'.repeat(2 << 20))
  expect(r.exitCode).toBe(0)
  expect(r.error).toBeUndefined()
})

test('flood is capped while reading', async () => {
  const r = await run('flood')
  expect(r.readCapped).toBe(true)
  expect(r.context!.length).toBeLessThanOrEqual(1_048_576)
  expect(r.context!.length).toBeGreaterThan(0)
})

test('abort', async () => {
  const c = new AbortController()
  setTimeout(() => c.abort(), 100)
  const r = await run('hang', { signal: c.signal })
  expect(r.error).toBe('aborted')
  expect(r.ms).toBeLessThan(2000)
  expect(r.context).toBeUndefined()
})

test('stderr is kept apart', async () => {
  const r = await run('stderr')
  expect(r.context).toBe('ok')
  expect(r.stderr).toContain('MARKER-ERR')
})
