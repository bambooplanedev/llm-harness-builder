import { spawn } from 'node:child_process'
import type { ToolCtx } from './fs.js'
import { track, untrack } from '../procs.js'

export type BashOpts = { timeoutMs?: number; maxBuffer?: number }

export function bash(args: Record<string, unknown>, ctx: ToolCtx, opts: BashOpts = {}): Promise<string> {
  const command = args.command
  if (typeof command !== 'string') return Promise.reject(new Error('argument "command" must be a string'))
  const timeoutMs = opts.timeoutMs ?? 30_000
  const maxBuffer = opts.maxBuffer ?? 1 << 20
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], { cwd: ctx.workdir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const pid = child.pid
    if (pid) track(pid)
    const release = () => { clearTimeout(timer); if (pid) untrack(pid) }
    const chunks: Buffer[] = []
    let bytes = 0
    let capped = false
    const collect = (chunk: Buffer) => {
      if (capped) return
      const room = maxBuffer - bytes
      if (chunk.length > room) { chunks.push(chunk.subarray(0, room)); bytes += room; capped = true }
      else { chunks.push(chunk); bytes += chunk.length }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    let killed = false
    const timer = setTimeout(() => { killed = true; try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, timeoutMs)
    child.on('close', code => {
      release()
      const out = Buffer.concat(chunks).toString('utf8')
      const tail = killed ? `[killed: timeout after ${timeoutMs / 1000}s]` : `[exit ${code ?? 'null'}]`
      resolve((capped ? out + '\n[output truncated]' : out) + '\n' + tail)
    })
    child.on('error', err => { release(); resolve(`[spawn error: ${err.message}]`) })
  })
}
