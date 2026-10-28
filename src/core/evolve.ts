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
export { ALLOWED }

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
export function splitSets(tasks: Pick<RepoTask, 'name' | 'set'>[]): Record<SetName, string[]> {
  const out: Record<SetName, string[]> = { train: [], gate: [], test: [] }
  for (const t of tasks) {
    const b = createHash('sha1').update(t.name).digest()[0]! % 4
    out[t.set ?? (b < 2 ? 'train' : b === 2 ? 'gate' : 'test')].push(t.name)
  }
  return out
}

/** `polyglot`: the tasks are the first N Exercism exercises, and more of them is a larger --size, not more tasks to write. */
export type Mode = { strict: boolean; trainGate: number; test: number; polyglot?: true }

export function modeOf(sets: Record<SetName, string[]>, polyglot = false): Mode | string {
  const [t, g, x] = [sets.train.length, sets.gate.length, sets.test.length]
  if (!t || !g || !x) return `evolve needs at least one task in each of train, gate and test (have ${t}/${g}/${x})`
  return { strict: t + g >= MIN_TRAIN_GATE && x >= MIN_TEST, trainGate: t + g, test: x, ...(polyglot ? { polyglot: true as const } : {}) }
}

/** The label a reference-mode result carries: too few tasks to tell a gain from luck. */
export const referenceLabel = (m: Mode): string =>
  `\u041e\u0420\u0406\u0404\u041d\u0422\u0418\u0420, \u041d\u0415 \u0414\u041e\u041a\u0410\u0417 \u2014 too few ${m.polyglot ? 'exercises' : 'tasks'} (${m.trainGate + m.test} of ${MIN_TRAIN_GATE + MIN_TEST}) for a statistical conclusion; ` +
  (m.polyglot ? `raise --size to ${STRICT_SIZE}` : `add ${Math.max(0, MIN_TRAIN_GATE - m.trainGate) + Math.max(0, MIN_TEST - m.test)} more tasks`)

/** The smallest polyglot --size whose split (i % 3) gives strict mode: 8 train, 8 gate, 8 test. */
export const STRICT_SIZE = 24

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

export type RunLite = { task: string; verdict: 'PASS' | 'FAIL'; tokens?: number; firstPromptTokens?: number; trace?: string; reason?: string; lastError?: string; sig?: string }
export type Numbers = { pass: number; tokensPerSuccess?: number; tokens?: number; weight?: number }

export function numbersOf(runs: RunLite[]): Numbers {
  const pass = runs.filter(r => r.verdict === 'PASS').length
  const n: Numbers = { pass }
  // A run that got no reply has tokens 0; one with replies but no usage has none, and the sum has none either.
  if (runs.every(r => r.tokens !== undefined)) { n.tokens = runs.reduce((a, r) => a + r.tokens!, 0); if (pass) n.tokensPerSuccess = n.tokens / pass }
  // A run without a first reply put nothing in front of the model: it is left out of the weight, not counted as 0.
  const fp = runs.filter(r => r.firstPromptTokens !== undefined)
  if (fp.length) n.weight = fp.reduce((a, r) => a + r.firstPromptTokens!, 0)
  return n
}

/** Runs the gates can divide by: token counts on every run, and some of them, and some first request. */
export const usable = (runs: RunLite[]): boolean => { const n = numbersOf(runs); return !!n.tokens && !!n.weight }

const pct = (ratio: number) => Math.round((ratio - 1) * 100)

/** cur = the current version's runs, cand = the candidate's, orig = the original's, all on train + gate. */
export function decide(cur: RunLite[], cand: RunLite[], orig: RunLite[], gateNames: string[], mode: Mode): { accepted: boolean; reason: string; numbers: Numbers } {
  const numbers = numbersOf(cand)
  const no = (reason: string) => ({ accepted: false, reason, numbers })
  const o = numbersOf(orig)
  // Every ratio below divides by the original's sums: a 0 there would be NaN or Infinity, never a refusal.
  if (!usable(cand) || !usable(orig)) return no('the server gave no usage')
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
  } else if (numbers.pass <= c.pass) return no('no more PASS than current')
  const gate = (rs: RunLite[]) => numbersOf(rs.filter(r => gateNames.includes(r.task))).pass
  if (gate(cand) < gate(cur)) return no('worse on gate')
  if (o.pass) {
    const r = numbers.tokensPerSuccess! / o.tokensPerSuccess!
    if (r > 1 + TOLERANCE) return no(`costs ${pct(r)}% more tokens per success than the original`)
  } else {
    const r = numbers.tokens! / o.tokens!
    if (r > 1 + TOLERANCE) return no(`costs ${pct(r)}% more tokens than the original`)
  }
  // Paired by task: a prompt too heavy for the window gets no reply, so no first request, and must not leave the sum lighter.
  const ofp = new Map(orig.map(r => [r.task, r.firstPromptTokens]))
  const unmeasured = cand.filter(r => r.firstPromptTokens === undefined && ofp.get(r.task) !== undefined).length
  if (unmeasured) return no(`first request not measured on ${unmeasured} tasks`)
  const both = cand.filter(r => r.firstPromptTokens !== undefined && ofp.get(r.task) !== undefined)
  const ow = both.reduce((a, r) => a + ofp.get(r.task)!, 0)
  if (!ow) return no('the server gave no usage')
  const wr = both.reduce((a, r) => a + r.firstPromptTokens!, 0) / ow
  if (wr > 1 + CEILING) return no(`first request ${pct(wr)}% heavier than the original`)
  return { accepted: true, reason: 'accepted', numbers }
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

export type JournalLine =
  | { v: 1; type: 'start'; base: string; sha: string; pin: string; notes: string; sets: Record<SetName, string[]>; strict: boolean; proposer: string }
  | { v: 1; type: 'current'; round: number; runs: RunLite[] }
  | { v: 1; type: 'candidate'; round: number; index: number; input: string; edit?: Edit; accepted: boolean; reason: string; numbers?: Numbers; runs?: RunLite[]; version?: number }
  | { v: 1; type: 'proposal'; round: number; index: number; input: string; edit: Edit }
  | { v: 1; type: 'final'; version: number; orig?: RunLite[]; last?: RunLite[] }

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
const RUN = shape({ task: name, verdict: x => x === 'PASS' || x === 'FAIL' ? undefined : 'not PASS or FAIL' },
  { tokens: num, firstPromptTokens: num, trace: str, reason: str, lastError: str, sig: x => typeof x === 'string' && SIG.test(x) ? undefined : 'not a signature' })
const EDIT = shape({ field: str, value: x => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)) ? undefined : 'not a string or a number' }, { why: str })
const sha256: Check = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x) ? undefined : 'not a sha256'
const v1: Check = x => x === 1 ? undefined : 'not 1'
const LINE: Record<string, Check> = {
  start: shape({ v: v1, type: str, base: str, sha: str, pin: sha256, notes: sha256, sets: shape({ train: arr(name), gate: arr(name), test: arr(name) }), strict: bool, proposer: str }),
  current: shape({ v: v1, type: str, round: pos, runs: arr(RUN) }),
  candidate: shape({ v: v1, type: str, round: pos, index: pos, input: str, accepted: bool, reason: str },
    { edit: EDIT, numbers: shape({ pass: num }, { tokensPerSuccess: num, tokens: num, weight: num }), runs: arr(RUN), version: pos }),
  // Written before the candidate's runs: a stop during them resumes with this edit, not a new roll of the proposer.
  proposal: shape({ v: v1, type: str, round: pos, index: pos, input: str, edit: EDIT }),
  final: shape({ v: v1, type: str, version: x => Number.isInteger(x) && (x as number) >= 0 ? undefined : 'not a non-negative integer' }, { orig: arr(RUN), last: arr(RUN) }),
}

/** The journal's lines, each checked. A last line without its newline is a torn write and dropped, even if it parses. */
export function parseJournal(text: string): { lines: JournalLine[] } | { error: string } {
  const parts = text.split('\n')
  parts.pop() // '' after the last newline, or the torn line
  const lines: JournalLine[] = []
  for (const [i, p] of parts.entries()) {
    let x: unknown
    try { x = JSON.parse(p) } catch { return { error: `line ${i + 1}: not JSON` } }
    const c = isObj(x) && typeof x.type === 'string' && Object.hasOwn(LINE, x.type) ? LINE[x.type] : undefined
    const why = c ? c(x) : 'unknown type'
    if (why) return { error: `line ${i + 1}: ${why}` }
    lines.push(x as JournalLine)
  }
  return { lines }
}

// The reasons the edit checks and `decide` write. Rejected edits reach the proposer, maybe in the cloud, and the
// journal is bash-writable: anything else is passed on as `other`.
const FIXED = /^(?:field not allowed|bad value|looks like a command or an address|tied to a task|already tried|changes more than one field|the server gave no usage|0 PASS|no more PASS than current|worse on gate|no edit in the reply|reply cut at maxTokens)$/
const PATTERNED: [RegExp, string][] = [
  [/^within noise \(p=\d\.\d\d\)$/, 'within noise'], [/^costs \d+% more tokens(?: per success)? than the original$/, 'costs more tokens'],
  [/^first request \d+% heavier than the original$/, 'first request heavier'], [/^first request not measured on \d+ tasks$/, 'first request not measured'], [/^invalid config: /, 'invalid config'],
]
const REASON_RE = [FIXED, ...PATTERNED.map(p => p[0])]
/** The fixed kind of a refusal reason (the numbers and config text dropped); `other` for what the harness does not write. */
export const reasonKind = (reason: string): string => FIXED.test(reason) ? reason : PATTERNED.find(([re]) => re.test(reason))?.[1] ?? 'other'

/** The current version rebuilt from the original and the journal, each accepted edit checked again as if new:
 *  a vN file or a hand-written line is never what the next round starts from. */
export function replay(lines: JournalLine[], original: object, ctx: { binding: string[]; sets: Record<SetName, string[]> }):
  { current: object; version: number; baseline?: RunLite[]; done: { round: number; index: number }[]; tried: Edit[]; rejected: Rejected[]; final?: { orig: RunLite[]; last: RunLite[] } | 'none'
    pending?: { round: number; index: number; input: string; edit: Edit } } | { error: string } {
  const [first, ...rest] = lines
  if (first?.type !== 'start') return { error: 'cannot resume: the journal does not begin with a start line' }
  if (JSON.stringify(first.sets) !== JSON.stringify(ctx.sets)) return { error: 'cannot resume: the sets differ from the tasks file' }
  let current = original, version = 0, baseline: RunLite[] | undefined
  const done: { round: number; index: number }[] = [], tried: Edit[] = [], rejected: Rejected[] = []
  // What each round's next candidate was compared with, as the run loop has it: the round's current runs, then each kept candidate's.
  const cmp = new Map<number, RunLite[]>()
  // The proposal whose candidate line has not come yet: the next line is that candidate, or the journal ends.
  let pending: { round: number; index: number; input: string; edit: Edit } | undefined
  const mode = modeOf(ctx.sets)
  // Every candidate is weighed against round 1's current runs: a journal that does not go on with them has no baseline.
  if (rest.length && !(rest[0]!.type === 'current' && rest[0]!.round === 1)) return { error: 'cannot resume: the line after the start line is not round 1\'s current runs' }
  for (const l of rest) {
    if (l.type === 'start') return { error: 'cannot resume: a second start line' }
    if (pending && !(l.type === 'candidate' && l.round === pending.round && l.index === pending.index))
      return { error: `cannot resume: round ${pending.round} candidate ${pending.index}: a proposal without its candidate` }
    if (l.type === 'final') continue // not the last line: a later round makes it stale
    const index = l.type === 'current' ? 0 : l.index
    const slot = `round ${l.round} ${index ? `candidate ${index}` : 'current runs'}`
    if (done.some(d => d.round === l.round && d.index === index)) return { error: `cannot resume: ${slot}: a second line for it` }
    // Checked as the run loop checked it, against what was tried before it; never itself in `tried` or `rejected`.
    if (l.type === 'proposal') {
      const why = checkEdit(l.edit, { current, original, tried, binding: ctx.binding })
      if (why) return { error: `cannot resume: ${slot}: proposed edit: ${why}` }
      pending = { round: l.round, index: l.index, input: l.input, edit: l.edit }
      continue
    }
    if (pending && !(l.type === 'candidate' && l.input === pending.input && JSON.stringify(l.edit) === JSON.stringify(pending.edit)))
      return { error: `cannot resume: ${slot}: its edit or input is not the one proposed` }
    pending = undefined
    done.push({ round: l.round, index })
    if (l.type === 'current') {
      if (l.round === 1) baseline ??= l.runs
      cmp.set(l.round, l.runs)
      continue
    }
    if (l.accepted) {
      version++
      const why = l.edit ? checkEdit(l.edit, { current, original, tried, binding: ctx.binding }) : 'no edit'
      if (why) return { error: `cannot resume: ${slot}: accepted edit ${version}: ${why}` }
      if (l.reason !== 'accepted' || l.version !== version || !l.runs) return { error: `cannot resume: ${slot}: accepted, but not written as version ${version} with its runs` }
    }
    // decide is pure and every input is in the journal: the line's verdict must be what its own numbers give.
    if (l.runs) {
      const was = cmp.get(l.round)
      if (typeof mode === 'string') return { error: `cannot resume: ${mode}` }
      if (!was) return { error: `cannot resume: ${slot}: no current runs of its round to compare with` }
      if (decide(was, l.runs, baseline!, ctx.sets.gate, mode).accepted !== l.accepted) return { error: `cannot resume: ${slot}: its runs do not give ${l.accepted ? 'an acceptance' : 'a refusal'}` }
    }
    if (l.accepted) {
      current = applyEdit(current, l.edit!)
      cmp.set(l.round, l.runs!)
    } else if (l.edit) {
      const bound = (x: unknown) => boundBy(x, ctx.binding)
      const reason = REASON_RE.some(re => re.test(l.reason)) && !bound(l.reason) ? l.reason : 'other'
      const v = l.edit.value, tied = reason === 'tied to a task' || bound(v)
      // A field outside ALLOWED is free text too.
      rejected.push({ field: ALLOWED.includes(l.edit.field) ? l.edit.field : 'other', ...(tied ? {} : { value: v }), reason })
    }
    if (l.edit) tried.push(l.edit)
  }
  const end = lines[lines.length - 1]
  let final: { orig: RunLite[]; last: RunLite[] } | 'none' | undefined
  if (end?.type === 'final') {
    const names = (rs: RunLite[]) => rs.map(r => r.task).sort().join('\n'), test = [...ctx.sets.test].sort().join('\n')
    const ok = end.version === version && (version === 0
      ? !end.orig && !end.last
      : !!end.orig && !!end.last && names(end.orig) === test && names(end.last) === test)
    if (!ok) return { error: 'cannot resume: the final line does not match the journal' }
    final = version ? { orig: end.orig!, last: end.last! } : 'none'
  }
  return { current, version, baseline, done, tried, rejected, final, ...(pending ? { pending } : {}) }
}

const PRINCIPLE = 'how far this is a principle rather than a fit depends on how unlike the training tasks the test tasks are'

/** The original against the last version on the test tasks, paired by name. Only ever about this repo's tasks. */
export function verdict(orig: RunLite[], last: RunLite[], mode: Mode): string {
  const was = new Map(orig.map(r => [r.task, r.verdict]))
  let b = 0, c = 0, po = 0, pl = 0
  for (const r of last) {
    const v = was.get(r.task)
    if (!v) continue
    if (v === 'PASS') po++
    if (r.verdict === 'PASS') pl++
    if (v === 'FAIL' && r.verdict === 'PASS') b++
    else if (v === 'PASS' && r.verdict === 'FAIL') c++
  }
  const SEEN = mode.polyglot ? 'on the exercises Evolve did not see' : 'on the tasks of this repo Evolve did not see'
  const lines = mode.strict
    ? [signP(b, c) < ALPHA ? `better ${SEEN}` : signP(c, b) < ALPHA ? `worse ${SEEN}` : `not told apart from noise ${SEEN}`]
    : [referenceLabel(mode), pl > po ? 'more PASS' : pl < po ? 'fewer PASS' : 'not told apart']
  return [...lines, PRINCIPLE].join('\n')
}
