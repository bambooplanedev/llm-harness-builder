// src/core/proxy/sessions.ts — turns what a recording proxy sees into runs and their events.
// Pure: no sockets, no files, no clock of its own. Every event is read off the wire; nothing is inferred.
import type { Ev, HarnessEvent, ToolCall } from '../events.js'
import type { NormalizedResponse } from '../backends/types.js'

/** The meta line of a proxy run; `proxy` marks the file as a transcription, `pid` lets serve tell a live writer from a killed one. */
export type RunMeta = {
  id: string; harness: string; task: string; workdir: string; started: number; proxy: { upstream: string; pid: number }
  session?: string; agent?: string; parent?: string; agentType?: string
}
/** What Claude Code's x-claude-code-* headers say about a request; never the headers themselves. */
export type ProxyHints = { session?: string; agent?: string; parent?: string; agentType?: string; requestClass?: string }

export type SessionDeps = { now: () => number; newId: () => string; harness: string; upstream: string; pid: number }
export type ReplyOutcome = { ok: true; res: NormalizedResponse; latencyMs: number } | { ok: false; message: string; body?: string }

type Run = {
  id: string; key: string
  /** Message count of the run's last request, and when it was last joined: which open run a request continues. */
  len: number; active: number
  seq: number; turn: number; callSeq: number; toolCallCount: number
  /** The calls of the latest turn that got a reply: the agent's next assistant message echoes them in this order. */
  replied?: { turn: number; calls: ToolCall[] }
  resulted: Set<string>
  open: boolean
  /** A main run an auxiliary request opened before any turn: its meta (task '') and notes wait for the first turn. */
  pending?: { meta: RunMeta; notes: { ts: number; e: Ev }[] }
}

const HINTS = { session: 'x-claude-code-session-id', agent: 'x-claude-code-agent-id', parent: 'x-claude-code-parent-agent-id', agentType: 'x-claude-code-agent-type', requestClass: 'x-claude-code-request-class' } as const

/** The hint headers only; a value counts if it is one string of 1..128 printable ASCII characters, else that hint is absent. */
export function hintsOf(h: Record<string, string | string[] | undefined>): ProxyHints {
  const out: ProxyHints = {}
  for (const [k, name] of Object.entries(HINTS) as [keyof ProxyHints, string][]) {
    const v = h[name]
    if (typeof v === 'string' && /^[\x21-\x7e]{1,128}$/.test(v)) out[k] = v
  }
  return out
}

/** Text of an OpenAI message `content`: a string, an array of parts (the text ones count), or null. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(p => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n')
  return ''
}

/** The task as the agent typed it: Claude Code wraps context into the first user message as system-reminders; an unclosed one runs to the end. */
export function taskOf(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g, '').trim()
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
   * `api` comes from the route the request took. Anthropic: the key is text only, the top-level system without its first block (Claude Code's attribution
   * block changes) and the first user text, since Claude Code moves cache_control markers between turns.
   * With a session hint (Claude Code's headers) the key is the session and the agent, with no length rule: a compaction
   * rewrites the history. An auxiliary request (a title, a summary) gets no turn: it is a note in the session's main run,
   * written by onReply with the `side` returned here. Before the session's first main request those notes wait: the main
   * run's meta (with the real task) and the notes come with that request. A compaction is a turn of its agent's run, marked by a note.
   */
  onRequest(payload: object, api: 'openai' | 'anthropic' = 'openai', hints: ProxyHints = {}): { run: string; turn: number; meta?: RunMeta; events: HarnessEvent[]; side?: { model: string } } {
    const raw = (payload as { messages?: unknown }).messages
    const msgs: any[] = Array.isArray(raw) ? raw : []
    const anthropic = api === 'anthropic'
    const user = msgs.find(m => m?.role === 'user')
    let key: string, task: string
    if (anthropic) {
      const system = (payload as { system?: unknown }).system
      const userText = textOf(Array.isArray(user?.content) ? user.content.filter((b: any) => b?.type === 'text') : user?.content)
      key = stable([Array.isArray(system) ? textOf(system.slice(1)) : textOf(system), userText])
      task = taskOf(userText)
    } else {
      const sys = msgs.find(m => m?.role === 'system' || m?.role === 'developer')
      key = stable([sys ?? null, user ?? null])
      task = taskOf(textOf(user?.content))
    }
    const aux = hints.session !== undefined && hints.requestClass === 'auxiliary'
    const agent = aux ? 'main' : hints.agent ?? 'main'
    if (hints.session !== undefined) key = `cc\0${hints.session}\0${agent}`
    let run = this.runs.filter(r => r.open && r.key === key && (hints.session !== undefined || r.len <= msgs.length)).sort((a, b) => b.active - a.active)[0]
    let meta: RunMeta | undefined
    const metaOf = (id: string): RunMeta => {
      const m: RunMeta = { id, harness: this.d.harness, task: aux ? '' : task, workdir: '', started: this.d.now(), proxy: { upstream: this.d.upstream, pid: this.d.pid } }
      if (hints.session !== undefined) {
        m.session = hints.session; m.agent = agent
        const parent = hints.parent ?? (hints.agent !== undefined ? 'main' : undefined)
        if (!aux && parent !== undefined) m.parent = parent
        if (!aux && hints.agentType !== undefined) m.agentType = hints.agentType
      }
      return m
    }
    if (!run) {
      run = { id: this.d.newId(), key, len: 0, active: 0, seq: 0, turn: 0, callSeq: 0, toolCallCount: 0, resulted: new Set(), open: true }
      this.runs.push(run)
      if (aux) run.pending = { meta: metaOf(run.id), notes: [] }
      else meta = metaOf(run.id)
    }
    if (aux) return { run: run.id, turn: run.turn, events: [], side: { model: String((payload as { model?: unknown }).model ?? '') } }
    const events: HarnessEvent[] = []
    if (run.pending) {
      meta = metaOf(run.id)
      events.push(...this.flush(run))
    }
    run.len = msgs.length
    run.active = ++this.tick
    events.push(...this.results(run, msgs, anthropic))
    const turn = ++run.turn
    if (hints.requestClass === 'compaction') events.push(this.ev(run, turn, { type: 'proxy_note', kind: 'compaction' }))
    events.push(this.ev(run, turn, { type: 'llm_request', payload }))
    return { run: run.id, turn, meta, events }
  }

  /** The waiting notes of a pending run, at its start, in the order they came; the run is pending no more. */
  private flush(r: Run): HarnessEvent[] {
    const notes = r.pending?.notes ?? []
    r.pending = undefined
    return notes.map(({ ts, e }) => ({ seq: r.seq++, turn: 0, ...e, ts }) as HarnessEvent)
  }

  /**
   * tool_result for each tool message after the request's last assistant message. The i-th call that message
   * echoes is the i-th call recorded on the run's latest replied turn, so ids the agent invented (the server
   * sent none) and ids reused across turns both match. A call already resulted is skipped: a retry repeats them.
   * Anthropic: the tool_result blocks of the user messages after it, matched to the replied calls by tool_use_id.
   */
  private results(run: Run, msgs: any[], anthropic: boolean): HarnessEvent[] {
    let last = -1
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'assistant') { last = i; break }
    const replied = run.replied
    if (last < 0 || !replied) return []
    const out: HarnessEvent[] = []
    if (anthropic) {
      for (const m of msgs.slice(last + 1)) {
        if (m?.role !== 'user' || !Array.isArray(m.content)) continue
        for (const b of m.content) {
          const call = b?.type === 'tool_result' && b.tool_use_id !== undefined ? replied.calls.find(c => c.backendId === b.tool_use_id) : undefined
          if (!call || run.resulted.has(call.callId)) continue
          run.resulted.add(call.callId)
          out.push(this.ev(run, replied.turn, { type: 'tool_result', callId: call.callId, name: call.name, output: textOf(b.content), ...(b.is_error === true ? { error: true } : {}) }))
        }
      }
      return out
    }
    const echoed: unknown[] = Array.isArray(msgs[last].tool_calls) ? msgs[last].tool_calls.map((t: any) => t?.id) : []
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

  /**
   * The reply to the request `onRequest` numbered `turn`: llm_response and one tool_call per entry of its tool_calls, or an error.
   * With `side` (an auxiliary request): one note at the run's current turn, success or failure; the run's calls stay as they were.
   */
  onReply(runId: string, turn: number, o: ReplyOutcome, side?: { model: string }): HarnessEvent[] {
    const run = this.runs.find(r => r.id === runId)
    if (!run?.open) return []
    if (side) {
      const e: Ev = o.ok
        ? { type: 'proxy_note', kind: 'auxiliary', model: side.model, ...(o.res.usage ? { usage: o.res.usage } : {}), latencyMs: o.latencyMs }
        : { type: 'proxy_note', kind: 'auxiliary', model: side.model, error: o.message }
      if (run.pending) { run.pending.notes.push({ ts: this.d.now(), e }); return [] }
      return [this.ev(run, run.turn, e)]
    }
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

  /**
   * `done: proxy_stopped` for every open run: the recording stopped. The proxy cannot know how the agent's run ended.
   * A main run whose session sent only auxiliary requests is written now, task '', with its notes.
   */
  close(): { run: string; meta?: RunMeta; events: HarnessEvent[] }[] {
    return this.runs.filter(r => r.open).map(r => {
      r.open = false
      const meta = r.pending?.meta
      const events = this.flush(r)
      events.push(this.ev(r, r.turn, { type: 'done', reason: 'proxy_stopped', turns: r.turn, toolCallCount: r.toolCallCount }))
      return { run: r.id, ...(meta ? { meta } : {}), events }
    })
  }
}
