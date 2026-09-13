import { appendFile, readFile, readdir, writeFile, mkdir, realpath, open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { runAgent } from '../core/run.js'
import type { RunParams } from '../core/config.js'
import type { HarnessEvent, ToolCall } from '../core/events.js'
import type { Backend, Delta } from '../core/backends/types.js'
import type { BenchResult, BenchFile } from '../core/bench.js'

export type RunSummary = { id: string; harness: string; task: string; workdir: string; started: number; reason?: string; turns?: number; toolCallCount?: number }
export type Meta = { meta: {
  id: string; harness: string; task: string; workdir: string; started: number
  /** Only on runs started by `bench`: the bench JSON's basename (a label, not a key) and the round. */
  bench?: { file: string; round: number }
} }
/** Live-only: fanned out to listeners, never written to the run file, no seq. */
export type DeltaMsg = Delta & { type: 'delta' }
type Listener = (e: HarnessEvent | DeltaMsg) => void
type Active = { abort: AbortController; approvals: Map<string, (ok: boolean) => void>; workdir: string; listeners: Set<Listener>; timer?: NodeJS.Timeout }

const APPROVAL_TIMEOUT_MS = 10 * 60_000
const CHUNK = 64 * 1024

/** Safe single path segment: no separators, so path.join can never leave the directory. */
export const safeName = (n: string) => /^[\w.-]{1,64}$/.test(n)

/** First and last line of a run file without reading it whole: run files grow to hundreds of KB and are listed on every page load. */
async function firstAndLastLine(file: string): Promise<[string, string]> {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    if (size > 2 * CHUNK) {
      const head = Buffer.alloc(CHUNK), tail = Buffer.alloc(CHUNK)
      await fh.read(head, 0, CHUNK, 0); await fh.read(tail, 0, CHUNK, size - CHUNK)
      const h = head.toString('utf8'), t = tail.toString('utf8').trimEnd()
      const hn = h.indexOf('\n'), tn = t.lastIndexOf('\n')
      if (hn !== -1 && tn !== -1) return [h.slice(0, hn), t.slice(tn + 1)]
    }
  } finally { await fh.close() }
  const lines = (await readFile(file, 'utf8')).trim().split('\n')
  return [lines[0], lines[lines.length - 1]]
}

/** Thrown by start() when another run is already active in the same realpath'd workdir. */
export class WorkdirBusyError extends Error {
  constructor(workdir: string) { super(`a run is already active in this workdir: ${workdir}`) }
}

export class RunStore {
  private active = new Map<string, Active>()
  constructor(private dir: string) {}

  private file(id: string) { return path.join(this.dir, `${id}.jsonl`) }

  private isActiveIn(realWorkdir: string): boolean {
    for (const a of this.active.values()) if (a.workdir === realWorkdir) return true
    return false
  }

  async start(params: RunParams, backend?: Backend): Promise<string> {
    const workdir = await realpath(params.workdir)
    // Check-and-reserve with no `await` between them: nothing else can run on this thread
    // in between, so two concurrent starts for the same workdir cannot both pass the check.
    if (this.isActiveIn(workdir)) throw new WorkdirBusyError(workdir)
    const id = randomUUID().slice(0, 8)
    const a: Active = { abort: new AbortController(), approvals: new Map(), workdir, listeners: new Set() }
    this.active.set(id, a)

    try {
      await mkdir(this.dir, { recursive: true })
      const meta: Meta = { meta: { id, harness: params.config.name, task: params.task, workdir, started: Date.now() } }
      await writeFile(this.file(id), JSON.stringify(meta) + '\n')
    } catch (e) {
      this.active.delete(id)
      throw e
    }

    const approve = (call: ToolCall) => new Promise<boolean>(resolve => {
      a.approvals.set(call.callId, ok => { clearTimeout(a.timer); a.approvals.delete(call.callId); resolve(ok) })
      a.timer = setTimeout(() => this.abort(id), APPROVAL_TIMEOUT_MS)
    })

    void (async () => {
      let seq = 0
      try {
        const onDelta = (d: Delta) => { for (const fn of a.listeners) fn({ type: 'delta', ...d }) }
        for await (const e of runAgent(params, { signal: a.abort.signal, approve, backend, onDelta })) {
          seq = e.seq + 1
          await appendFile(this.file(id), JSON.stringify(e) + '\n')
          for (const fn of a.listeners) fn(e)
        }
      } catch (e) {
        // A throw here (disk full, EMFILE, or anything escaping runAgent) must not become an
        // unhandled rejection that kills the process and every other run. Best-effort record
        // it as a terminal error/done pair; if even that fails, swallow it.
        try {
          const errEvent: HarnessEvent = { seq: seq++, turn: 0, ts: Date.now(), type: 'error', message: (e as Error).message }
          const doneEvent: HarnessEvent = { seq: seq++, turn: 0, ts: Date.now(), type: 'done', reason: 'backend_error', turns: 0, toolCallCount: 0 }
          await appendFile(this.file(id), JSON.stringify(errEvent) + '\n' + JSON.stringify(doneEvent) + '\n')
          for (const fn of a.listeners) { fn(errEvent); fn(doneEvent) }
        } catch { /* nothing more we can do */ }
      } finally {
        clearTimeout(a.timer)
        this.active.delete(id)
      }
    })()
    return id
  }

  /** Tolerates a half-written last line: the CLI appends while we read, and a killed process can leave one. */
  async read(id: string, part = false): Promise<HarnessEvent[]> {
    const text = await readFile(this.file(id) + (part ? '.part' : ''), 'utf8')
    return text.split('\n').filter(Boolean)
      .flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
      .filter(e => !('meta' in e))
  }

  /**
   * Repairs a run file left without a terminal `done` event (process killed mid-run):
   * appends a synthetic `{ reason: 'aborted' }` done and returns it. Returns null if the
   * run is still active or already has a `done` event, so callers can no-op in that case.
   */
  async ensureDone(id: string): Promise<HarnessEvent | null> {
    if (this.isActive(id)) return null
    const events = await this.read(id)
    if (events.some(e => e.type === 'done')) return null
    const last = events[events.length - 1]
    const turns = last?.turn ?? 0
    const toolCallCount = events.filter(e => e.type === 'tool_call').length
    const doneEvent: HarnessEvent = { seq: (last?.seq ?? -1) + 1, turn: turns, ts: Date.now(), type: 'done', reason: 'aborted', turns, toolCallCount }
    await appendFile(this.file(id), JSON.stringify(doneEvent) + '\n')
    return doneEvent
  }

  subscribe(id: string, fn: Listener): () => void {
    const a = this.active.get(id)
    a?.listeners.add(fn)
    return () => a?.listeners.delete(fn)
  }

  isActive(id: string) { return this.active.has(id) }

  approve(id: string, callId: string, ok: boolean): boolean {
    const fn = this.active.get(id)?.approvals.get(callId)
    if (!fn) return false
    fn(ok); return true
  }

  abort(id: string): boolean {
    const a = this.active.get(id)
    if (!a) return false
    for (const fn of a.approvals.values()) fn(false)
    a.abort.abort(); return true
  }

  async list(): Promise<RunSummary[]> {
    await mkdir(this.dir, { recursive: true })
    const out: RunSummary[] = []
    for (const f of await readdir(this.dir)) {
      if (!f.endsWith('.jsonl')) continue
      try {
        const [first, last] = await firstAndLastLine(path.join(this.dir, f))
        if (!first) continue
        const meta = (JSON.parse(first) as Meta).meta
        const lastEv = last !== first ? JSON.parse(last) : null
        const done = lastEv?.type === 'done' ? lastEv : undefined
        out.push({ id: meta.id, harness: meta.harness, task: meta.task, workdir: meta.workdir, started: meta.started, reason: done?.reason, turns: done?.turns, toolCallCount: done?.toolCallCount })
      } catch {
        // Unreadable or malformed run file (e.g. truncated write, stray empty file): skip it
        // rather than failing the whole listing.
        continue
      }
    }
    return out.sort((x, y) => y.started - x.started)
  }

  /** Every *.json in the runs dir that is a v1 bench result; anything else there is somebody's stray file. */
  private async benchFiles(): Promise<{ file: string; result: BenchResult }[]> {
    await mkdir(this.dir, { recursive: true })
    const out: { file: string; result: BenchResult }[] = []
    for (const f of await readdir(this.dir)) {
      if (!f.endsWith('.json') || !safeName(f)) continue
      try {
        const result = JSON.parse(await readFile(path.join(this.dir, f), 'utf8'))
        if (result?.version === 1 && Array.isArray(result.harnesses)) out.push({ file: f, result })
      } catch { continue }
    }
    return out
  }

  async benchList(): Promise<BenchFile[]> {
    const files = (await this.benchFiles()).map(({ file, result }) => ({
      file, date: result.date, complete: result.complete,
      model: result.harnesses[0]?.config.backend.model ?? '',
    }))
    return files.sort((a, b) => (a.date < b.date ? 1 : -1))
  }
}
