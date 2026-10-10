import type { HarnessEvent, DoneReason, ToolCall } from './events.js'
import { EDIT_MISS, GUARD_BLOCKED, EDIT_IDENTICAL } from './tools/errors.js'

/**
 * What a trace says about the budget and the edits, rebuilt after the fact: the trace records what
 * was sent each turn, not what a stub removed. Pure and browser-safe — the CLI, the server and the
 * trace view call it alike. Knows nothing about any task.
 */
export type EditKind = 'identical' | 'zero' | 'many' | 'notRead' | 'other'
export type PathEdits = { calls: number; failed: number; byKind: Partial<Record<EditKind, number>> }
export type StubItem = { callId?: string; what: string }
export type Stub = { turn: number; chars: number; status: 'matched' | 'unmatched'; items: StubItem[] }
export type TraceAnalysis = {
  /** 'unknown': the trace has no recorded request to rebuild them from. */
  stubs: Stub[] | 'unknown'
  /** Turn of the first edit_file/write_file that succeeded. */
  firstEdit?: number
  edits: Record<string, PathEdits>
  /** The path with the most failed edits, when it has at least two. */
  loopFile?: string
  /** The first read_file of a path at or after the turn a stub removed its earlier read. */
  rereads: { path: string; turn: number }[]
  done?: { reason: DoneReason; turns: number }
}

/** Built-in names only, the same boundary loop.maxRepeats has. */
const EDIT_TOOLS = new Set(['edit_file', 'write_file'])

export const normPath = (p: unknown): string => typeof p === 'string' ? p.replace(/^(\.\/)+/, '') : '?'

export function editKind(output: string): EditKind {
  if (output.includes(GUARD_BLOCKED)) return 'notRead'
  if (output.includes(EDIT_IDENTICAL)) return 'identical'
  const m = output.includes(EDIT_MISS) ? /found (\d+) occurrences/.exec(output) : null
  if (m) return m[1] === '0' ? 'zero' : 'many'
  return 'other'
}

/** "read_file src/a.js", "bash node --test": the call's path or command, cut at 60 characters. */
export function describeCall(name: string, args: Record<string, unknown>): string {
  const a = args.path ?? args.command
  return typeof a === 'string' ? `${name} ${a.length > 60 ? a.slice(0, 57) + '...' : a}` : name
}

type Ev<T extends HarnessEvent['type']> = Extract<HarnessEvent, { type: T }>
const of = <T extends HarnessEvent['type']>(events: HarnessEvent[], type: T) => events.filter(e => e.type === type) as Ev<T>[]

const DROPPED = /^\[dropped: (\d+) chars\]$/

/** The message contents of a recorded request, or undefined when the payload has none. Non-string content (a proxy-recorded agent may send parts) reads as ''. */
function contentsOf(payload: unknown): string[] | undefined {
  const m = (payload as { messages?: { content?: unknown }[] } | undefined)?.messages
  return Array.isArray(m) ? m.map(x => typeof x?.content === 'string' ? x.content : '') : undefined
}

/**
 * Compares each recorded request with the previous one, index by index: history only grows between
 * stubs, so a message that was whole and is now `[dropped: K chars]` is a stub. Results of turn T are
 * first sent in the request of turn T+1, which ties the message to its turn's tool results; their
 * outputs must be inside the old content. A length or total that does not add up is `unmatched`.
 */
function rebuildStubs(events: HarnessEvent[], calls: Map<string, ToolCall>): Stub[] | 'unknown' {
  const reqs = of(events, 'llm_request').flatMap(e => { const c = contentsOf(e.payload); return c ? [{ turn: e.turn, c }] : [] })
  if (!reqs.length) return 'unknown'
  const results = events.filter((e): e is Ev<'tool_result'> | Ev<'final_check'> => e.type === 'tool_result' || e.type === 'final_check')
  const dropped = new Map(of(events, 'context_stats').map(e => [e.turn, e.droppedChars]))
  const stubs: Stub[] = []
  const credited = new Set<Ev<'tool_result'> | Ev<'final_check'>>()
  let prev: string[] = [], firstSeen: number[] = []
  for (const r of reqs) {
    const seen: number[] = [], turnStubs: Stub[] = []
    r.c.forEach((c, i) => {
      const was = prev[i], m = DROPPED.exec(c)
      if (m && was !== undefined && !DROPPED.test(was)) {
        seen[i] = firstSeen[i]
        const chars = Number(m[1])
        if (was.length !== chars) { turnStubs.push({ turn: r.turn, chars, status: 'unmatched', items: [] }); return }
        // A result goes to one stub only. A native tool message is exactly one output, so an exact
        // match is that message; only a prompted message, which wraps a whole turn, is matched by containment.
        const open = results.filter(e => e.turn === firstSeen[i] - 1 && !credited.has(e))
        const exact = open.find(e => e.output === was)
        const hit = exact ? [exact] : open.filter(e => e.output !== '' && was.includes(e.output))
        for (const e of hit) credited.add(e)
        const items = hit.map(e => e.type === 'final_check' ? { what: 'final check' }
          : { callId: e.callId, what: describeCall(e.name, calls.get(e.callId)?.args ?? {}) })
        turnStubs.push({ turn: r.turn, chars, status: items.length ? 'matched' : 'unmatched', items })
      } else seen[i] = was === c ? firstSeen[i] : r.turn
    })
    const sum = turnStubs.reduce((n, s) => n + s.chars, 0), stat = dropped.get(r.turn)
    if (turnStubs.length && stat !== undefined && stat !== sum) for (const s of turnStubs) { s.status = 'unmatched'; s.items = [] }
    // The run says it dropped something and no `[dropped: K chars]` shows it: a stub in a text this
    // code does not write (the labelled stub of v2.10). Reported as a stub, tied to nothing.
    if (!turnStubs.length && stat) turnStubs.push({ turn: r.turn, chars: stat, status: 'unmatched', items: [] })
    stubs.push(...turnStubs)
    prev = r.c; firstSeen = seen
  }
  return stubs
}

function rebuildRereads(events: HarnessEvent[], stubs: Stub[], calls: Map<string, ToolCall>): { path: string; turn: number }[] {
  const stubbedAt = new Map<string, number>()
  for (const s of stubs) for (const it of s.items) {
    const c = it.callId ? calls.get(it.callId) : undefined
    if (c?.name === 'read_file') { const p = normPath(c.args.path); if (!stubbedAt.has(p)) stubbedAt.set(p, s.turn) }
  }
  const out: { path: string; turn: number }[] = []
  for (const e of of(events, 'tool_call')) {
    if (e.call.name !== 'read_file') continue
    const p = normPath(e.call.args.path), at = stubbedAt.get(p)
    if (at !== undefined && e.turn >= at && !out.some(o => o.path === p)) out.push({ path: p, turn: e.turn })
  }
  return out
}

export function analyzeTrace(events: HarnessEvent[]): TraceAnalysis {
  const calls = new Map<string, ToolCall>(of(events, 'tool_call').map(e => [e.call.callId, e.call]))
  // Keys are model-chosen paths: "constructor" or "__proto__" must be plain keys here.
  const edits: Record<string, PathEdits> = Object.create(null)
  let firstEdit: number | undefined
  for (const r of of(events, 'tool_result')) {
    if (!EDIT_TOOLS.has(r.name)) continue
    const p = normPath(calls.get(r.callId)?.args.path)
    const pe = edits[p] ??= { calls: 0, failed: 0, byKind: {} }
    pe.calls++
    if (r.error) { pe.failed++; const k = editKind(r.output); pe.byKind[k] = (pe.byKind[k] ?? 0) + 1 }
    else if (firstEdit === undefined) firstEdit = r.turn
  }
  let loopFile: string | undefined
  for (const [p, pe] of Object.entries(edits)) if (pe.failed >= 2 && (!loopFile || pe.failed > edits[loopFile].failed)) loopFile = p
  const d = of(events, 'done').at(-1)
  const stubs = rebuildStubs(events, calls)
  const rereads = stubs === 'unknown' ? [] : rebuildRereads(events, stubs, calls)
  return { stubs, firstEdit, edits, loopFile, rereads, done: d && { reason: d.reason, turns: d.turns } }
}

export type AnalysisCells = { stub: string; ate: string; edit: string; loop: string; reread: string }
export type AnalyzedRun = { harness: string; run: string; verdict: string; turns: number; analysis: TraceAnalysis | null }

const t = (n?: number) => n === undefined ? '—' : `t${n}`

/** Everything the first stub turn removed — the low-water mark can take several messages at once —
 *  a name that occurs more than once collapsed: "read_file ×7". */
function ate(turn: Stub[]): string {
  const lost = turn.filter(s => s.status === 'unmatched').reduce((n, s) => n + s.chars, 0)
  const items = turn.flatMap(s => s.items)
  if (!items.length) return `${lost} chars, unmatched`
  const names = new Map<string, string[]>()
  for (const it of items) { const n = it.what.split(' ')[0]; names.set(n, [...(names.get(n) ?? []), it.what]) }
  return [...[...names].map(([n, whats]) => whats.length > 1 ? `${n} ×${whats.length}` : whats[0]), ...(lost ? [`+${lost} chars unmatched`] : [])].join('; ')
}

function loop(a: TraceAnalysis): string {
  if (!a.loopFile) return '—'
  const pe = a.edits[a.loopFile]
  const kinds = Object.entries(pe.byKind).sort((x, y) => y[1]! - x[1]!).map(([k, n]) => `${k} ${n}`).join(', ')
  return `${a.loopFile} ×${pe.calls} (${kinds})`
}

export function analysisCells(a: TraceAnalysis): AnalysisCells {
  const first = a.stubs === 'unknown' ? undefined : a.stubs[0]
  return {
    stub: a.stubs === 'unknown' ? '?' : t(first?.turn),
    ate: first && a.stubs !== 'unknown' ? ate(a.stubs.filter(s => s.turn === first.turn)) : '—',
    edit: t(a.firstEdit),
    loop: loop(a),
    reread: a.rereads.length ? `t${a.rereads[0].turn} ${a.rereads[0].path}${a.rereads.length > 1 ? ` +${a.rereads.length - 1}` : ''}` : '—',
  }
}

/** One line for a Bench-tab run row. */
export const cellsLine = (c: AnalysisCells): string => `stub ${c.stub} · edit ${c.edit} · loop ${c.loop} · reread ${c.reread}`

/** One line above a trace. */
export function summaryLine(a: TraceAnalysis): string {
  const c = analysisCells(a)
  const stub = a.stubs === 'unknown' ? 'stubs unknown (no recorded request)' : c.stub === '—' ? 'no stub' : `first stub ${c.stub} (ate: ${c.ate})`
  return [stub, c.edit === '—' ? 'no edit' : `first edit ${c.edit}`, c.loop === '—' ? 'no loop' : `loop on ${c.loop}`,
    ...(c.reread === '—' ? [] : [`reread ${c.reread}`])].join(' · ')
}

export function formatAnalysisTable(rows: AnalyzedRun[]): string {
  const head = ['harness', 'run', 'verdict', 'turns', 'stub@', 'ate', 'edit@', 'loop on', 'reread']
  const body = rows.map(r => {
    if (!r.analysis) return [r.harness, r.run, r.verdict, String(r.turns), 'no trace', '', '', '', '']
    const c = analysisCells(r.analysis)
    return [r.harness, r.run, r.verdict, String(r.turns), c.stub, c.ate, c.edit, c.loop, c.reread]
  })
  const w = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length)))
  return [head, ...body].map(cols => cols.map((s, i) => s.padEnd(w[i])).join('  ').trimEnd()).join('\n')
}
