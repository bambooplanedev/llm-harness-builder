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

export function analyzeTrace(events: HarnessEvent[]): TraceAnalysis {
  const calls = new Map<string, ToolCall>(of(events, 'tool_call').map(e => [e.call.callId, e.call]))
  const edits: Record<string, PathEdits> = {}
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
  const stubs: Stub[] | 'unknown' = of(events, 'llm_request').length ? [] : 'unknown'
  return { stubs, firstEdit, edits, loopFile, rereads: [], done: d && { reason: d.reason, turns: d.turns } }
}
