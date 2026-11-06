// src/core/diff.ts — pure helpers that compare two runs. No fs, no process, no Vue.
import { quitWithoutWork, type HarnessEvent } from './events.js'
import type { HarnessConfig } from './config.js'
import type { BenchRun } from './bench.js'

/** One side of a comparison: the bench row with its verdict, the harness config behind it, its trace. */
export type DiffSide = { name: string; run: BenchRun; config: HarnessConfig; events: HarnessEvent[] }

/** One thing a turn did. `truncated` and `detail` (the call's path or command) are shown but deliberately kept out of `sig`. */
export type Chip = { label: string; bad: boolean; truncated?: boolean; detail?: string }
/** A turn as the diff sees it: what happened (chips, sig) and what it cost (ms, tokens). */
export type Turn = { chips: Chip[]; sig: string; ms: number; tokens: number }

/** Events grouped by turn, in the order the turns appear in the trace. */
export function turnsOf(events: HarnessEvent[]): HarnessEvent[][] {
  // turn 0 is pre-loop setup (mcp servers), not a turn — unless the run *ended* there, in which
  // case it is the only thing the diff has to show: counting it otherwise would shift every
  // later turn on one side of a diff and put the divergence marker in the wrong place.
  const endedAtZero = events.some(e => e.turn === 0 && e.type === 'done')
  const map = new Map<number, HarnessEvent[]>()
  for (const e of events) {
    if (e.turn === 0 && !endedAtZero) continue
    const g = map.get(e.turn)
    if (g) g.push(e); else map.set(e.turn, [e])
  }
  return [...map.values()]
}

/**
 * Compact per-turn signature of a trace: what happened, not what was said.
 * llm_request/llm_response/context_stats/approval_required produce no chip — every turn has them,
 * so they tell two runs apart in no way; the last two contribute the turn's cost instead.
 */
export function skeleton(events: HarnessEvent[]): Turn[] {
  return turnsOf(events).map(group => {
    const chips: Chip[] = []
    const byCall = new Map<string, Chip>() // a tool_result marks the chip its own call made
    let ms = 0, tokens = 0
    for (const e of group) {
      switch (e.type) {
        case 'llm_response': ms = e.latencyMs; break
        case 'context_stats': tokens = e.exactTokens ?? e.estimatedTokens; break
        case 'parse_error': chips.push({ label: 'parse error', bad: true, truncated: false }); break
        case 'error': chips.push({ label: 'error', bad: true, truncated: false }); break
        case 'final_check': chips.push({ label: e.passed ? 'check passed' : 'check failed', bad: !e.passed, truncated: false }); break
        case 'context_reset': chips.push({ label: 'context reset', bad: false, truncated: false }); break
        case 'tool_call': {
          const d = e.call.args.path ?? e.call.args.command
          const chip: Chip = { label: e.call.name, bad: false, truncated: false, ...typeof d === 'string' ? { detail: d.length > 40 ? `${d.slice(0, 39)}…` : d } : {} }
          byCall.set(e.call.callId, chip)
          chips.push(chip)
          break
        }
        case 'tool_result': {
          const chip = byCall.get(e.callId)
          if (chip) { chip.bad ||= e.error ?? false; chip.truncated ||= e.truncated ?? false }
          break
        }
        case 'done': chips.push({ label: `done: ${e.reason}`, bad: e.reason !== 'final' || quitWithoutWork(e), truncated: false }); break
      }
    }
    return { chips, ms, tokens, sig: chips.map(c => `${c.label}${c.bad ? '!' : ''}`).join(' ') }
  })
}

/** Every scalar and array of a config object, as dotted path → JSON text. Arrays stay whole leaves. */
export function leaves(v: unknown, prefix = ''): [string, string][] {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return Object.entries(v).flatMap(([k, x]) => leaves(x, prefix ? `${prefix}.${k}` : k))
  }
  return [[prefix, JSON.stringify(v) ?? 'undefined']]
}

/** A leaf's text; a key missing on one side is the literal 'undefined', which JSON.parse would throw on. */
export const text = (v: string) => (v === 'undefined' ? '' : String(JSON.parse(v)))

const LABELS = ['name', 'description']

/**
 * Leaf-by-leaf difference of two harness configs. `name` and `description` are the harness's labels, not knobs,
 * so they never count as a difference. Order: a's leaves in their own order, then b-only ones.
 */
export function configDiff(a: HarnessConfig, b: HarnessConfig): { path: string; a: string; b: string }[] {
  const rest = new Map(leaves(b))
  const out: { path: string; a: string; b: string }[] = []
  for (const [path, av] of leaves(a)) {
    const bv = rest.get(path) ?? 'undefined'
    rest.delete(path)
    if (!LABELS.includes(path) && bv !== av) out.push({ path, a: av, b: bv })
  }
  for (const [path, bv] of rest) if (!LABELS.includes(path)) out.push({ path, a: 'undefined', b: bv })
  return out
}

/**
 * Which lines only one side has. A set difference, not an LCS: two 2 KB system prompts side by
 * side are not a diff, "only in A: /no_think" is. Blank lines carry nothing and are dropped.
 */
export function lineDiff(a: string, b: string): { onlyA: string[]; onlyB: string[] } {
  const [sa, sb] = [a, b].map(s => new Set(s.split('\n').filter(l => l.trim())))
  return { onlyA: [...sa].filter(l => !sb.has(l)), onlyB: [...sb].filter(l => !sa.has(l)) }
}

/** JSON with object keys sorted, so the same message serialized twice compares equal. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

/** What one recorded request changed against another. `messages` numbers are 1-based among non-system messages. */
export type ReqDiff = {
  system: { added: string[]; removed: string[] }
  tools: { added: string[]; removed: string[]; changed: string[] }
  messages: { appended: number } | { from: number; changed: { n: number; added: string[]; removed: string[] }[]; added: number; removed: number }
  params: { path: string; a: string; b: string }[]
}

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Drop every `cache_control` key, at any depth: it marks cache breakpoints, not content. */
export function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean)
  if (isObj(v)) return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'cache_control').map(([k, x]) => [k, clean(x)]))
  return v
}

/** Text of a string or of a list of parts (text blocks only; used for tool_result content). */
export function plain(c: unknown): string {
  if (typeof c === 'string') return c
  return Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : isObj(p) && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n') : ''
}

/** One content part as one line: text as is, a call as `call <name> <input>`, anything else as `[type]`. */
export function partLine(p: unknown): string {
  if (typeof p === 'string') return p
  if (!isObj(p)) return ''
  if (p.type === 'text' || (p.type === undefined && typeof p.text === 'string')) return String(p.text ?? '')
  if (p.type === 'tool_use') return `call ${p.name ?? ''} ${stable(p.input)}`
  if (p.type === 'tool_result') return plain(p.content)
  return `[${p.type}]`
}

/** The text of one raw message: its content parts, then OpenAI tool_calls, one line each. */
export function messageText(m: Obj): string {
  const lines = Array.isArray(m.content) ? m.content.map(partLine) : typeof m.content === 'string' ? [m.content] : []
  if (Array.isArray(m.tool_calls)) {
    for (const t of m.tool_calls) {
      const f = isObj(t) && isObj(t.function) ? t.function : {}
      lines.push(`call ${f.name ?? ''} ${typeof f.arguments === 'string' ? f.arguments : stable(f.arguments)}`)
    }
  }
  return lines.join('\n')
}

/** Top-level `system`: a string, or blocks whose texts are joined by newlines. */
function systemText(system: unknown): string {
  return typeof system === 'string' ? system : Array.isArray(system) ? system.map(partLine).filter(Boolean).join('\n') : ''
}

/** How many messages at the start are system/developer: requestDiff counts them as system, not as messages. */
export function leadingSystem(msgs: Obj[]): number {
  let lead = 0
  while (lead < msgs.length && (msgs[lead].role === 'system' || msgs[lead].role === 'developer')) lead++
  return lead
}

const toolName = (t: unknown) => (isObj(t) ? (typeof t.name === 'string' ? t.name : isObj(t.function) && typeof t.function.name === 'string' ? t.function.name : undefined) : undefined)

/**
 * What changed between two request bodies. Not via normalizeRequest: that folds system into messages,
 * glues Anthropic system blocks together and splits messages. undefined = a body has no `messages` array.
 */
export function requestDiff(a: unknown, b: unknown): ReqDiff | undefined {
  if (!isObj(a) || !isObj(b) || !Array.isArray(a.messages) || !Array.isArray(b.messages)) return undefined
  const [ca, cb] = [clean(a) as Obj, clean(b) as Obj]
  const read = (body: Obj) => {
    const msgs = (body.messages as unknown[]).filter(isObj)
    const lead = leadingSystem(msgs)
    const system = [systemText(body.system), ...msgs.slice(0, lead).map(messageText)].filter(Boolean).join('\n')
    const rest = msgs.slice(lead).map(m => ({ key: stable([m.role, messageText(m)]), text: messageText(m) }))
    const tools = new Map((Array.isArray(body.tools) ? body.tools : []).map(t => [toolName(t) ?? stable(t), stable(t)]))
    return { system, rest, tools }
  }
  const [ra, rb] = [read(ca), read(cb)]

  const sys = lineDiff(ra.system, rb.system)
  const tools = {
    added: [...rb.tools.keys()].filter(k => !ra.tools.has(k)),
    removed: [...ra.tools.keys()].filter(k => !rb.tools.has(k)),
    changed: [...ra.tools].filter(([k, v]) => rb.tools.has(k) && rb.tools.get(k) !== v).map(([k]) => k),
  }

  let p = 0
  while (p < ra.rest.length && p < rb.rest.length && ra.rest[p].key === rb.rest[p].key) p++
  const messages: ReqDiff['messages'] = p === ra.rest.length
    ? { appended: rb.rest.length - ra.rest.length }
    : {
        from: p + 1,
        changed: Array.from({ length: Math.min(ra.rest.length, rb.rest.length) - p }, (_, j) => p + j)
          .filter(i => ra.rest[i].key !== rb.rest[i].key)
          .map(i => { const d = lineDiff(ra.rest[i].text, rb.rest[i].text); return { n: i + 1, added: d.onlyB, removed: d.onlyA } }),
        added: Math.max(0, rb.rest.length - ra.rest.length),
        removed: Math.max(0, ra.rest.length - rb.rest.length),
      }

  // arrays and objects show as compact JSON; text() would print "[object Object]"
  const show = (v: string) => (v !== 'undefined' && typeof JSON.parse(v) === 'object' && JSON.parse(v) !== null ? v : text(v))
  const own = (body: Obj) => new Map(leaves(Object.fromEntries(Object.entries(body).filter(([k]) => !['messages', 'system', 'tools', 'metadata'].includes(k)))).filter(([k]) => k))
  const [pa, pb] = [own(ca), own(cb)]
  const params = [...new Set([...pa.keys(), ...pb.keys()])].flatMap(path => {
    const [x, y] = [pa.get(path), pb.get(path)]
    return x === y ? [] : [{ path, a: x === undefined ? '(none)' : show(x), b: y === undefined ? '(none)' : show(y) }]
  })

  return { system: { added: sys.onlyB, removed: sys.onlyA }, tools, messages, params }
}

/** True when only messages were appended, or nothing changed at all. */
export function isNoChange(d: ReqDiff): boolean {
  return 'appended' in d.messages && !d.system.added.length && !d.system.removed.length && !d.tools.added.length && !d.tools.removed.length && !d.tools.changed.length && !d.params.length
}
