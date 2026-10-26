// The numbers behind `evolve`: which tasks train, gate and test, the sign test, the gate a candidate has to pass,
// the one edit a candidate is, its checks, and what the proposer sees and answers.
// Pure — no fs, no process — so every rule is a function of runs and can be tested without a model.
import { createHash } from 'node:crypto'
import type { RepoTask } from './repo-tasks.js'
import { TOOL_NAMES, validateConfig } from './config.js'
import { analyzeTrace } from './analyze.js'
import { jsonCandidates } from './parse.js'
import type { HarnessEvent } from './events.js'
import type { ChatRequest } from './backends/types.js'

export const ROUNDS = 3
export const CANDIDATES = 2
export const TOLERANCE = 0.10
export const CEILING = 0.25
export const MIN_TRAIN_GATE = 16
export const MIN_TEST = 8
export const ALPHA = 0.05
export const PARA_MAX = 600

export type SetName = 'train' | 'gate' | 'test'

/** A task's own `set` wins; the rest go by the first byte of sha1(name), so adding a task never moves another. */
export function splitSets(tasks: RepoTask[]): Record<SetName, string[]> {
  const out: Record<SetName, string[]> = { train: [], gate: [], test: [] }
  for (const t of tasks) {
    const b = createHash('sha1').update(t.name).digest()[0]! % 4
    out[t.set ?? (b < 2 ? 'train' : b === 2 ? 'gate' : 'test')].push(t.name)
  }
  return out
}

export type Mode = { strict: boolean; trainGate: number; test: number }

export function modeOf(sets: Record<SetName, string[]>): Mode | string {
  const [t, g, x] = [sets.train.length, sets.gate.length, sets.test.length]
  if (!t || !g || !x) return `evolve needs at least one task in each of train, gate and test (have ${t}/${g}/${x})`
  return { strict: t + g >= MIN_TRAIN_GATE && x >= MIN_TEST, trainGate: t + g, test: x }
}

/** The label a reference-mode result carries: too few tasks to tell a gain from luck. */
export const referenceLabel = (m: Mode): string =>
  `ОРІЄНТИР, НЕ ДОКАЗ — too few tasks (${m.trainGate + m.test} of ${MIN_TRAIN_GATE + MIN_TEST}) for a statistical conclusion; add ${Math.max(0, MIN_TRAIN_GATE - m.trainGate) + Math.max(0, MIN_TEST - m.test)} more tasks`

/** One-sided exact sign test: P(X >= b) for X ~ Binomial(b + c, 1/2). */
export function signP(b: number, c: number): number {
  const n = b + c
  let p = 0, term = 1 // C(n, 0)
  for (let k = 0; k <= n; k++) {
    if (k >= b) p += term
    term = term * (n - k) / (k + 1)
  }
  return p / 2 ** n
}

/** Flips in one direction and none back that the strict gate needs. */
export function neededFlips(): number {
  let b = 0
  while (signP(b, 0) >= ALPHA) b++
  return b
}

export type RunLite = { task: string; verdict: 'PASS' | 'FAIL'; tokens?: number; firstPromptTokens?: number; trace?: string; reason?: string; lastError?: string }
export type Numbers = { pass: number; tokensPerSuccess?: number; tokens?: number; weight?: number }

const sum = (runs: RunLite[], k: 'tokens' | 'firstPromptTokens'): number | undefined =>
  runs.every(r => r[k] !== undefined) ? runs.reduce((a, r) => a + r[k]!, 0) : undefined

export function numbersOf(runs: RunLite[]): Numbers {
  const pass = runs.filter(r => r.verdict === 'PASS').length
  const tokens = sum(runs, 'tokens')
  const n: Numbers = { pass }
  if (tokens !== undefined) { n.tokens = tokens; if (pass) n.tokensPerSuccess = tokens / pass }
  const weight = sum(runs, 'firstPromptTokens')
  if (weight !== undefined) n.weight = weight
  return n
}

const pct = (ratio: number) => Math.round((ratio - 1) * 100)

/** cur = the current version's runs, cand = the candidate's, orig = the original's, all on train + gate. */
export function decide(cur: RunLite[], cand: RunLite[], orig: RunLite[], gateNames: string[], mode: Mode): { accepted: boolean; reason: string; numbers: Numbers } {
  const numbers = numbersOf(cand)
  const no = (reason: string) => ({ accepted: false, reason, numbers })
  const o = numbersOf(orig)
  const usage = (rs: RunLite[]) => rs.every(r => r.tokens !== undefined && r.firstPromptTokens !== undefined)
  if (!usage(cand) || !usage(orig)) return no('the server gave no usage')
  if (!numbers.pass) return no('0 PASS')
  const c = numbersOf(cur)
  if (mode.strict) {
    const was = new Map(cur.map(r => [r.task, r.verdict]))
    let b = 0, w = 0
    for (const r of cand) {
      const v = was.get(r.task)
      if (v === 'FAIL' && r.verdict === 'PASS') b++
      else if (v === 'PASS' && r.verdict === 'FAIL') w++
    }
    const p = signP(b, w)
    if (!(p < ALPHA)) return no(`within noise (p=${p.toFixed(2)})`)
  } else if (numbers.pass <= c.pass) return no('fewer PASS than current')
  const gate = (rs: RunLite[]) => numbersOf(rs.filter(r => gateNames.includes(r.task))).pass
  if (gate(cand) < gate(cur)) return no('worse on gate')
  if (o.pass) {
    const r = numbers.tokensPerSuccess! / o.tokensPerSuccess!
    if (r > 1 + TOLERANCE) return no(`costs ${pct(r)}% more tokens per success than the original`)
  } else {
    const r = numbers.tokens! / o.tokens!
    if (r > 1 + TOLERANCE) return no(`costs ${pct(r)}% more tokens than the original`)
  }
  const wr = numbers.weight! / o.weight!
  if (wr > 1 + CEILING) return no(`first request ${pct(wr)}% heavier than the original`)
  return { accepted: true, reason: 'accepted', numbers }
}

/** The only leaves an edit may touch: knobs whose effect is general. Commands (untilBash), tools, the backend and
 *  notes stay the user's. */
export const ALLOWED = ['systemPrompt', 'loop.maxRepeats', 'loop.freshContext', 'loop.repeatTemperature', 'loop.repeatThinkTokens', 'context.maxToolOutputChars', 'context.budgetTokens']

export type Edit = { field: string; value: string | number; why?: string }

/** A new config with the edit at its leaf: a paragraph is appended, a number set; `loop`/`context` made only when missing. */
export function applyEdit(cfg: object, e: Edit): object {
  const c = structuredClone(cfg) as any
  if (e.field === 'systemPrompt') { c.systemPrompt = String(c.systemPrompt ?? '').trimEnd() + '\n\n' + e.value; return c }
  const [sec, key] = e.field.split('.')
  c[sec] = c[sec] && typeof c[sec] === 'object' ? c[sec] : {}
  c[sec][key] = e.value
  return c
}

/** Words that would tie a paragraph to this repo's tasks rather than to how to work: names, files, identifiers. */
export function bindingTokens(t: { names: string[]; paths: string[]; prompts: string[] }): string[] {
  const ids = t.prompts.flatMap(p => p.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter(w => /_|\d|[a-z][A-Z]/.test(w))
  const all = [...t.names, ...t.paths, ...t.paths.map(p => p.slice(p.lastIndexOf('/') + 1)), ...ids].map(w => w.toLowerCase())
  return [...new Set(all.filter(w => w.length >= 6))]
}

const DANGER = [/[a-z][a-z0-9+.-]*:\/\//i, /\bwww\./i, /\b[a-z0-9-]+\.(?:com|net|org|io|dev|sh|app|ai|xyz|ru|cn)\b/i, /(?:^|\s)[\/~]/i, /`/, /\$\(/, /\|\s*(?:ba|z)?sh\b/i, /\b(?:curl|wget|nc|ssh|scp)\b/i]

/** Every leaf of a JSON value by dotted path; empty objects and arrays have none. */
function leaves(x: unknown, at = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (x !== null && typeof x === 'object') for (const [k, v] of Object.entries(x)) leaves(v, at ? `${at}.${k}` : k, out)
  else out.set(at, x)
  return out
}
const diffPaths = (a: unknown, b: unknown): string[] => {
  const la = leaves(a), lb = leaves(b)
  return [...new Set([...la.keys(), ...lb.keys()])].filter(k => !Object.is(la.get(k), lb.get(k)))
}

/** Why an edit is refused before any run, in the order of the checks; undefined = it may run. */
export function checkEdit(e: Edit, ctx: { current: object; original: object; tried: Edit[]; binding: string[] }): string | undefined {
  if (!ALLOWED.includes(e.field)) return 'field not allowed'
  const v = e.value
  if (e.field === 'systemPrompt') {
    if (typeof v !== 'string' || !v.trim() || v.length > PARA_MAX) return 'bad value'
    if (DANGER.some(re => re.test(v))) return 'looks like a command or an address'
    const low = v.toLowerCase()
    if (ctx.binding.some(t => low.includes(t))) return 'tied to a task'
  } else if (typeof v !== 'number' || !Number.isFinite(v)) return 'bad value'
  if (ctx.tried.some(t => t.field === e.field && t.value === v)) return 'already tried'
  const cand = applyEdit(ctx.current, e)
  const errs = validateConfig(cand)
  if (errs.length) return `invalid config: ${errs[0]}`
  // The second compare catches a current that was changed outside ALLOWED before this edit (a hand-edited journal).
  if (diffPaths(cand, ctx.current).some(p => p !== e.field) || diffPaths(cand, ctx.original).some(p => !ALLOWED.includes(p))) return 'changes more than one field'
  return undefined
}

export type Group = { signature: string; count: number; calls: Record<string, number>; exts: Record<string, number> }

const CHECK_CLASS: [string, string][] = [['check exited', 'check_failed'], ['check timed out', 'check_timeout'], ['the check found 0 tests', 'no_tests'], ['changed a protected file', 'protected']]
const bump = (r: Record<string, number>, k: string) => { r[k] = (r[k] ?? 0) + 1 }

/** FAIL runs grouped by how they failed, biggest first. Only fixed words and counts: no path, name, argument or output
 *  of the repo reaches the proposer — a tool name or extension that is not one of ours is `unknown` / `other`. */
export function failureGroups(items: { run: RunLite; events: HarnessEvent[] }[]): Group[] {
  const groups = new Map<string, Group>()
  for (const { run, events } of items) {
    if (run.verdict !== 'FAIL') continue
    const a = analyzeTrace(events)
    // The reason comes from a journal on resume: one that is not a plain word is not trusted as one.
    const reason = run.reason === undefined ? '-' : /^[a-z_]{1,32}$/.test(run.reason) ? run.reason : 'other'
    const check = run.lastError === undefined ? '-' : CHECK_CLASS.find(([p]) => run.lastError!.startsWith(p))?.[1] ?? 'other'
    const kinds: Record<string, number> = {}
    for (const pe of Object.values(a.edits)) for (const [k, n] of Object.entries(pe.byKind)) kinds[k] = (kinds[k] ?? 0) + n!
    const top = Object.entries(kinds).sort((x, y) => y[1] - x[1])[0]?.[0] ?? '-'
    const truncated = events.some(e => e.type === 'tool_result' && e.truncated) ? 'truncated' : '-'
    const signature = `${reason}|${check}|${top}|${truncated}`
    const g = groups.get(signature) ?? { signature, count: 0, calls: {}, exts: {} }
    g.count++
    for (const e of events) if (e.type === 'tool_call') bump(g.calls, (TOOL_NAMES as string[]).includes(e.call.name) ? e.call.name : 'unknown')
    for (const p of Object.keys(a.edits)) bump(g.exts, /\.([a-z0-9]{1,8})$/.exec(p)?.[1] ?? 'other')
    groups.set(signature, g)
  }
  return [...groups.values()].sort((x, y) => y.count - x.count)
}

export type Rejected = { field: string; value?: string | number; reason: string }

export const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: { field: { type: 'string', enum: ALLOWED }, value: { anyOf: [{ type: 'string' }, { type: 'number' }] }, why: { type: 'string', maxLength: 300 } },
  required: ['field', 'value'], additionalProperties: false,
}

/** What the proposer is told, as JSON text: the allowed values now, how the train runs failed, what was refused.
 *  A `tied to a task` value is left out — it holds the very name the check found. */
export function proposerInput(current: object, groups: Group[], rejected: Rejected[], clean: (s: string) => string): string {
  const now: Record<string, string | number> = {}
  const leaf = leaves(current)
  for (const f of ALLOWED) {
    const v = leaf.get(f)
    if (f === 'systemPrompt' && typeof v === 'string') now[f] = clean(v)
    else if (typeof v === 'number') now[f] = v
  }
  const cut = (v: string | number) => typeof v === 'string' ? clean(v).slice(0, 200) : v
  return JSON.stringify({
    current: now,
    failures: groups,
    rejected: rejected.map(r => ({ field: r.field.slice(0, 200), ...(r.value === undefined || r.reason === 'tied to a task' ? {} : { value: cut(r.value) }), reason: r.reason })),
  })
}

const PROPOSER_SYSTEM = `You improve the harness of a coding agent. The input lists the harness's current settings, groups of failed runs (how each ended, which tools it called, which file types it edited) and edits already refused. Propose exactly one edit, as JSON {"field": ..., "value": ..., "why": ...}. field is one of: ${ALLOWED.join(', ')}. For systemPrompt, value is one short paragraph (at most ${PARA_MAX} characters) appended to the prompt: general advice on how to work on such tasks, never about one task, file or name, and no commands, paths or addresses. For any other field, value is a number. Do not propose an edit that was refused.`

export function proposerRequest(model: string, input: string, o: { schema: boolean; noThink: boolean }): ChatRequest {
  return {
    model,
    messages: [{ role: 'system', content: o.noThink ? PROPOSER_SYSTEM + '\n/no_think' : PROPOSER_SYSTEM }, { role: 'user', content: input }],
    ...(o.schema ? { responseSchema: PROPOSAL_SCHEMA } : {}),
  }
}

/** The edit in a proposer reply — bare, fenced, after a <think> block or in prose, as the notes writer reads one. */
export function parseProposal(content: string): Edit {
  for (const x of jsonCandidates(content) as any[])
    if (typeof x?.field === 'string' && (typeof x.value === 'string' || typeof x.value === 'number'))
      return { field: x.field, value: x.value, ...(typeof x.why === 'string' ? { why: x.why.slice(0, 300) } : {}) }
  throw new Error('no edit in the reply')
}
