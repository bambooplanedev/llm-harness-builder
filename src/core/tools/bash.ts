import { spawn } from 'node:child_process'
import type { ToolCtx } from './fs.js'
import { childEnv } from './env.js'
import { track, untrack } from '../procs.js'

export type BashOpts = { timeoutMs?: number; maxBuffer?: number }

export type ShellOpts = { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer: number
  /** Which end of an output over maxBuffer is kept: the start (bash, as it always was), or the end (a check's summary is last). */
  keep?: 'head' | 'tail' }
export type ShellResult = { code: number | null; killed: boolean; out: string; capped: boolean; spawnError?: string }

/** `sh -c command` in its own process group: a timeout kills the group, background children with it. bash and the task checks share it. */
export function runShell(command: string, o: ShellOpts): Promise<ShellResult> {
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], { cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const pid = child.pid
    if (pid) track(pid)
    let killed = false
    // A normal close keeps a group with a background child in it (it dies with the run); a killed one is forgotten.
    const release = () => { clearTimeout(timer); if (pid) untrack(pid, { keepIfAlive: !killed }) }
    let chunks: Buffer[] = []
    let bytes = 0
    let capped = false
    const collect = (chunk: Buffer) => {
      if (o.keep === 'tail') {
        chunks.push(chunk); bytes += chunk.length
        if (bytes > o.maxBuffer) { const all = Buffer.concat(chunks); chunks = [all.subarray(all.length - o.maxBuffer)]; bytes = o.maxBuffer; capped = true }
        return
      }
      if (capped) return
      const room = o.maxBuffer - bytes
      if (chunk.length > room) { chunks.push(chunk.subarray(0, room)); bytes += room; capped = true }
      else { chunks.push(chunk); bytes += chunk.length }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => { killed = true; try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, o.timeoutMs)
    child.on('close', code => { release(); resolve({ code, killed, out: Buffer.concat(chunks).toString('utf8'), capped }) })
    child.on('error', err => { release(); resolve({ code: null, killed: false, out: '', capped: false, spawnError: err.message }) })
  })
}

export async function bash(args: Record<string, unknown>, ctx: ToolCtx, opts: BashOpts = {}): Promise<string> {
  const command = args.command
  if (typeof command !== 'string') throw new Error('argument "command" must be a string')
  const timeoutMs = opts.timeoutMs ?? (ctx.bashTimeoutS ?? 30) * 1000
  const r = await runShell(command, { cwd: ctx.workdir, env: childEnv(ctx.bashEnv), timeoutMs, maxBuffer: opts.maxBuffer ?? ctx.bashMaxBytes ?? 1 << 20 })
  if (r.spawnError !== undefined) return `[spawn error: ${r.spawnError}]`
  const tail = r.killed ? `[killed: timeout after ${timeoutMs / 1000}s]` : `[exit ${r.code ?? 'null'}]`
  return (r.capped ? r.out + '\n[output truncated]' : r.out) + '\n' + tail
}
