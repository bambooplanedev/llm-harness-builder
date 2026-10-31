// What an evolve run comes to, from its journal: conclusion, why, advice, how to apply.
// Pure — no fs, no process, no clock — so the same journal prints the same text at the end of a run and on `--report`.
// Every line is a fixed template filled with numbers and fixed words (verdicts, `sig`, `reasonKind`, ALLOWED fields);
// the only free text is the accepted systemPrompt paragraphs, labelled as the proposer's. Never task names, paths,
// lastError, trace, why or a run's reason.
import { ALLOWED, exhausted, numbersOf, orientationOnly, reasonKind, referenceLabel, shortOf, verdict, WINNER_MODES, type JournalLine, type RunLite, type SetName, type Split } from './evolve.js'
import { showableText } from './events.js'

export type ReportInput = {
  lines: JournalLine[]
  state: { current: object; version: number; final: { orig: RunLite[]; last: RunLite[] } | 'none' }
  original: object
  split: Split
  sets: Record<SetName, string[]>
  harness: string
  versionFile: string
  /** The vN file on disk is not the text evolve wrote for the version measured (edited, replaced or gone). */
  changed?: boolean
  /** Which attempt this journal was (the start line's); 'unknown' when it says nothing. Absent: no line. */
  attempt?: number | 'unknown'
}

const leafOf = (o: unknown, f: string): unknown => f.split('.').reduce((x: any, k) => x?.[k], o)
const bySize = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
const count = (keys: string[]) => { const m = new Map<string, number>(); for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1); return m }
// Distinct tasks, not runs: with repeats one task failing 3 times is one task of the gate.
const fails = (rs: RunLite[]) => count([...new Set(rs.filter(r => r.verdict === 'FAIL').map(r => JSON.stringify([r.task, r.sig ?? '-|-|-|-'])))].map(k => JSON.parse(k)[1]))

const ONE_REASON: Record<string, string> = {
  'within noise': 'every refused candidate was within noise: more tasks that tell versions apart would let a real gain show',
  'costs more tokens': 'every refused candidate cost more than +10% tokens per success',
  'first request heavier': 'every refused candidate made the first request more than +25% heavier',
  'over tolerance: turns': 'every refused candidate took more turns than the original allows',
  'over tolerance: tokens': 'every refused candidate took more tokens on the tasks both pass than the original allows',
  'over tolerance: time': 'every refused candidate took more model time than the current version allows',
  'tied to a task': 'every refused candidate was tied to a task',
}
// Matched against a signature's reason or check part: failures no edit evolve may make can fix. max_turns is one only at the ceiling.
const KNOB: Record<string, string> = {
  parse_failed: 'the model\'s tool calls did not parse: check toolCalls by hand',
  check_timeout: 'the checks timed out: raise checkTimeoutS in lhb-tasks.json',
}

export function evolveReport(r: ReportInput): string {
  const { lines, state, split, sets, harness, versionFile } = r
  const version = state.version
  const cands = lines.flatMap(l => l.type === 'candidate' ? [l] : [])
  const accepted = cands.filter(l => l.accepted)
  const refused = count(cands.filter(l => !l.accepted).map(l => reasonKind(l.reason)))
  const onGate = (rs: RunLite[]) => rs.filter(x => sets.gate.includes(x.task))
  const sweeps = lines.flatMap(l => l.type === 'sweep' ? [l] : [])
  const before = fails(onGate(sweeps.filter(s => s.round === sweeps[0]!.round).flatMap(s => s.cur)))
  const kept = accepted[accepted.length - 1]
  const after = version ? fails(onGate(sweeps.filter(s => s.round === kept?.round).flatMap(s => s.cands.filter(c => c.index === kept?.index).flatMap(c => c.runs)))) : undefined
  const prompts = accepted.filter(l => l.edit?.field === 'systemPrompt')
  const final = state.final === 'none' ? undefined : state.final
  const told = final ? verdict(final.orig, final.last, split, (r.original as any).loop?.maxTurns ?? Infinity) : { better: false, lines: [] }
  // For polyglot the size is the journal's: train + gate + test.
  const bench = split.polyglot ? `--task polyglot --size ${split.trainGate + split.test}` : '--tasks <repo>'

  const conclusion: string[] = []
  const declared = `mode ${split.mode}, a winner can be declared: ${split.trainGate} train + gate tasks, ${split.test} test tasks`
  if (version && final) {
    const nums = (label: string, rs: RunLite[]) => {
      const n = numbersOf(rs)
      return `${label}: PASS ${n.pass}/${rs.length}, tokens per success ${n.tokensPerSuccess === undefined ? '—' : Math.round(n.tokensPerSuccess)}, first requests ${n.weight ?? '—'} tok`
    }
    conclusion.push(`${versionFile} against ${harness} on the ${sets.test.length} test tasks:`, nums('original', final.orig), nums(`v${version}`, final.last), ...told.lines)
    if (split.declarable) conclusion.splice(1, 0, declared)
  } else {
    conclusion.push('no version beat the original')
    conclusion.push(split.declarable ? declared : referenceLabel(split))
  }

  const why: string[] = []
  if (version) {
    for (const l of prompts) why.push('systemPrompt, appended (written by the proposer, passed the filters, not checked by a person):', showableText(String(l.edit!.value)).replace(/^/gm, '  '))
    for (const f of ALLOWED.filter(f => f !== 'systemPrompt')) {
      const a = leafOf(r.original, f), b = leafOf(state.current, f)
      if (a !== b) why.push(`${f}: ${a ?? '(unset)'} → ${b}`)
    }
    const drops = new Map([...before].flatMap(([s, n]) => (after!.get(s) ?? 0) < n ? [[s, n - (after!.get(s) ?? 0)] as [string, number]] : []))
    if (drops.size) why.push(`failures on the gate tasks, round 1 → v${version}:`, ...bySize(drops).map(([s]) => `  ${s}: ${before.get(s)} → ${after!.get(s) ?? 0}`))
  } else why.push('refused:', ...bySize(refused).map(([k, n]) => `  ${k}: ${n}`))

  const advice: string[] = []
  if (!split.declarable) {
    const [a, b] = shortOf(split)
    if (a && b) advice.push(`add ${a} tasks to train + gate and ${b} to test to declare a winner`)
    else if (a) advice.push(`add ${a} tasks to train + gate to declare a winner`)
    else if (b) advice.push(`add ${b} tasks to test to declare a winner`)
    if (orientationOnly(split.mode)) advice.push(WINNER_MODES)
  }
  if (cands.some(l => l.reason === 'the server gave no usage'))
    advice.push('the server gave no usage (token counts) for some runs, so those candidates could not pass the gates: use a server that reports them')
  const kinds = [...refused.keys()], nRefused = [...refused.values()].reduce((a, n) => a + n, 0)
  if (!version && nRefused >= 2 && kinds.length === 1) advice.push(ONE_REASON[kinds[0]!] ?? `every refused candidate: ${kinds[0]}`)
  const [top] = bySize(after ?? before), gateCount = new Set(sets.gate).size
  if (top && top[1] >= 2) {
    const [sig, n] = top, [reason, check] = sig.split('|')
    const mt = (o: unknown) => leafOf(o, 'loop.maxTurns') as number
    const hint = reason === 'max_turns' ? (mt(state.current) >= 2 * mt(r.original) ? 'loop.maxTurns is at its ceiling of 2× the original' : undefined) : KNOB[reason!] ?? KNOB[check!]
    if (hint) advice.push(`${sig} is still the biggest failure on the gate tasks (${n} of ${gateCount}): ${hint}`)
    if ((r.original as any).notes?.enabled !== true && n * 2 >= gateCount)
      advice.push(`the same failure (${sig}) recurs on ${n} of ${gateCount} gate tasks and Notes is off: Notes carry what one run learned into the next; compare with bench ${split.polyglot ? '--task polyglot' : '--tasks'}, Notes on and off`)
  }
  if (exhausted(lines).length === ALLOWED.length) advice.push('every field is exhausted')
  if (!advice.length) advice.push('none from these numbers')

  const apply: string[] = []
  if (!version) apply.push(`Keep ${harness}.`)
  else if (r.changed) apply.push(`Keep ${harness}: ${versionFile} on disk is not the version measured; it changed after evolve wrote it.`)
  else {
    if (told.better) apply.push(split.declarable ? `Use ${versionFile} in place of ${harness}.` : `Try ${versionFile} in place of ${harness}: a pointer, not proof.`)
    // Accepted on train + gate, not better on test: a candidate.
    else apply.push(`Keep ${harness}; ${versionFile} is a candidate, kept for reference.`)
    apply.push(`Check it yourself: llm-harness-builder bench ${versionFile} ${bench}`)
    if (prompts.length) apply.push('Read the systemPrompt paragraph above before you use it.')
  }
  if (r.attempt !== undefined) conclusion.push(`attempt ${r.attempt}`)

  return [
    '== Conclusion', ...conclusion, '',
    '== Why', ...why, '',
    '== Advice', ...advice.map(a => `- ${a}`), '',
    '== How to apply', ...apply.map((a, i) => `${i + 1}. ${a}`),
  ].join('\n')
}
