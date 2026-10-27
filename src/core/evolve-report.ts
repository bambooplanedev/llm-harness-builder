// What an evolve run comes to, from its journal: conclusion, why, advice, how to apply.
// Pure — no fs, no process, no clock — so the same journal prints the same text at the end of a run and on `--report`.
// Every line is a fixed template filled with numbers and fixed words (verdicts, `sig`, `reasonKind`, ALLOWED fields);
// the only free text is the accepted systemPrompt paragraphs, labelled as the proposer's. Never task names, paths,
// lastError, trace, why or a run's reason.
import { ALLOWED, MIN_TEST, MIN_TRAIN_GATE, numbersOf, reasonKind, referenceLabel, STRICT_SIZE, verdict, type JournalLine, type Mode, type RunLite, type SetName } from './evolve.js'
import { showableText } from './events.js'

export type ReportInput = {
  lines: JournalLine[]
  state: { current: object; version: number; final: { orig: RunLite[]; last: RunLite[] } | 'none' }
  original: object
  mode: Mode
  sets: Record<SetName, string[]>
  harness: string
  versionFile: string
  /** The vN file on disk is not the text evolve wrote for the version measured (edited, replaced or gone). */
  changed?: boolean
}

const leafOf = (o: unknown, f: string): unknown => f.split('.').reduce((x: any, k) => x?.[k], o)
const bySize = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
const count = (keys: string[]) => { const m = new Map<string, number>(); for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1); return m }
const fails = (rs: RunLite[]) => count(rs.filter(r => r.verdict === 'FAIL').map(r => r.sig ?? '-|-|-|-'))

const ONE_REASON: Record<string, string> = {
  'within noise': 'every refused candidate was within noise: more tasks that tell versions apart would let a real gain show',
  'costs more tokens': 'every refused candidate cost more than +10% tokens per success',
  'first request heavier': 'every refused candidate made the first request more than +25% heavier',
  'tied to a task': 'every refused candidate was tied to a task',
}
// Matched against a signature's reason or check part: failures no edit evolve may make can fix.
const KNOB: Record<string, string> = {
  max_turns: 'loop.maxTurns is not a field evolve edits: raise it by hand if the tasks need more turns',
  parse_failed: 'the model\'s tool calls did not parse: check toolCalls by hand',
  check_timeout: 'the checks timed out: raise checkTimeoutS in lhb-tasks.json',
}

export function evolveReport(r: ReportInput): string {
  const { lines, state, mode, sets, harness, versionFile } = r
  const version = state.version
  const cands = lines.flatMap(l => l.type === 'candidate' ? [l] : [])
  const accepted = cands.filter(l => l.accepted)
  const refused = count(cands.filter(l => !l.accepted).map(l => reasonKind(l.reason)))
  const onGate = (rs: RunLite[]) => rs.filter(x => sets.gate.includes(x.task))
  const before = fails(onGate(lines.flatMap(l => l.type === 'current' && l.round === 1 ? l.runs : [])))
  const after = version ? fails(onGate(accepted[accepted.length - 1]?.runs ?? [])) : undefined
  const prompts = accepted.filter(l => l.edit?.field === 'systemPrompt')
  const final = state.final === 'none' ? undefined : state.final
  const told = final ? verdict(final.orig, final.last, mode) : ''
  // For polyglot the size is the journal's: train + gate + test.
  const bench = mode.polyglot ? `--task polyglot --size ${mode.trainGate + mode.test}` : '--tasks <repo>'

  const conclusion: string[] = []
  const strictLine = `strict mode: ${mode.trainGate} train + gate tasks, ${mode.test} test tasks`
  if (version && final) {
    const nums = (label: string, rs: RunLite[]) => {
      const n = numbersOf(rs)
      return `${label}: PASS ${n.pass}/${rs.length}, tokens per success ${n.tokensPerSuccess === undefined ? '—' : Math.round(n.tokensPerSuccess)}, first requests ${n.weight ?? '—'} tok`
    }
    conclusion.push(`${versionFile} against ${harness} on the ${sets.test.length} test tasks:`, nums('original', final.orig), nums(`v${version}`, final.last), told)
    if (mode.strict) conclusion.splice(1, 0, strictLine)
  } else {
    conclusion.push('no version beat the original')
    if (mode.strict) conclusion.push(strictLine)
    if (!mode.strict) conclusion.push(referenceLabel(mode))
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
  if (!mode.strict && mode.polyglot) advice.push(`raise --size to ${STRICT_SIZE} for a strict verdict`)
  else if (!mode.strict) {
    const a = Math.max(0, MIN_TRAIN_GATE - mode.trainGate), b = Math.max(0, MIN_TEST - mode.test)
    if (a && b) advice.push(`add ${a} tasks to train + gate and ${b} to test for a strict verdict`)
    else if (a) advice.push(`add ${a} tasks to train + gate for a strict verdict`)
    else if (b) advice.push(`add ${b} tasks to test for a strict verdict`)
  }
  if (cands.some(l => l.reason === 'the server gave no usage'))
    advice.push('the server gave no usage (token counts) for some runs, so those candidates could not pass the gates: use a server that reports them')
  const kinds = [...refused.keys()], nRefused = [...refused.values()].reduce((a, n) => a + n, 0)
  if (!version && nRefused >= 2 && kinds.length === 1) advice.push(ONE_REASON[kinds[0]!] ?? `every refused candidate: ${kinds[0]}`)
  const [top] = bySize(after ?? before), gateCount = sets.gate.length
  if (top && top[1] >= 2) {
    const [sig, n] = top, [reason, check] = sig.split('|')
    const hint = KNOB[reason!] ?? KNOB[check!]
    if (hint) advice.push(`${sig} is still the biggest failure on the gate tasks (${n} of ${gateCount}): ${hint}`)
    if ((r.original as any).notes?.enabled !== true && n * 2 >= gateCount)
      advice.push(`the same failure (${sig}) recurs on ${n} of ${gateCount} gate tasks and Notes is off: Notes carry what one run learned into the next; compare with bench ${mode.polyglot ? '--task polyglot' : '--tasks'}, Notes on and off`)
  }
  if (!advice.length) advice.push('none from these numbers')

  const apply: string[] = []
  const said = told.split('\n')
  if (!version) apply.push(`Keep ${harness}.`)
  else if (r.changed) apply.push(`Keep ${harness}: ${versionFile} on disk is not the version measured; it changed after evolve wrote it.`)
  else {
    if (mode.strict && said[0]!.startsWith('better ')) apply.push(`Use ${versionFile} in place of ${harness}.`)
    else if (!mode.strict && said.includes('more PASS')) apply.push(`Try ${versionFile} in place of ${harness}: a pointer, not proof (too few tasks).`)
    else apply.push(`Keep ${harness}; ${versionFile} is kept for reference.`)
    apply.push(`Check it yourself: llm-harness-builder bench ${versionFile} ${bench}`)
    if (prompts.length) apply.push('Read the systemPrompt paragraph above before you use it.')
  }

  return [
    '== Conclusion', ...conclusion, '',
    '== Why', ...why, '',
    '== Advice', ...advice.map(a => `- ${a}`), '',
    '== How to apply', ...apply.map((a, i) => `${i + 1}. ${a}`),
  ].join('\n')
}
