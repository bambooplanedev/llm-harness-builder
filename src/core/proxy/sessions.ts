// src/core/proxy/sessions.ts — turns what a recording proxy sees into runs and their events.
// Pure: no sockets, no files, no clock of its own. Every event is read off the wire; nothing is inferred.
import type { HarnessEvent, ToolCall } from '../events.js'
import type { NormalizedResponse } from '../backends/types.js'

/** The meta line of a proxy run; `proxy` marks the file as a transcription, `pid` lets serve tell a live writer from a killed one. */
export type RunMeta = { id: string; harness: string; task: string; workdir: string; started: number; proxy: { upstream: string; pid: number } }
export type SessionDeps = { now: () => number; newId: () => string; harness: string; upstream: string; pid: number }
export type ReplyOutcome = { ok: true; res: NormalizedResponse; latencyMs: number } | { ok: false; message: string; body?: string }

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type Ev = DistributiveOmit<HarnessEvent, 'seq' | 'turn' | 'ts'>

type Run = {
  id: string; key: string
  /** Message count of the run's last request, and when it was last joined: which open run a request continues. */
  len: number; active: number
  seq: number; turn: number; callSeq: number; toolCallCount: number
  /** The calls of the latest turn that got a reply: the agent's next assistant message echoes them in this order. */
  replied?: { turn: number; calls: ToolCall[] }
  resulted: Set<string>
  open: boolean
}

/** Text of an OpenAI message `content`: a string, an array of parts (the text ones count), or null. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(p => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n')
  return ''
}

/** JSON with object keys sorted, so the same message serialized twice compares equal. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

export class Sessions {
  private runs: Run[] = []
  private tick = 0
  constructor(private d: SessionDeps) {}

  private ev(r: Run, turn: number, e: Ev): HarnessEvent {
    return { seq: r.seq++, turn, ts: this.d.now(), ...e } as HarnessEvent
  }

  /**
   * One request: the run it continues, or a new one. A run is keyed by its first system-like message and its
   * first user message; a request joins the most recently joined open run with that key whose last request had
   * no more messages than this one. Call it before any await, so two requests of one run keep their seq order.
   */
  onRequest(payload: object): { run: string; turn: number; meta?: RunMeta; events: HarnessEvent[] } {
    const raw = (payload as { messages?: unknown }).messages
    const msgs: any[] = Array.isArray(raw) ? raw : []
    const sys = msgs.find(m => m?.role === 'system' || m?.role === 'developer')
    const user = msgs.find(m => m?.role === 'user')
    const key = stable([sys ?? null, user ?? null])
    let run = this.runs.filter(r => r.open && r.key === key && r.len <= msgs.length).sort((a, b) => b.active - a.active)[0]
    let meta: RunMeta | undefined
    if (!run) {
      run = { id: this.d.newId(), key, len: 0, active: 0, seq: 0, turn: 0, callSeq: 0, toolCallCount: 0, resulted: new Set(), open: true }
      this.runs.push(run)
      meta = { id: run.id, harness: this.d.harness, task: textOf(user?.content), workdir: '', started: this.d.now(), proxy: { upstream: this.d.upstream, pid: this.d.pid } }
    }
    run.len = msgs.length
    run.active = ++this.tick
    const events = this.results(run, msgs)
    const turn = ++run.turn
    events.push(this.ev(run, turn, { type: 'llm_request', payload }))
    return { run: run.id, turn, meta, events }
  }

  /**
   * tool_result for each tool message after the request's last assistant message. The i-th call that message
   * echoes is the i-th call recorded on the run's latest replied turn, so ids the agent invented (the server
   * sent none) and ids reused across turns both match. A call already resulted is skipped: a retry repeats them.
   */
  private results(run: Run, msgs: any[]): HarnessEvent[] {
    let last = -1
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'assistant') { last = i; break }
    const replied = run.replied
    if (last < 0 || !replied) return []
    const echoed: unknown[] = Array.isArray(msgs[last].tool_calls) ? msgs[last].tool_calls.map((t: any) => t?.id) : []
    const out: HarnessEvent[] = []
    for (const m of msgs.slice(last + 1)) {
      if (m?.role !== 'tool') continue
      const i = echoed.indexOf(m.tool_call_id)
      const call = i < 0 ? undefined : replied.calls[i]
      if (!call || run.resulted.has(call.callId)) continue
      run.resulted.add(call.callId)
      out.push(this.ev(run, replied.turn, { type: 'tool_result', callId: call.callId, name: call.name, output: textOf(m.content) }))
    }
    return out
  }

  /** The reply to the request `onRequest` numbered `turn`: llm_response and one tool_call per entry of its tool_calls, or an error. */
  onReply(runId: string, turn: number, o: ReplyOutcome): HarnessEvent[] {
    const run = this.runs.find(r => r.id === runId)
    if (!run?.open) return []
    if (!o.ok) return [this.ev(run, turn, { type: 'error', message: o.message, ...(o.body !== undefined ? { body: o.body } : {}) })]
    const { res } = o
    const events = [this.ev(run, turn, { type: 'llm_response', raw: res.raw, content: res.content, reasoning: res.reasoning, usage: res.usage, latencyMs: o.latencyMs })]
    // Calls are kept on a reply cut at max tokens (the native loop drops them): they are on the wire.
    const calls: ToolCall[] = res.toolCalls.map(c => ({ callId: `c${++run.callSeq}`, name: c.name, args: c.args, backendId: c.backendId }))
    for (const call of calls) events.push(this.ev(run, turn, { type: 'tool_call', call }))
    run.toolCallCount += calls.length
    run.replied = { turn, calls }
    return events
  }

  /** `done: aborted` for every open run: the recording stopped. The proxy cannot know how the agent's run ended. */
  close(): { run: string; events: HarnessEvent[] }[] {
    return this.runs.filter(r => r.open).map(r => {
      r.open = false
      return { run: r.id, events: [this.ev(r, r.turn, { type: 'done', reason: 'aborted', turns: r.turn, toolCallCount: r.toolCallCount })] }
    })
  }
}
