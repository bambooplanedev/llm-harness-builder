// src/core/hooks.ts — the prompt hook (`hooks.userPrompt`): one child process before the first request, Claude Code's
// UserPromptSubmit contract. This file runs it and reads what it says; redacting and cutting the context is the run's job.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { PromptHookConfig } from './config.js'
import { track, untrack } from './procs.js'
import { childEnv } from './tools/env.js'

/** Claude Code's default for this event. */
export const HOOK_TIMEOUT_MS = 30_000
const READ_CAP = 1 << 20          // stdout, as bash's bashMaxBytes default
const STDERR_TAIL = 8 << 10       // as MCP's
// After exit: how long to wait for what is still in the pipes. Trades up to 200 ms per run whose hook leaves a
// background child holding stdout, against losing output Node had not read yet when `exit` fired.
const DRAIN_MS = 200

export type PromptHookResult = {
  ms: number
  exitCode?: number            // absent on spawn error, timeout, abort
  error?: 'spawn' | 'timeout' | 'aborted' | 'blocked'
  context?: string             // trimmed, non-empty, NOT yet redacted or cut
  reason?: string              // a block's `reason` (JSON) or stderr tail (exit 2)
  stderr?: string              // tail, ≤ 8192 chars
  readCapped?: boolean         // stdout hit the 1 MB read cap
}

type Outcome = Omit<PromptHookResult, 'ms' | 'stderr' | 'readCapped'>

/** What an exit says: exit 2 or a JSON `decision: "block"` blocks; exit 0 gives a context; anything else gives none. */
function parse(code: number | null, stdout: string, stderr: string): Outcome {
  if (code === null) return {}
  if (code === 2) return { exitCode: 2, error: 'blocked', reason: stderr.trim() }
  if (code !== 0) return { exitCode: code }
  const out = stdout.trim()
  let o: unknown
  try { o = JSON.parse(out) } catch {}
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    const j = o as { decision?: unknown; reason?: unknown; hookSpecificOutput?: { additionalContext?: unknown } }
    if (j.decision === 'block') return { exitCode: 0, error: 'blocked', reason: String(j.reason ?? '') }
    const ac = j.hookSpecificOutput?.additionalContext
    return { exitCode: 0, context: typeof ac === 'string' && ac.trim() ? ac.trim() : undefined }
  }
  return { exitCode: 0, context: out || undefined }
}

export function runPromptHook(
  hook: PromptHookConfig,
  input: { task: string; workdir: string },
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PromptHookResult> {
  const t0 = Date.now()
  if (opts.signal?.aborted) return Promise.resolve({ ms: 0, error: 'aborted' })
  return new Promise(resolve => {
    const child = spawn(hook.command, hook.args ?? [], {
      cwd: input.workdir, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...childEnv(), CLAUDE_PROJECT_DIR: input.workdir },
    })
    const pid = child.pid
    if (pid) track(pid)

    const out = new StringDecoder('utf8'), err = new StringDecoder('utf8')
    let stdout = '', stderr = '', bytes = 0, capped = false
    child.stdout.on('data', (d: Buffer) => {
      if (capped) return                                 // keep draining, so the hook never blocks on a full pipe
      const room = READ_CAP - bytes
      if (d.length >= room) { d = d.subarray(0, room); capped = true }
      bytes += d.length
      stdout += out.write(d)                             // a character cut at the cap is held back, never U+FFFD
    })
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + err.write(d)).slice(-STDERR_TAIL) })

    let settled = false, exited = false, killed: 'timeout' | 'aborted' | undefined, drain: NodeJS.Timeout | undefined
    const finish = (o: Outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer); clearTimeout(drain)
      opts.signal?.removeEventListener('abort', onAbort)
      if (pid) untrack(pid, { keepIfAlive: !killed })  // as bash: a background child left behind dies with the run
      child.stdout.destroy(); child.stderr.destroy()     // a grandchild holding the pipes must not keep the loop alive
      resolve({ ms: Date.now() - t0, ...o, ...(stderr ? { stderr } : {}), ...(capped ? { readCapped: true } : {}) })
    }
    const kill = (why: 'timeout' | 'aborted') => {
      if (settled || exited || killed) return          // after exit the pid may be reused: never kill by it then
      killed = why
      try { process.kill(-pid!, 'SIGKILL') } catch {}  // the whole group: a grandchild holding stdout dies too
    }
    const onAbort = () => kill('aborted')
    const timer = setTimeout(() => kill('timeout'), opts.timeoutMs ?? HOOK_TIMEOUT_MS)
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', () => finish({ error: 'spawn' }))
    // `exit`, not `close`: close waits for every holder of the pipes, a background grandchild included.
    child.on('exit', code => {
      exited = true
      if (killed) return finish({ error: killed })
      clearTimeout(timer)
      let open = 2
      const done = () => finish(parse(code, stdout, stderr))
      const ended = () => { if (--open === 0) done() }
      for (const s of [child.stdout, child.stderr]) s.closed ? ended() : s.once('close', ended)
      if (settled) return
      drain = setTimeout(done, DRAIN_MS)               // the pipes are still held: take what was read so far
    })

    child.stdin.on('error', () => {})                  // a hook that exits without reading must not raise EPIPE here
    child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: input.task, cwd: input.workdir, session_id: randomUUID() }))
  })
}
