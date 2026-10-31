// The numbers behind `evolve`: which tasks train, gate and test, the sign test, the gate a candidate has to pass,
// the one edit a candidate is, its checks, and what the proposer sees and answers.
// Pure — no fs, no process — so every rule is a function of runs and can be tested without a model.
import { createHash } from 'node:crypto'
import type { RepoTask } from './repo-tasks.js'
import { TOOL_NAMES, validateConfig } from './config.js'
import { analyzeTrace, EDIT_KINDS } from './analyze.js'
import { jsonCandidates } from './parse.js'
import type { DoneReason, HarnessEvent } from './events.js'
import type { ChatRequest } from './backends/types.js'
import { ALLOWED, DANGER } from './evolve-labels.js'
import { TOLERANCE, costCheck, costReason, numbersOf, pct, tokensGate, type Numbers } from './evolve-cost.js'
import { permP } from './stats.js'
export { ALLOWED, TOLERANCE, numbersOf, tokensGate, type Numbers }

export const ROUNDS = 3
export const CANDIDATES = 2
export const CEILING = 0.25
export const MIN_TRAIN_GATE = 16
export const MIN_TEST = 8
export const ALPHA = 0.05
export const PARA_MAX = 600
/** Polyglot's size, the sweeps per round and per final test, the rounds; on --tasks the repo sets the size. The start line holds all of it. */
export const MODES = { hours: { size: 24, repeats: 1, rounds: 1 }, night: { size: 47, repeats: 3, rounds: 1 }, days: { size: 47, repeats: 5, rounds: 2 } } as const satisfies Record<string, { size: number; repeats: number; rounds: number }>
/** `custom` is --size or --rounds: one repeat, and never a declared winner. */
export type EvolveMode = keyof typeof MODES | 'custom'

export type SetName = 'train' | 'gate' | 'test'

/** A task's own `set` wins; the rest go by the first byte of sha1(name), so adding a task never moves another. */
export function splitSets(tasks: Pick<RepoTask, 'name' | 'set'>[]): Record<SetName, string[]> {
  const out: Record<SetName, string[]> = { train: [], gate: [], test: [] }
  for (const t of tasks) {
    const b = createHash('sha1').update(t.name).digest()[0]! % 4
    out[t.set ?? (b < 2 ? 'train' : b === 2 ? 'gate' : 'test')].push(t.name)
  }
  return out
}

/** `polyglot`: the tasks are the first N Exercism exercises, and a mode picks how many, not a list of tasks to write. */
export type Split = { declarable: boolean; mode: EvolveMode; trainGate: number; test: number; polyglot?: true }

export function splitOf(sets: Record<SetName, string[]>, polyglot: boolean, mode: EvolveMode): Split | string {
  const [t, g, x] = [sets.train.length, sets.gate.length, sets.test.length]
  if (!t || !g || !x) return `evolve needs at least one task in each of train, gate and test (have ${t}/${g}/${x})`
  return { declarable: (mode === 'night' || mode === 'days') && t + g >= MIN_TRAIN_GATE && x >= MIN_TEST, mode, trainGate: t + g, test: x, ...(polyglot ? { polyglot: true as const } : {}) }
}

/** What a run may cost at most: every sweep has both candidates, and a version is found for the test. */
export function runCount(sets: Record<SetName, string[]>, repeats: number, rounds: number) {
  const probe = sets.train.length
  const sweeps = rounds * repeats * (1 + CANDIDATES) * (sets.train.length + sets.gate.length), test = repeats * 2 * sets.test.length
  return { probe, sweeps, test, all: probe + sweeps + test }
}

/** A mode that can never declare a winner, in the words of the flags that chose it; undefined for night and days. */
export const orientationOnly = (m: EvolveMode): string | undefined => m === 'custom' ? '--size and --rounds are orientation only' : m === 'hours' ? '--mode hours is orientation only' : undefined
export const WINNER_MODES = '--mode night or days declares a winner'
/** Tasks short of a declarable split, train + gate and test; polyglot's come with the mode. */
export const shortOf = (m: Split): [number, number] => m.polyglot ? [0, 0] : [Math.max(0, MIN_TRAIN_GATE - m.trainGate), Math.max(0, MIN_TEST - m.test)]

/** The label an orientation result carries, and why it is one: the mode, too few tasks, or both. */
export const referenceLabel = (m: Split): string => {
  const only = orientationOnly(m.mode), few = m.trainGate < MIN_TRAIN_GATE || m.test < MIN_TEST, [a, b] = shortOf(m)
  const why = [...only ? [only] : [], ...few ? [`too few ${m.polyglot ? 'exercises' : 'tasks'} (${m.trainGate + m.test} of ${MIN_TRAIN_GATE + MIN_TEST}) for a statistical conclusion`] : []]
  const fix = [...a + b ? [`add ${a + b} more tasks`] : [], ...only ? [WINNER_MODES] : []]
  return `\u041e\u0420\u0406\u0404\u041d\u0422\u0418\u0420, \u041d\u0415 \u0414\u041e\u041a\u0410\u0417 — ${[...why, ...fix].join('; ')}`
}

/** JSON with every object's keys sorted: the same value whatever its key order or whitespace in a file. */
export const canonical = (x: unknown): string => JSON.stringify(x, (_, v) => isObj(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v)

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

/** Flips in one direction and none back that the declarable gate needs. */
export function neededFlips(): number {
  let b = 0
  while (signP(b, 0) >= ALPHA) b++
  return b
}

/** turns and modelMs are on every run of a v2 journal (0 when no reply came); costUsd only when the harness is priced; repeat tells repeats of one task apart. */
export type RunLite = { task: string; verdict: 'PASS' | 'FAIL'; tokens?: number; firstPromptTokens?: number; turns?: number; modelMs?: number; costUsd?: number; repeat?: number; trace?: string; reason?: string; lastError?: string; sig?: string }
/** Runs the gates can divide by: token counts on every run, and some of them, and some first request. */
export const usable = (runs: RunLite[]): boolean => { const n = numbersOf(runs); return !!n.tokens && !!n.weight }

const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length
const byTask = <T>(runs: RunLite[], f: (r: RunLite) => T | undefined) => {
  const m = new Map<string, T[]>()
  for (const r of runs) { const v = f(r); if (v !== undefined) m.set(r.task, [...(m.get(r.task) ?? []), v]) }
  return m
}

/** One test for any number of repeats: tasks are the strata, runs inside a task are exchangeable. `improved` = tasks whose pass rate rose. */
export function passGain(cur: RunLite[], cand: RunLite[]): { p: number; improved: number } {
  const a = byTask(cur, r => +(r.verdict === 'PASS')), b = byTask(cand, r => +(r.verdict === 'PASS'))
  const strata = [...b].filter(([t]) => a.has(t)).map(([t, bs]) => ({ a: a.get(t)!, b: bs }))
  return { p: permP(strata, 'greater').p, improved: strata.filter(s => mean(s.b) > mean(s.a)).length }
}

/** The cost gates of `decide` and `verdict`: all tokens, then turns and tokens on shared passes against `orig`, time against `timeBase`. A reason, or undefined when within bounds. */
function costGate(orig: RunLite[], cand: RunLite[], timeBase: RunLite[], origMaxTurns: number): string | undefined {
  const all = tokensGate(orig, cand)
  if (all) return all
  // Under MIN_SHARED tasks with the original, or at 0 PASS in it, a cost says nothing, time against `timeBase` included: the gate above stands alone.
  if (!costCheck(orig, cand, 'turns', origMaxTurns)) return
  for (const [cost, base] of [['turns', orig], ['tokens', orig], ['time', timeBase]] as const) {
    const k = costCheck(base, cand, cost, origMaxTurns)
    if (k?.over) return costReason(k, cost)
  }
}

/** cur = the current version's runs, cand = the candidate's, orig = the original's, all on train + gate; any number of repeats per task. */
export function decide(i: { cur: RunLite[]; cand: RunLite[]; orig: RunLite[]; gateNames: string[]; split: Split; origMaxTurns: number }): { accepted: boolean; reason: string; numbers: Numbers } {
  const { cur, cand, orig, gateNames, split, origMaxTurns } = i
  const numbers = numbersOf(cand)
  const no = (reason: string) => ({ accepted: false, reason, numbers })
  const o = numbersOf(orig)
  // Every ratio below divides by the original's sums: a 0 there would be NaN or Infinity, never a refusal.
  if (!usable(cand) || !usable(orig)) return no('the server gave no usage')
  if (!numbers.pass) return no('0 PASS')
  const c = numbersOf(cur)
  if (split.declarable) {
    const { p, improved } = passGain(cur, cand)
    // The p alone could be one task at 4/4 against 0/4; the flips needed are the sign test's own floor.
    if (!(p < ALPHA && improved >= neededFlips())) return no(`within noise (p=${p.toFixed(2)})`)
  } else if (numbers.pass <= c.pass) return no('no more PASS than current')
  const gate = (rs: RunLite[]) => numbersOf(rs.filter(r => gateNames.includes(r.task))).pass
  if (gate(cand) < gate(cur)) return no('worse on gate')
  const over = costGate(orig, cand, cur, origMaxTurns)
  if (over) return no(over)
  // Paired by task: a prompt too heavy for the window gets no reply, so no first request, and must not leave the sum lighter.
  const ofp = byTask(orig, r => r.firstPromptTokens), cfp = byTask(cand, r => r.firstPromptTokens)
  const unmeasured = new Set(cand.filter(r => !cfp.has(r.task) && ofp.has(r.task)).map(r => r.task)).size
  if (unmeasured) return no(`first request not measured on ${unmeasured} tasks`)
  const both = [...cfp].filter(([t]) => ofp.has(t))
  const ow = both.reduce((a, [t]) => a + mean(ofp.get(t)!), 0)
  if (!ow) return no('the server gave no usage')
  const wr = both.reduce((a, [, v]) => a + mean(v), 0) / ow
  if (wr > 1 + CEILING) return no(`first request ${pct(wr)}% heavier than the original`)
  return { accepted: true, reason: 'accepted', numbers }
}

const LOST = 'lost to the other candidate'

/** Of two accepted candidates, the one to keep: more PASS, then the lower tokens per success × total model time, then the lower index. */
export function pickWinner<T extends { index: number; runs: RunLite[] }>(a: T, b: T): T {
  const [x, y] = [numbersOf(a.runs), numbersOf(b.runs)]
  if (x.pass !== y.pass) return x.pass > y.pass ? a : b
  const price = (c: T, n: Numbers) => n.tokensPerSuccess! * c.runs.reduce((t, r) => t + r.modelMs!, 0)
  const [pa, pb] = [price(a, x), price(b, y)]
  return pa !== pb ? (pa < pb ? a : b) : a.index < b.index ? a : b
}

/** A round's verdicts: each candidate by `decide` against the round's cur, and at most one accepted. The run loop and `replay` both come here, so a journal cannot claim another winner. */
export function decideRound(i: { cur: RunLite[]; cands: { index: number; runs: RunLite[] }[]; orig: RunLite[]; gateNames: string[]; split: Split; origMaxTurns: number }) {
  const { cands, ...rest } = i
  const ds = cands.map(c => ({ ...c, ...decide({ ...rest, cand: c.runs }) }))
  const yes = ds.filter(d => d.accepted)
  if (yes.length < 2) return ds
  const won = yes.reduce((a, b) => pickWinner(a, b))
  return ds.map(d => d.accepted && d !== won ? { ...d, accepted: false, reason: LOST } : d)
}

export type Edit = { field: string; value: string | number; why?: string }

/** A new config with the edit at its leaf: a paragraph is appended, a number set; `loop`/`context` made only when missing. */
export function applyEdit(cfg: object, e: Edit): object {
  // Its own guard, not only checkEdit's: a replayed journal reaches here too, and `__proto__.x` would pollute.
  if (!ALLOWED.includes(e.field)) throw new Error('field not allowed')
  const c = structuredClone(cfg) as any
  if (e.field === 'systemPrompt') { c.systemPrompt = String(c.systemPrompt ?? '').trimEnd() + '\n\n' + e.value; return c }
  const [sec, key] = e.field.split('.')
  c[sec] = c[sec] && typeof c[sec] === 'object' ? c[sec] : {}
  c[sec][key] = e.value
  return c
}

/** Words that would tie a paragraph to this repo's tasks rather than to how to work: names, files, identifiers, 6+ chars.
 *  `words` are kept at any length (polyglot's exercise and test names: `poker`); boundBy matches the short ones as whole words.
 *  A repo's short task names stay out: `test` or `fix` would refuse every paragraph, and old journals with it. */
export function bindingTokens(t: { names: string[]; paths: string[]; prompts: string[]; words?: string[] }): string[] {
  const ids = t.prompts.flatMap(p => p.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter(w => /_|\d|[a-z][A-Z]/.test(w))
  const rest = [...t.names, ...t.paths, ...t.paths.map(p => p.slice(p.lastIndexOf('/') + 1)), ...ids].map(w => w.toLowerCase()).filter(w => w.length >= 6)
  return [...new Set([...(t.words ?? []).map(w => w.toLowerCase()).filter(Boolean), ...rest])]
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Does the text hold a binding word: one under 6 chars as a whole word (`poker`, not `pokers`), a longer one anywhere. */
export const boundBy = (x: unknown, binding: string[]): boolean => {
  if (typeof x !== 'string') return false
  const low = x.toLowerCase()
  return binding.some(t => t.length >= 6 ? low.includes(t) : new RegExp(`(?<![\\p{L}\\p{N}_])${esc(t)}(?![\\p{L}\\p{N}_])`, 'u').test(low))
}

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
    // Refused, not stripped: a zero-width char inside `curl` or a file name would hide it from both checks below.
    if (/[\p{Cf}]|[^\P{Cc}\n\t]/u.test(v)) return 'bad value'
    if (DANGER.some(re => re.test(v))) return 'looks like a command or an address'
    if (boundBy(v, ctx.binding)) return 'tied to a task'
  } else if (typeof v !== 'number' || !Number.isFinite(v) || (e.field === 'loop.maxTurns' && !Number.isInteger(v))) return 'bad value'
  // Against the original, not current: a raise cannot chain past 2×. Here, not in a caller, so replay holds a journal to it too.
  else if (e.field === 'loop.maxTurns' && v > 2 * ((ctx.original as any).loop?.maxTurns ?? 0)) return 'above 2× the original'
  if (ctx.tried.some(t => t.field === e.field && t.value === v)) return 'already tried'
  const cand = applyEdit(ctx.current, e)
  const errs = validateConfig(cand)
  if (errs.length) return `invalid config: ${errs[0]}`
  // The second compare catches a current that was changed outside ALLOWED before this edit (a hand-edited journal).
  if (diffPaths(cand, ctx.current).some(p => p !== e.field) || diffPaths(cand, ctx.original).some(p => !ALLOWED.includes(p))) return 'changes more than one field'
  return undefined
}

export type Group = { signature: string; count: number; calls: Record<string, number>; exts: Record<string, number> }

const CHECK_CLASS: [string, string][] = [['check exited', 'check_failed'], ['check timed out', 'check_timeout'], ['the check found 0 tests', 'no_tests'], ['changed a protected file', 'protected'],
  // polyglot's check: by the reason's prefix only — the rest of it holds a test name.
  ['a test failed:', 'test'], ['timeout after', 'timeout'], ['missing solution file', 'missing'], ['unexpected test', 'unexpected']]
/** The reasons a run ends with (DoneReason, and the bench's 'error'); anything else in a journal is `other`. */
const REASONS: (DoneReason | 'error')[] = ['final', 'max_turns', 'parse_failed', 'aborted', 'backend_error', 'mcp_error', 'repeat_loop', 'proxy_stopped', 'error']
/** The file types the proposer may hear of: a path's tail is the model's own argument, not a type. */
const EXTS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'sh', 'json', 'md', 'txt', 'yml', 'yaml', 'toml', 'css', 'html', 'vue', 'sql', 'xml']
const bump = (r: Record<string, number>, k: string) => { r[k] = (r[k] ?? 0) + 1 }

/** How a FAIL run failed, in fixed words. `events` is [] when the trace could not be read. */
export function signatureOf(run: RunLite, events: HarnessEvent[]): string {
  const a = analyzeTrace(events)
  // The reason comes from a journal on resume, which bash can rewrite: only a known one is passed on.
  const reason = run.reason === undefined ? '-' : (REASONS as string[]).includes(run.reason) ? run.reason : 'other'
  const check = run.lastError === undefined ? '-' : CHECK_CLASS.find(([p]) => run.lastError!.startsWith(p))?.[1] ?? 'other'
  const kinds: Record<string, number> = {}
  for (const pe of Object.values(a.edits)) for (const [k, n] of Object.entries(pe.byKind)) kinds[k] = (kinds[k] ?? 0) + n!
  const top = Object.entries(kinds).sort((x, y) => y[1] - x[1])[0]?.[0] ?? '-'
  const truncated = events.some(e => e.type === 'tool_result' && e.truncated) ? 'truncated' : '-'
  return `${reason}|${check}|${top}|${truncated}`
}
/** Only what signatureOf can make; built from its vocabularies, so a journal's `sig` is never free text. */
export const SIG = new RegExp(`^(?:${[...REASONS, 'other', '-'].join('|')})\\|(?:${[...CHECK_CLASS.map(c => c[1]), 'other', '-'].join('|')})\\|(?:${[...EDIT_KINDS, '-'].join('|')})\\|(?:truncated|-)$`)

/** FAIL runs grouped by how they failed, biggest first. Only fixed words and counts: no path, name, argument or output
 *  of the repo reaches the proposer — a tool name or extension that is not one of ours is `unknown` / `other`. */
export function failureGroups(items: { run: RunLite; events: HarnessEvent[] }[]): Group[] {
  const groups = new Map<string, Group>()
  for (const { run, events } of items) {
    if (run.verdict !== 'FAIL') continue
    const a = analyzeTrace(events)
    const signature = signatureOf(run, events)
    const g = groups.get(signature) ?? { signature, count: 0, calls: {}, exts: {} }
    g.count++
    for (const e of events) if (e.type === 'tool_call') bump(g.calls, (TOOL_NAMES as string[]).includes(e.call.name) ? e.call.name : 'unknown')
    for (const p of Object.keys(a.edits)) { const x = /\.([a-z0-9]{1,8})$/.exec(p)?.[1]; bump(g.exts, x && EXTS.includes(x) ? x : 'other') }
    groups.set(signature, g)
  }
  return [...groups.values()].sort((x, y) => y.count - x.count)
}

export type Rejected = { field: string; value?: string | number; reason: string }

/** The reply's shape, its field one of `fields`. */
export const proposalSchema = (fields: string[]) => ({
  type: 'object',
  properties: { field: { type: 'string', enum: fields }, value: { anyOf: [{ type: 'string' }, { type: 'number' }] }, why: { type: 'string', maxLength: 300 } },
  required: ['field', 'value'], additionalProperties: false,
})
export const PROPOSAL_SCHEMA = proposalSchema(ALLOWED)

/** Fields closed for now: two rejected candidates in a row on one (`already tried` and a lost round count), none accepted since.
 *  An acceptance clears every count; a line with no edit counts for nothing. Journal order, so replay and the run loop agree. */
export function exhausted(lines: JournalLine[]): string[] {
  const n = new Map<string, number>()
  for (const l of lines) {
    if (l.type !== 'candidate' || !l.edit) continue
    if (l.accepted) n.clear()
    else n.set(l.edit.field, (n.get(l.edit.field) ?? 0) + 1)
  }
  return ALLOWED.filter(f => (n.get(f) ?? 0) >= 2)
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

const PROPOSER_SYSTEM = `You improve the harness of a coding agent. The input lists the harness's current settings, groups of failed runs (how each ended, which tools it called, which file types it edited) and edits already refused. Propose exactly one edit, as JSON {"field": ..., "value": ..., "why": ...}. field is one of: ${ALLOWED.join(', ')}. For systemPrompt, value is one short paragraph (at most ${PARA_MAX} characters) appended to the prompt: general advice on how to work on such tasks, never about one task, file or name, and no commands, paths or addresses. For any other field, value is a number; loop.maxTurns is a whole number, at most twice its original value. Do not propose an edit that was refused.`

/** `fields` are the closed ones: named in the prompt (field names from ALLOWED only) and left out of the schema's enum. */
export function proposerRequest(model: string, input: string, o: { schema: boolean; noThink: boolean; fields?: string[] }): ChatRequest {
  const closed = ALLOWED.filter(f => o.fields?.includes(f))
  const system = PROPOSER_SYSTEM + (closed.length ? `\n\nThese fields are closed for now, propose another: ${closed.join(', ')}` : '')
  return {
    model,
    messages: [{ role: 'system', content: o.noThink ? system + '\n/no_think' : system }, { role: 'user', content: input }],
    ...(o.schema ? { responseSchema: closed.length ? proposalSchema(ALLOWED.filter(f => !closed.includes(f))) : PROPOSAL_SCHEMA } : {}),
  }
}

/** The edit in a proposer reply — bare, fenced, after a <think> block or in prose, as the notes writer reads one. */
export function parseProposal(content: string): Edit {
  for (const x of jsonCandidates(content) as any[])
    if (typeof x?.field === 'string' && (typeof x.value === 'string' || typeof x.value === 'number'))
      return { field: x.field, value: x.value, ...(typeof x.why === 'string' ? { why: x.why.slice(0, 300) } : {}) }
  throw new Error('no edit in the reply')
}

type Proposal = { round: number; index: number; input: string; edit: Edit }
type SweepLine = { v: 2; type: 'sweep'; round: number; sweep: number; cur: RunLite[]; cands: { index: number; runs: RunLite[] }[] }
type TestSweep = { v: 2; type: 'testsweep'; sweep: number; orig: RunLite[]; last: RunLite[] }
export type JournalLine =
  | { v: 2; type: 'start'; base: string; sha: string; pin: string; notes: string; sets: Record<SetName, string[]>; declarable: boolean; mode: EvolveMode; proposer: string; repeats: number; rounds: number; attempt?: number; modules?: string }
  | { v: 2; type: 'probe'; round: number; runs: RunLite[] }
  | ({ v: 2; type: 'proposal'; costUsd?: number } & Proposal)
  | SweepLine
  | { v: 2; type: 'candidate'; round: number; index: number; input: string; edit?: Edit; accepted: boolean; reason: string; numbers?: Numbers; version?: number; costUsd?: number }
  | TestSweep
  | { v: 2; type: 'final'; version: number }
  | { v: 2; type: 'cut'; costUsd: number }

// A field's check: undefined = fine, else why not. The journal sits in the user's cwd, where the model's bash can
// rewrite it, so every key is known and every value typed.
type Check = (x: unknown) => string | undefined
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)
const str: Check = x => typeof x === 'string' ? undefined : 'not a string'
const bool: Check = x => typeof x === 'boolean' ? undefined : 'not a boolean'
const num: Check = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? undefined : 'not a number'
const pos: Check = x => Number.isInteger(x) && (x as number) >= 1 ? undefined : 'not a positive integer'
const NAME = /^[A-Za-z0-9._-]{1,64}$/
const name: Check = x => typeof x === 'string' && NAME.test(x) ? undefined : 'not a task name'
const arr = (each: Check): Check => x => {
  if (!Array.isArray(x)) return 'not a list'
  for (const [i, y] of x.entries()) { const w = each(y); if (w) return `[${i}] ${w}` }
}
const shape = (req: Record<string, Check>, opt: Record<string, Check> = {}): Check => x => {
  if (!isObj(x)) return 'not an object'
  // hasOwn, not `in`: `constructor` or `__proto__` is on every object and must not pass as a known key.
  for (const k of Object.keys(x)) if (!Object.hasOwn(req, k) && !Object.hasOwn(opt, k)) return `unknown key ${JSON.stringify(k).slice(0, 40)}`
  for (const [k, c] of Object.entries(req)) { if (!Object.hasOwn(x, k)) return `missing ${k}`; const w = c(x[k]); if (w) return `${k}: ${w}` }
  for (const [k, c] of Object.entries(opt)) if (Object.hasOwn(x, k)) { const w = c(x[k]); if (w) return `${k}: ${w}` }
}
const RUN = shape({ task: name, verdict: x => x === 'PASS' || x === 'FAIL' ? undefined : 'not PASS or FAIL', turns: num, modelMs: num },
  { repeat: pos, costUsd: num, tokens: num, firstPromptTokens: num, trace: str, reason: str, lastError: str, sig: x => typeof x === 'string' && SIG.test(x) ? undefined : 'not a signature' })
const EDIT = shape({ field: str, value: x => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)) ? undefined : 'not a string or a number' }, { why: str })
const sha256: Check = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x) ? undefined : 'not a sha256'
const v2: Check = x => x === 2 ? undefined : 'not 2'
const LINE: Record<string, Check> = {
  start: shape({ v: v2, type: str, base: str, sha: str, pin: sha256, notes: sha256, sets: shape({ train: arr(name), gate: arr(name), test: arr(name) }), declarable: bool, mode: x => x === 'custom' || (typeof x === 'string' && Object.hasOwn(MODES, x)) ? undefined : 'not a mode', proposer: str,
    repeats: x => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 20 ? undefined : 'not an integer from 1 to 20', rounds: pos },
    // modules: the manifest of a repo's own node_modules, which nothing reinstalls ('' = it has none).
    { attempt: pos, modules: x => x === '' ? undefined : sha256(x) }),
  // The current version on train, the proposer's first input; never in a decision.
  probe: shape({ v: v2, type: str, round: pos, runs: arr(RUN) }),
  candidate: shape({ v: v2, type: str, round: pos, index: pos, input: str, accepted: bool, reason: str },
    { edit: EDIT, numbers: shape({ pass: num }, { tokensPerSuccess: num, tokens: num, weight: num }), version: pos, costUsd: num }),
  // Written before the candidate's runs: a stop during them resumes with this edit, not a new roll of the proposer.
  // costUsd: the proposer's own call(s) for it, when the proposer is priced; the candidate line of a measured proposal carries none, so nothing is counted twice.
  proposal: shape({ v: v2, type: str, round: pos, index: pos, input: str, edit: EDIT }, { costUsd: num }),
  // One line per sweep: a stop loses at most the sweep it cut.
  sweep: shape({ v: v2, type: str, round: pos, sweep: pos, cur: arr(RUN), cands: arr(shape({ index: pos, runs: arr(RUN) })) }),
  testsweep: shape({ v: v2, type: str, sweep: pos, orig: arr(RUN), last: arr(RUN) }),
  final: shape({ v: v2, type: str, version: x => Number.isInteger(x) && (x as number) >= 0 ? undefined : 'not a non-negative integer' }),
  // A stop's dropped sweep or proposal: only its money stays. Between any two lines, and never in a decision.
  cut: shape({ v: v2, type: str, costUsd: num }),
}

/** The journal's lines, each checked. A last line without its newline is a torn write and dropped, even if it parses. */
export function parseJournal(text: string): { lines: JournalLine[] } | { error: string } {
  const parts = text.split('\n')
  parts.pop() // '' after the last newline, or the torn line
  const lines: JournalLine[] = []
  for (const [i, p] of parts.entries()) {
    let x: unknown
    try { x = JSON.parse(p) } catch { return { error: `line ${i + 1}: not JSON` } }
    // Fail closed: a v1 line has no turns or model time, and a check that skipped what it lacks would pass it.
    if (isObj(x) && x.v === 1) return { error: `line ${i + 1}: an older evolve journal: this version cannot read it; move it away to start over` }
    const c = isObj(x) && typeof x.type === 'string' && Object.hasOwn(LINE, x.type) ? LINE[x.type] : undefined
    const why = c ? c(x) : 'unknown type'
    if (why) return { error: `line ${i + 1}: ${why}` }
    lines.push(x as JournalLine)
  }
  return { lines }
}

// The reasons the edit checks and `decide` write. Rejected edits reach the proposer, maybe in the cloud, and the
// journal is bash-writable: anything else is passed on as `other`.
const FIXED = /^(?:field not allowed|bad value|looks like a command or an address|tied to a task|already tried|changes more than one field|above 2× the original|the server gave no usage|0 PASS|no more PASS than current|worse on gate|no edit in the reply|reply cut at maxTokens|lost to the other candidate|field exhausted)$/
const PATTERNED: [RegExp, string][] = [
  [/^within noise \(p=\d\.\d\d\)$/, 'within noise'], [/^costs \d+% more tokens(?: per success)? than the original$/, 'costs more tokens'],
  [/^first request \d+% heavier than the original$/, 'first request heavier'], [/^first request not measured on \d+ tasks$/, 'first request not measured'], [/^invalid config: /, 'invalid config'],
  // costReason: digits and fixed words only; the number's own shape per cost (turns 1 decimal, tokens whole, time 1 decimal + s).
  [/^turns \d+\.\d → \d+\.\d, allowed up to \d+\.\d \(p=\d\.\d\d\)$/, 'over tolerance: turns'], [/^tokens \d+ → \d+, allowed up to \d+ \(p=\d\.\d\d\)$/, 'over tolerance: tokens'],
  [/^time \d+\.\ds → \d+\.\ds, allowed up to \d+\.\ds \(p=\d\.\d\d\)$/, 'over tolerance: time'],
]
const REASON_RE = [FIXED, ...PATTERNED.map(p => p[0])]
const COST_KINDS = ['costs more tokens', 'first request heavier', 'over tolerance: turns', 'over tolerance: tokens', 'over tolerance: time']
/** The fixed kind of a refusal reason (the numbers and config text dropped); `other` for what the harness does not write. */
export const reasonKind = (reason: string): string => FIXED.test(reason) ? reason : PATTERNED.find(([re]) => re.test(reason))?.[1] ?? 'other'
/** What the report prints of a refusal: a cost reason whole (its regex lets through digits and fixed words only), else its kind. */
export const reasonShown = (reason: string): string => { const k = reasonKind(reason); return COST_KINDS.includes(k) ? reason : k }

/** Dollars in the journal: every run's cost, every proposer call's and every stop's dropped work. A run or call with no price counts 0. */
export const spent = (lines: JournalLine[]): number => lines.reduce((t, l) => {
  const runs = l.type === 'probe' ? l.runs : l.type === 'sweep' ? [...l.cur, ...l.cands.flatMap(c => c.runs)] : l.type === 'testsweep' ? [...l.orig, ...l.last] : []
  return t + runs.reduce((a, r) => a + (r.costUsd ?? 0), 0) + (l.type === 'proposal' || l.type === 'candidate' || l.type === 'cut' ? l.costUsd ?? 0 : 0)
}, 0)

/** A round's candidates with their runs of every sweep. */
export const sweptCands = (sweeps: Pick<SweepLine, 'cands'>[]) => sweeps[0]!.cands.map(({ index }) => ({ index, runs: sweeps.flatMap(s => s.cands.find(c => c.index === index)!.runs) }))

/** The current version rebuilt from the original and the journal, every proposal checked again as if new and every verdict
 *  worked out again from its sweeps: a vN file or a hand-written line is never what the next round starts from.
 *  `feed` is what the proposer reads, `pending` the proposals with no candidate line yet, `tested` the test sweeps of the last version. */
export function replay(lines: JournalLine[], original: object, ctx: { binding: string[]; sets: Record<SetName, string[]> }):
  { current: object; version: number; baseline?: RunLite[]; feed?: RunLite[]; tried: Edit[]; rejected: Rejected[]; pending: Proposal[]; tested: number; exhausted: string[]; final?: { orig: RunLite[]; last: RunLite[] } | 'none' } | { error: string } {
  const [first, ...tail] = lines
  // A cut line is money only: it may fall anywhere, so no order below sees it.
  const rest = tail.filter((l): l is Exclude<JournalLine, { type: 'cut' }> => l.type !== 'cut')
  if (first?.type !== 'start') return { error: 'cannot resume: the journal does not begin with a start line' }
  if (JSON.stringify(first.sets) !== JSON.stringify(ctx.sets)) return { error: 'cannot resume: the sets differ from the tasks file' }
  const no = (why: string) => ({ error: `cannot resume: ${why}` })
  let current = original, version = 0, baseline: RunLite[] | undefined, feed: RunLite[] | undefined, firstSwept: number | undefined
  const tried: Edit[] = [], rejected: Rejected[] = []
  // The open round's proposals and sweeps, and the last version's test sweeps.
  let pending: Proposal[] = [], sweeps: SweepLine[] = [], tests: TestSweep[] = []
  // Slots go in order, (round, index): a proposal or a refusal before the runs takes the next one.
  let taken = 0
  const claim = (round: number, index: number) => {
    const s = (round - 1) * CANDIDATES + index
    if (s <= taken) return 'a second line for it'
    if (index > CANDIDATES || s !== taken + 1) return 'out of order'
    taken = s
  }
  const split = splitOf(ctx.sets, false, first.mode)
  const trainGate = [...ctx.sets.train, ...ctx.sets.gate]
  const whole = (rs: RunLite[], names: string[], sweep?: number) => rs.map(r => r.task).sort().join('\n') === [...names].sort().join('\n') && rs.every(r => r.repeat === sweep)
  const onTrain = (rs: RunLite[]) => rs.filter(r => ctx.sets.train.includes(r.task))
  // Nothing goes on without a look at the train tasks: the proposer reads them.
  if (rest.length && !(rest[0]!.type === 'probe' && rest[0]!.round === 1)) return no('the line after the start line is not round 1\'s probe')
  for (const [i, l] of rest.entries()) {
    if (l.type === 'start') return no('a second start line')
    if (l.type === 'probe') {
      if (i) return no('round 1 probe: a second line for it')
      if (!whole(l.runs, ctx.sets.train)) return no('round 1 probe: not the train tasks')
      feed = l.runs
      continue
    }
    if (pending.length && (l.type === 'final' || l.type === 'testsweep' || l.round !== pending[0]!.round))
      return no(`round ${pending[0]!.round} candidate ${pending[0]!.index}: a proposal without its candidate`)
    if (l.type === 'final') continue // not the last line: a later round makes it stale
    if (l.type === 'testsweep') {
      const slot = `test sweep ${l.sweep}`
      if (!version) return no(`${slot}: no version to measure`)
      if (l.sweep <= tests.length) return no(`${slot}: a second line for it`)
      if (l.sweep !== tests.length + 1 || l.sweep > first.repeats) return no(`${slot}: out of order`)
      if (!whole(l.orig, ctx.sets.test, l.sweep) || !whole(l.last, ctx.sets.test, l.sweep)) return no(`${slot}: not one run per test task`)
      tests.push(l)
      continue
    }
    if (l.type === 'sweep') {
      const slot = `round ${l.round} sweep ${l.sweep}`
      if (!pending.length) return no(`${slot}: no proposal to measure`)
      if (l.sweep <= sweeps.length) return no(`${slot}: a second line for it`)
      if (taken !== l.round * CANDIDATES || l.sweep !== sweeps.length + 1 || l.sweep > first.repeats) return no(`${slot}: out of order`)
      if (l.cands.map(c => c.index).join() !== pending.map(p => p.index).join()) return no(`${slot}: not the round's proposals`)
      if (![l.cur, ...l.cands.map(c => c.runs)].every(rs => whole(rs, trainGate, l.sweep))) return no(`${slot}: not one run per task`)
      sweeps.push(l)
      // While no version is kept cur is the original, and none can come before the first sweeps.
      if ((firstSwept ??= l.round) === l.round) baseline = [...baseline ?? [], ...l.cur]
      feed = onTrain(l.cur)
      continue
    }
    const slot = `round ${l.round} candidate ${l.index}`
    if (l.type === 'proposal') {
      const out = claim(l.round, l.index)
      if (out) return no(`${slot}: ${out}`)
      // A forged journal cannot steer back onto a field the proposer was told is closed.
      if (exhausted(rest.slice(0, i)).includes(l.edit.field)) return no(`${slot}: proposed edit: field exhausted`)
      // Both candidates of a round stand on one current, and candidate 2 hears of candidate 1's edit as tried.
      const why = checkEdit(l.edit, { current, original, tried: [...tried, ...pending.map(p => p.edit)], binding: ctx.binding })
      if (why) return no(`${slot}: proposed edit: ${why}`)
      pending.push({ round: l.round, index: l.index, input: l.input, edit: l.edit })
      continue
    }
    const p = pending.find(x => x.round === l.round && x.index === l.index)
    if (p) {
      if (sweeps.length !== first.repeats) return no(`${slot}: decided before its sweeps`)
      if (l.input !== p.input || JSON.stringify(l.edit) !== JSON.stringify(p.edit)) return no(`${slot}: its edit or input is not the one proposed`)
      if (typeof split === 'string') return no(split)
      // decideRound is pure and every input is in the journal: the line's verdict must be what its sweeps give.
      const d = decideRound({ cur: sweeps.flatMap(s => s.cur), cands: sweptCands(sweeps), orig: baseline!, gateNames: ctx.sets.gate, split, origMaxTurns: (original as any).loop?.maxTurns ?? Infinity }).find(x => x.index === l.index)!
      if (d.accepted !== l.accepted) return no(`${slot}: its runs do not give ${l.accepted ? 'an acceptance' : 'a refusal'}`)
      if (d.reason !== l.reason) return no(`${slot}: its reason is not what its runs give`)
      pending = pending.filter(x => x !== p)
    } else {
      const why = claim(l.round, l.index)
      if (why) return no(`${slot}: ${why}`)
      if (l.accepted) return no(`${slot}: accepted, but no proposal of it was measured`)
    }
    if (l.accepted) {
      version++
      if (l.reason !== 'accepted' || l.version !== version) return no(`${slot}: accepted, but not written as version ${version}`)
      current = applyEdit(current, l.edit!)
      feed = onTrain(sweeps.at(-1)!.cands.find(c => c.index === l.index)!.runs)
      tests = [] // they measured the version before this one
    } else if (l.edit) {
      const bound = (x: unknown) => boundBy(x, ctx.binding)
      const reason = REASON_RE.some(re => re.test(l.reason)) && !bound(l.reason) ? l.reason : 'other'
      const v = l.edit.value, tied = reason === 'tied to a task' || bound(v)
      // A field outside ALLOWED is free text too.
      rejected.push({ field: ALLOWED.includes(l.edit.field) ? l.edit.field : 'other', ...(tied ? {} : { value: v }), reason })
    }
    if (l.edit) tried.push(l.edit)
    if (!pending.length) sweeps = []
  }
  const end = rest.at(-1)
  let final: { orig: RunLite[]; last: RunLite[] } | 'none' | undefined
  if (end?.type === 'final') {
    if (end.version !== version || tests.length !== (version ? first.repeats : 0)) return no('the final line does not match the journal')
    final = version ? { orig: tests.flatMap(t => t.orig), last: tests.flatMap(t => t.last) } : 'none'
  }
  return { current, version, baseline, feed, tried: [...tried, ...pending.map(p => p.edit)], rejected, pending, tested: tests.length, exhausted: exhausted(lines), final }
}

const PRINCIPLE = 'how far this is a principle rather than a fit depends on how unlike the training tasks the test tasks are'

/** The original against the last version on the test tasks, repeats and costs included (time against the original: both ran in one sweep). Only ever about this repo's tasks.
 *  `better` is the claim: more PASS (declarable: p < ALPHA with the flips the sign test needs) and costs within the decide gates. */
export function verdict(orig: RunLite[], last: RunLite[], split: Split, origMaxTurns: number): { better: boolean; lines: string[] } {
  const SEEN = split.polyglot ? 'on the exercises Evolve did not see' : 'on the tasks of this repo Evolve did not see'
  const rate = (rs: RunLite[]) => rs.length ? numbersOf(rs).pass / rs.length : 0
  const win = (a: RunLite[], b: RunLite[]) => { const { p, improved } = passGain(a, b); return p < ALPHA && improved >= neededFlips() }
  let better = false, lines: string[]
  if (split.declarable) {
    if (win(orig, last)) better = true
    lines = [better ? `better ${SEEN}` : win(last, orig) ? `worse ${SEEN}` : `not told apart from noise ${SEEN}`]
  } else {
    const [po, pl] = [rate(orig), rate(last)]
    better = pl > po
    lines = [referenceLabel(split), pl > po ? 'more PASS' : pl < po ? 'fewer PASS' : 'not told apart']
  }
  if (better) {
    const over = !usable(orig) || !usable(last) ? 'the server gave no usage' : costGate(orig, last, orig, origMaxTurns)
    if (over) { better = false; lines = [split.declarable ? `more PASS ${SEEN}, but not better: ${over}` : `${lines.join('; ')}, but not better: ${over}`] }
  }
  return { better, lines: [...lines, PRINCIPLE] }
}
