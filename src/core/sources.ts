// src/core/sources.ts — where each part of a recorded request body came from. Pure, browser-safe.
import { isObj, clean, partLine, messageText, stable, leadingSystem, toolName, requestParams, showParam, skeleton, type Obj, type Chip } from './diff.js'
import type { HarnessEvent } from './events.js'

export type SourceKind = 'you' | 'file' | 'skill' | 'hook' | 'harness' | 'history'
export type Source = { where: string; kind: SourceKind; label: string; chars: number; text: string }

type Part = [kind: SourceKind, label: string, text: string]

const REMINDER = '<system-reminder>'
const REMINDER_END = '</system-reminder>'
const HOOK = 'SessionStart hook additional context:'
const EI = '<EXTREMELY_IMPORTANT>'
const EI_END = '</EXTREMELY_IMPORTANT>'
const SKILL = "**Below is the full content of your '"
const CONTENTS = 'Contents of '

/** Start of the first line that begins with `s`, or -1. */
function lineStart(t: string, s: string): number {
  if (t.startsWith(s)) return 0
  const i = t.indexOf(`\n${s}`)
  return i < 0 ? -1 : i + 1
}

/** `reminder: <first # heading>` from the reminder's own text, or `reminder`. */
function reminderLabel(own: string): string {
  const i = lineStart(own, '# ')
  if (i < 0) return 'reminder'
  const e = own.indexOf('\n', i)
  return `reminder: ${own.slice(i + 2, e < 0 ? undefined : e).trim()}`
}

/** A `<system-reminder>` block: `Contents of <path> (<what>):` lines open file sections that run to the next one or the closing tag. */
function reminder(t: string): Part[] {
  const close = t.lastIndexOf(REMINDER_END)
  const end = close < 0 ? t.length : close
  const cuts: [at: number, name: string][] = []
  for (let i = 0; i < end; ) {
    let nl = t.indexOf('\n', i)
    if (nl < 0 || nl > end) nl = end
    if (t.startsWith(CONTENTS, i) && t.startsWith('):', nl - 2)) {
      const line = t.slice(i + CONTENTS.length, nl)
      const paren = line.indexOf(' (')
      const path = paren < 0 ? '' : line.slice(0, paren)
      const slash = path.lastIndexOf('/'), name = path.slice(slash + 1)
      const parent = slash < 1 ? '' : path.slice(path.lastIndexOf('/', slash - 1) + 1, slash)
      // a dot folder (`.claude`) tells the global CLAUDE.md from the project's and names no person
      if ((path.startsWith('/') || path.startsWith('~')) && name) cuts.push([i, parent.startsWith('.') ? `${parent}/${name}` : name])
    }
    i = nl + 1
  }
  if (!cuts.length) return [['harness', reminderLabel(t), t]]
  const label = reminderLabel(t.slice(0, cuts[0][0]) + '\n' + t.slice(end))
  return [
    ['harness', label, t.slice(0, cuts[0][0])],
    ...cuts.map(([at, name], k): Part => ['file', name, t.slice(at, k + 1 < cuts.length ? cuts[k + 1][0] : end)]),
    ['harness', label, t.slice(end)],
  ]
}

/** What Claude Code appends after the hook output: environment, MCP instructions, the skills list; the rest is the harness's. */
function attachments(t: string): Part[] {
  const marks = ([['# Environment', 'environment'], ['# MCP Server Instructions', 'MCP instructions'], ['The following skills are available', 'skills list']] as const)
    .map(([s, label]) => [lineStart(t, s), label] as const)
    .filter(([at]) => at >= 0)
    .sort((a, b) => a[0] - b[0])
  const out: Part[] = []
  let done = 0
  marks.forEach(([at, label], k) => {
    let end = k + 1 < marks.length ? marks[k + 1][0] : t.length
    if (label === 'skills list') { // the list ends with its last `- ` line; a trailing date line is not part of it
      const last = t.lastIndexOf('\n- ', end - 1)
      if (last > at) { const nl = t.indexOf('\n', last + 1); end = Math.min(end, nl < 0 ? t.length : nl + 1) }
    }
    out.push(['harness', 'reminder', t.slice(done, at)], ['harness', label, t.slice(at, end)])
    done = end
  })
  return [...out, ['harness', 'reminder', t.slice(done)]]
}

/** A SessionStart hook's output: the skill it inlines, the rest of `<EXTREMELY_IMPORTANT>`, then Claude Code's attachments. */
function hook(t: string): Part[] {
  const ei = t.indexOf(EI)
  const end = ei < 0 ? -1 : t.indexOf(EI_END, ei)
  if (end < 0) return [['harness', 'hook', t]]
  const after = end + EI_END.length
  const out: Part[] = [['harness', 'hook', t.slice(0, ei)]]
  const s = t.indexOf(SKILL, ei)
  const q = s < 0 || s > end ? -1 : t.indexOf("'", s + SKILL.length)
  if (q < 0 || q > end) out.push(['hook', 'hook', t.slice(ei, after)])
  else {
    const name = t.slice(s + SKILL.length, q)
    out.push(['hook', 'hook', t.slice(ei, s)], ['skill', name.slice(name.lastIndexOf(':') + 1), t.slice(s, end)], ['hook', 'hook', t.slice(end, after)])
  }
  return [...out, ...attachments(t.slice(after))]
}

/** A text the harness wrapped (a reminder, a hook's output, any other `<tag>`), split by origin; undefined = not wrapped. */
function tagged(t: string): Part[] | undefined {
  if (t.startsWith(REMINDER)) return reminder(t)
  if (t.startsWith(HOOK)) return hook(t)
  if (t.startsWith('# Environment')) return attachments(t)
  if (t.trimStart().startsWith('<')) return [['harness', 'reminder', t]]
}

/**
 * The parts of a request body in order, each with where it sits and whose it is. Messages are numbered as
 * requestDiff numbers them. Anything not recognised for sure stays `harness`. undefined = no `messages` array.
 */
export function requestSources(payload: unknown): Source[] | undefined {
  if (!isObj(payload) || !Array.isArray(payload.messages)) return undefined
  const body = clean(payload) as Obj
  const out: Source[] = []
  const add = (where: string, parts: Part[]) => {
    for (const [kind, label, text] of parts) if (text) out.push({ where, kind, label, chars: text.length, text })
  }

  const msgs = (body.messages as unknown[]).filter(isObj)
  const lead = leadingSystem(msgs)
  const sys = typeof body.system === 'string' ? [body.system] : Array.isArray(body.system) ? body.system : []
  sys.forEach((b, i) => {
    const t = partLine(b)
    add(`system[${i}]`, [['harness', t.startsWith('x-anthropic-billing-header:') ? 'billing header' : 'system prompt', t]])
  })
  msgs.slice(0, lead).flatMap(m => (Array.isArray(m.content) ? m.content : [messageText(m)]))
    .forEach((b, i) => add(`system[${sys.length + i}]`, tagged(partLine(b)) ?? [['harness', 'system prompt', partLine(b)]]))
  if (Array.isArray(body.tools) && body.tools.length) add('tools', [['harness', `${body.tools.length} tools`, stable(body.tools)]])

  const calls = new Map<string, { name: string; skill?: string }>()
  msgs.slice(lead).forEach((m, i) => {
    const where = (j: number) => `#${i + 1} block ${j}`
    const blocks: unknown[] = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [m.content] : []
    let skill = '' // a successful Skill result in this message: Claude Code sends the skill's text as the next non-reminder text block
    const result = (id: unknown, err: boolean): Part => {
      const c = typeof id === 'string' ? calls.get(id) : undefined
      if (c?.name !== 'Skill' || !c.skill || err) return ['history', c ? `result of ${c.name}` : 'history', '']
      skill = c.skill.slice(c.skill.lastIndexOf(':') + 1)
      return ['skill', skill, '']
    }
    if (m.role === 'assistant') {
      blocks.forEach((b, j) => {
        if (isObj(b) && b.type === 'tool_use' && typeof b.id === 'string') calls.set(b.id, { name: String(b.name ?? ''), skill: isObj(b.input) && typeof b.input.skill === 'string' ? b.input.skill : undefined })
        add(where(j), [['history', 'history', partLine(b)]])
      })
      const tc = Array.isArray(m.tool_calls) ? m.tool_calls : []
      tc.forEach((t, k) => {
        const f = isObj(t) && isObj(t.function) ? t.function : {}
        if (isObj(t) && typeof t.id === 'string') calls.set(t.id, { name: String(f.name ?? '') })
        add(where(blocks.length + k), [['history', 'history', messageText({ tool_calls: [t] })]])
      })
      return
    }
    if (m.role === 'tool') {
      const [kind, label] = result(m.tool_call_id, false)
      return add(where(0), [[kind, label, messageText(m)]])
    }
    const hasResult = blocks.some(b => isObj(b) && b.type === 'tool_result')
    blocks.forEach((b, j) => {
      const t = partLine(b)
      if (isObj(b) && b.type === 'tool_result') { const [kind, label] = result(b.tool_use_id, b.is_error === true); return add(where(j), [[kind, label, t]]) }
      const text = typeof b === 'string' || (isObj(b) && (b.type === 'text' || (b.type === undefined && b.text !== undefined)))
      if (!text) return add(where(j), [['history', 'history', t]])
      if (skill && !t.startsWith(REMINDER)) { const name = skill; skill = ''; return add(where(j), [['skill', name, t]]) }
      add(where(j), tagged(t) ?? [m.role !== 'user' ? ['harness', 'system prompt', t] : hasResult ? ['history', 'history', t] : ['you', 'you', t]])
    })
  })
  return out
}

/** line (trimmed, non-empty) → label; a line found in chunks with different labels is left out. */
export function lineLabels(sources: Source[]): Map<string, string> {
  const map = new Map<string, string>()
  const mixed = new Set<string>()
  for (const s of sources) {
    for (const raw of s.text.split('\n')) {
      const l = raw.trim()
      if (!l || mixed.has(l)) continue
      const had = map.get(l)
      if (had === undefined) map.set(l, s.label)
      else if (had !== s.label) { map.delete(l); mixed.add(l) }
    }
  }
  return map
}

export type GroupLine = { line: string; label?: string }
export type GroupDiff = { onlyA: GroupLine[]; onlyB: GroupLine[]; params: { path: string; a: string; b: string }[] }

type RunAcc = { n: number; last: unknown; lines: Map<string, string | undefined>; params?: Map<string, string> }
/**
 * Per run (keyed on its first payload object): the union of its requests' lines so far, and how many payloads it has
 * folded. A new event in a group costs only its own request; memory is the run's distinct lines, not every request's.
 */
const runCache = new WeakMap<object, RunAcc>()

/** Folds one request's lines (label from the request a line first shows up in) and, if it is the first readable one, its params. */
function fold(acc: RunAcc, p: unknown) {
  const s = isObj(p) ? requestSources(p) : undefined
  if (!s) return
  const labels = lineLabels(s)
  const add = (l: string, label?: string) => { if (!acc.lines.has(l)) acc.lines.set(l, label) }
  // the tools chunk is one JSON line; tool names stand for it
  for (const c of s) if (c.where !== 'tools') for (const raw of c.text.split('\n')) { const l = raw.trim(); if (l) add(l, labels.get(l)) }
  for (const t of Array.isArray((p as Obj).tools) ? ((p as Obj).tools as unknown[]) : []) { const n = toolName(t); if (n) add(`tool ${n}`) }
  acc.params ??= requestParams(clean(p) as Obj)
}

/** One run's lines (first appearance first) and its first readable request's params; undefined when no request is readable. */
function runLines(payloads: unknown[]) {
  const key = payloads.find(isObj)
  if (!key) return undefined
  let acc = runCache.get(key)
  // a run only grows; anything else (shorter, a different payload where the last one was) starts over
  if (!acc || acc.n > payloads.length || (acc.n && payloads[acc.n - 1] !== acc.last)) runCache.set(key, (acc = { n: 0, last: undefined, lines: new Map() }))
  for (; acc.n < payloads.length; acc.n++) fold(acc, payloads[acc.n])
  acc.last = payloads[acc.n - 1]
  return acc.params && { lines: acc.lines, params: acc.params }
}

/**
 * What stably differs between two groups of runs. a, b: per run, the payloads of all its llm_request events.
 * A line counts when every run of one group has it and no run of the other; a param when each group agrees on
 * its value and the two values differ. What varies inside a group (dates, billing header) never counts.
 */
export function groupDiff(a: unknown[][], b: unknown[][]): GroupDiff {
  const [la, lb] = [a.map(runLines), b.map(runLines)]
  // a side with nothing readable would report the whole other side
  if (!la.some(r => r) || !lb.some(r => r)) return { onlyA: [], onlyB: [], params: [] }
  const none = { lines: new Map<string, string | undefined>(), params: new Map<string, string>() }
  const [ra, rb] = [la.map(r => r ?? none), lb.map(r => r ?? none)]
  const only = (side: typeof ra, other: typeof ra): GroupLine[] => [...side[0].lines]
    .filter(([l]) => side.every(r => r.lines.has(l)) && !other.some(r => r.lines.has(l)))
    .map(([line, label]) => (label === undefined ? { line } : { line, label }))
  const agreed = (side: typeof ra, path: string) => {
    const vs = new Set(side.map(r => r.params.get(path)))
    return vs.size === 1 ? { v: [...vs][0] } : undefined
  }
  const params = [...new Set([...ra, ...rb].flatMap(r => [...r.params.keys()]))].flatMap(path => {
    const [x, y] = [agreed(ra, path), agreed(rb, path)]
    return x && y && x.v !== y.v ? [{ path, a: showParam(x.v), b: showParam(y.v) }] : []
  })
  return { onlyA: only(ra, rb), onlyB: only(rb, ra), params }
}

export type RunView = { chips: Chip[]; result: string; reasoning: string; empty: boolean }

/** A run's answer side: its calls in order, its last answer, the reasoning it recorded. */
export function runSummary(events: HarnessEvent[]): RunView {
  const res = events.flatMap(e => (e.type === 'llm_response' ? [e] : []))
  return {
    chips: skeleton(events).flatMap(t => t.chips),
    result: res.at(-1)?.content ?? '',
    reasoning: res.flatMap(r => (r.reasoning ? [r.reasoning] : [])).join('\n\n'),
    empty: !res.length || !events.some(e => e.type === 'llm_request'),
  }
}
