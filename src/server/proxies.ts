// src/server/proxies.ts — the recording proxies `serve` runs for the page: each one a child `proxy` CLI, so every
// upstream and own-file check stays in cmdProxy and a broken own dialect crashes its own process, not serve.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'

export type ProxyItem = {
  id: string; name: string; upstream: string; port: number; started: number
  /** The stderr lines right after the ready line: hints and the own files it loaded. */
  lines: string[]
  /** Stderr after those, the last 2000 chars: record problems, a crash. */
  tail: string
  exit?: { code: number | null; signal: string | null }
}
type Result = { status: number; body: unknown }

const MAX = 8
const TAIL = 2000
/** How long after the ready line its hints and own-file lines are still `lines`; the CLI prints them all at once. */
const SETTLE_MS = 300
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const READY = /^proxy on http:\/\/127\.0\.0\.1:(\d+)\/v1 -> /
const CONTROL = /[\u0000-\u001f\u007f]/
const plain = (v: unknown): v is string => typeof v === 'string' && !CONTROL.test(v)
const absList = (v: unknown) => v === undefined ? [] : Array.isArray(v) && v.every(p => plain(p) && path.isAbsolute(p)) ? v as string[] : undefined

export function proxies(cli: (args: string[]) => ChildProcess, killMs = 5000) {
  type Entry = { item: ProxyItem; child: ChildProcess; stopping?: Promise<unknown> }
  const items = new Map<string, Entry>()
  /** Names whose start is still waiting for its ready line: they count against the cap and the name. */
  const starting = new Set<string>()
  /** Their children, so a closing serve signals them too. */
  const startingChildren = new Set<ChildProcess>()
  let shutting = false
  const live = () => [...items.values()].filter(p => !p.item.exit)

  /** SIGINT, as Ctrl-C; SIGKILL if it is still there after killMs (a sync loop in an own dialect blocks the handler). */
  function kill(child: ChildProcess) {
    child.kill('SIGINT')
    const t = setTimeout(() => child.kill('SIGKILL'), killMs)
    child.once('exit', () => clearTimeout(t))
  }
  /** One stop per proxy: a second SIGINT tells cmdProxy its graceful stop is stuck, and it exits 130 without `done`. */
  const halt = (p: Entry) => p.stopping ??= new Promise(r => { p.child.once('exit', r); kill(p.child) })

  async function start(body: Record<string, unknown>): Promise<Result> {
    const { upstream, port, name } = body
    const dialects = absList(body.dialects), connections = absList(body.connections)
    if (typeof name !== 'string' || !ID.test(name)) return { status: 400, body: { error: 'name: lowercase letters, digits and -, at most 64' } }
    if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65535) return { status: 400, body: { error: 'port must be an integer from 0 to 65535' } }
    if (!plain(upstream)) return { status: 400, body: { error: 'upstream must be a string without control characters' } }
    if (!dialects || !connections) return { status: 400, body: { error: 'dialects and connections must be lists of absolute paths without control characters' } }
    if (live().length + starting.size >= MAX) return { status: 409, body: { error: `at most ${MAX} proxies run at once; stop one first` } }
    if (starting.has(name) || live().some(p => p.item.name === name)) return { status: 409, body: { error: `a proxy named "${name}" is already running` } }

    starting.add(name)
    let spawned: ChildProcess | undefined
    try {
      const child = spawned = cli(['proxy', `--upstream=${upstream}`, `--port=${port}`, `--name=${name}`,
        ...dialects.map(d => `--dialect=${d}`), ...connections.map(c => `--connection=${c}`)])
      child.stdout?.resume() // nothing reads its stdout: a full pipe would stall it
      startingChildren.add(child)
      const item: ProxyItem = { id: randomUUID(), name, upstream, port: 0, started: Date.now(), lines: [], tail: '' }
      let err = '' // all of stderr until it is listed: the 502 shows it
      let buf = '' // the part of a line not yet ended
      let phase: 'wait' | 'settle' | 'run' | 'failed' = 'wait'
      let ready!: (y: boolean) => void
      const answered = new Promise<boolean>(r => { ready = r })
      child.stderr?.on('data', (c: Buffer) => {
        const s = String(c)
        if (phase === 'run') { item.tail = (item.tail + s).slice(-TAIL); return }
        err = (err + s).slice(-TAIL)
        if (phase === 'failed') return
        buf += s
        for (let i; (i = buf.indexOf('\n')) >= 0;) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1)
          if (phase === 'settle') { if (item.lines.length < 100) item.lines.push(line); else item.tail = (item.tail + line + '\n').slice(-TAIL); continue }
          const m = READY.exec(line)
          if (!m) { phase = 'failed'; ready(false); return }
          item.port = Number(m[1]); phase = 'settle'
          setTimeout(() => { phase = 'run'; if (buf) item.tail = (item.tail + buf).slice(-TAIL); buf = ''; ready(true) }, SETTLE_MS)
        }
      })
      child.once('exit', (code, signal) => { item.exit = { code, signal } })
      // close, not exit: exit may come before the last of stderr, the ready line included.
      const closed = new Promise<void>(r => child.once('close', () => { if (phase === 'wait') ready(false); r() }))
      child.once('error', e => { err ||= e.message; ready(false) })
      if (!await answered || shutting) {
        if (child.pid !== undefined) { // it spawned: stop it if it still runs, and take the rest of its stderr
          if (!item.exit && !shutting) kill(child) // close() already signalled it
          await closed
        }
        return { status: 502, body: { error: shutting ? 'serve is closing' : err.trim() || 'proxy exited before it was ready' } }
      }
      items.set(item.id, { item, child })
      return { status: 201, body: item }
    } finally { starting.delete(name); if (spawned) startingChildren.delete(spawned) }
  }

  /** A live one is stopped and removed once it exits; a dead one is just removed. */
  async function stop(id: string): Promise<Result> {
    const p = items.get(id)
    if (!p) return { status: 404, body: { error: 'no such proxy' } }
    if (!p.item.exit) await halt(p)
    items.delete(id)
    return { status: 200, body: p.item }
  }

  return {
    list: () => [...items.values()].map(p => p.item),
    start, stop,
    /** Stops them all without waiting: serve is closing. */
    close: () => {
      shutting = true
      for (const p of live()) void halt(p)
      for (const c of startingChildren) if (c.exitCode === null && c.signalCode === null) kill(c)
    },
  }
}
