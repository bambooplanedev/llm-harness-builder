import { describe, expect, it } from 'vitest'
import { evolveReport, type ReportInput } from '../src/core/evolve-report.js'
import { applyEdit, referenceLabel, type Edit, type JournalLine, type Mode, type RunLite, type SetName } from '../src/core/evolve.js'

const fail = (task: string, sig: string, tokens = 110, fp = 100): RunLite => ({ task, verdict: 'FAIL', tokens, firstPromptTokens: fp, turns: 3, modelMs: 40, sig })
const pass = (task: string, tokens = 110, fp = 100): RunLite => ({ task, verdict: 'PASS', tokens, firstPromptTokens: fp, turns: 3, modelMs: 40 })
const CF = 'final|check_failed|-|-'
const cand = (index: number, edit: Edit, accepted: boolean, reason: string, runs?: RunLite[], version?: number): JournalLine =>
  ({ v: 2, type: 'candidate', round: 1, index, input: '{}', edit, accepted, reason, ...(runs ? { runs } : {}), ...(version ? { version } : {}) })

/** The journal as lines, and what replay would have made of them. */
function journalOf(o: { sets: Record<SetName, string[]>; mode: Mode; original: object; current: RunLite[]; cands: JournalLine[]; final?: { orig: RunLite[]; last: RunLite[] } }): ReportInput {
  let current = o.original, version = 0
  for (const l of o.cands) if (l.type === 'candidate' && l.accepted) { current = applyEdit(current, l.edit!); version++ }
  const lines: JournalLine[] = [
    { v: 2, type: 'start', base: 'h', sha: 's', pin: '0'.repeat(64), notes: '0'.repeat(64), sets: o.sets, strict: o.mode.strict, proposer: 'p' },
    { v: 2, type: 'current', round: 1, runs: o.current }, ...o.cands,
    { v: 2, type: 'final', version, ...(version ? o.final : {}) },
  ]
  return { lines, state: { current, version, final: version ? o.final! : 'none' }, original: o.original, mode: o.mode, sets: o.sets, harness: 'h.json', versionFile: version ? `harnesses/h.v${version}.json` : '' }
}

const EDIT: Edit = { field: 'systemPrompt', value: 'Make the file first.' }
function golden(over: { accepted?: JournalLine; refused?: JournalLine[]; afterGate?: RunLite[]; original?: object; mode?: Mode } = {}): ReportInput {
  return journalOf({
    sets: { train: ['t1', 't2'], gate: ['g1', 'g2'], test: ['x1', 'x2'] },
    mode: over.mode ?? { strict: false, trainGate: 4, test: 2 },
    original: over.original ?? { systemPrompt: 'S', loop: { maxTurns: 1 } },
    current: [fail('t1', 'max_turns|-|-|-'), fail('t2', 'max_turns|-|-|-'), fail('g1', CF), fail('g2', CF)],
    cands: [over.accepted ?? cand(1, EDIT, true, 'accepted', [pass('t1'), pass('t2'), ...(over.afterGate ?? [pass('g1'), fail('g2', CF)])], 1),
      ...(over.refused ?? [cand(2, { field: 'loop.maxRepeats', value: 3 }, false, 'no more PASS than current')])],
    final: { orig: [fail('x1', CF), pass('x2')], last: [pass('x1', 120, 105), pass('x2', 120, 105)] },
  })
}
const v0 = (refused?: JournalLine[]) => golden({ accepted: cand(1, EDIT, false, 'within noise (p=0.25)'), refused })

const GOLDEN = `== Conclusion
harnesses/h.v1.json against h.json on the 2 test tasks:
original: PASS 1/2, tokens per success 220, first requests 200 tok
v1: PASS 2/2, tokens per success 120, first requests 210 tok
${referenceLabel({ strict: false, trainGate: 4, test: 2 })}
more PASS
how far this is a principle rather than a fit depends on how unlike the training tasks the test tasks are

== Why
systemPrompt, appended (written by the proposer, passed the filters, not checked by a person):
  Make the file first.
failures on the gate tasks, round 1 → v1:
  final|check_failed|-|-: 2 → 1

== Advice
- add 12 tasks to train + gate and 6 to test for a strict verdict

== How to apply
1. Try harnesses/h.v1.json in place of h.json: a pointer, not proof (too few tasks).
2. Check it yourself: llm-harness-builder bench harnesses/h.v1.json --tasks <repo>
3. Read the systemPrompt paragraph above before you use it.`

/** 16 train + gate and 8 test: strict. `better` = every test task flips to PASS; otherwise nothing changes. */
function strictOf(better: boolean): ReportInput {
  const n = (p: string, k: number) => Array.from({ length: k }, (_, i) => `${p}${i}`)
  const sets = { train: n('t', 8), gate: n('g', 8), test: n('x', 8) }
  return journalOf({
    sets, mode: { strict: true, trainGate: 16, test: 8 }, original: {},
    current: [...sets.train, ...sets.gate].map(t => fail(t, CF)),
    cands: [cand(1, { field: 'loop.maxRepeats', value: 3 }, true, 'accepted', [...sets.train, ...sets.gate].map(t => pass(t)), 1)],
    final: { orig: sets.test.map(t => fail(t, CF)), last: sets.test.map(t => better ? pass(t) : fail(t, CF)) },
  })
}

describe('evolve report', () => {
  it('the golden report, word for word', () => {
    expect(evolveReport(golden())).toBe(GOLDEN)
  })

  it('accepted but not better on test is a candidate: keep the harness, the version is for reference', () => {
    const r = strictOf(true), f = r.state.final as { orig: RunLite[]; last: RunLite[] }
    // The same flips at x3 tokens: better on PASS, refused on cost.
    const dear = { ...r, state: { ...r.state, final: { ...f, last: f.last.map(x => ({ ...x, tokens: 300 })) } } }
    const out = evolveReport(dear)
    expect(out).toContain('not better: costs')
    expect(out).toContain('Keep h.json; harnesses/h.v1.json is a candidate, kept for reference.')
    expect(out).not.toContain('Use harnesses/h.v1.json')
    expect(evolveReport(r)).toContain('Use harnesses/h.v1.json in place of h.json.')
  })

  it('rule few tasks: absent in strict mode', () => {
    expect(evolveReport(golden())).toContain('- add 12 tasks')
    expect(evolveReport(strictOf(true))).not.toContain('- add ')
  })

  it("rule no usage: fires on a 'the server gave no usage' candidate, absent otherwise", () => {
    const line = '- the server gave no usage (token counts) for some runs, so those candidates could not pass the gates: use a server that reports them'
    expect(evolveReport(golden({ refused: [cand(2, { field: 'loop.maxRepeats', value: 3 }, false, 'the server gave no usage')] }))).toContain(line)
    expect(evolveReport(golden())).not.toContain('no usage')
  })

  it("rule one reason: fires on two 'within noise (p=…)' refusals with different p, absent on one refusal or two kinds", () => {
    const line = '- every refused candidate was within noise'
    expect(evolveReport(v0([cand(2, { field: 'loop.maxRepeats', value: 3 }, false, 'within noise (p=0.50)')]))).toContain(line)
    expect(evolveReport(v0([]))).not.toContain('every refused')
    expect(evolveReport(v0())).not.toContain('every refused')
  })

  it('rule knob outside evolve: fires when 2 gate runs after end max_turns, absent at 1', () => {
    const mt = 'max_turns|-|-|-'
    expect(evolveReport(golden({ afterGate: [fail('g1', mt), fail('g2', mt)] })))
      .toContain(`- ${mt} is still the biggest failure on the gate tasks (2 of 2): loop.maxTurns is not a field evolve edits: raise it by hand if the tasks need more turns`)
    expect(evolveReport(golden({ afterGate: [pass('g1'), fail('g2', mt)] }))).not.toContain('still the biggest')
  })

  it('cost reasons: a matched one prints as its kind, a hand-written one with an escape prints other', () => {
    const e = { field: 'loop.maxRepeats', value: 3 }
    const t = evolveReport(v0([cand(2, e, false, 'turns 3.0 → 6.0, allowed up to 4.0 (p=0.00)'), cand(3, e, false, 'time 1.0s → 2.0s, allowed up to 1.1s (p=0.00)\u001b[2J')]))
    expect(t).toContain('  over tolerance: turns: 1\n'); expect(t).toContain('  other: 1\n'); expect(t).not.toContain('\u001b')
  })

  it('gate failures count tasks, not runs: one task failing 3 times is 1 of 2', () => {
    const mt = 'max_turns|-|-|-'
    expect(evolveReport(golden({ afterGate: [fail('g1', mt), fail('g1', mt), fail('g1', mt), pass('g2')] }))).not.toContain('still the biggest')
  })

  it('rule notes: fires when Notes is off and the group covers half the gate, absent with notes.enabled true', () => {
    const afterGate = [fail('g1', CF), fail('g2', CF)]
    expect(evolveReport(golden({ afterGate })))
      .toContain(`- the same failure (${CF}) recurs on 2 of 2 gate tasks and Notes is off: Notes carry what one run learned into the next; compare with bench --tasks, Notes on and off`)
    expect(evolveReport(golden({ afterGate, original: { systemPrompt: 'S', notes: { enabled: true } } }))).not.toContain('Notes is off')
  })

  it("no rule fires → '- none from these numbers'", () => {
    expect(evolveReport(strictOf(true))).toContain('== Advice\n- none from these numbers\n')
  })

  it('version 0: no version beat the original, refused counts, Keep h.json', () => {
    const t = evolveReport(v0())
    for (const s of ['no version beat the original', 'refused:', '  within noise: 1', '  no more PASS than current: 1', '1. Keep h.json.']) expect(t).toContain(s)
    expect(t).not.toContain('Check it yourself')
  })

  it('strict better says Use, strict noise says Keep', () => {
    expect(evolveReport(strictOf(true))).toContain('1. Use harnesses/h.v1.json in place of h.json.')
    expect(evolveReport(strictOf(false))).toContain('1. Keep h.json; harnesses/h.v1.json is a candidate, kept for reference.')
  })

  it('the report says when vN on disk is not the version measured', () => {
    const t = evolveReport({ ...strictOf(true), changed: true })
    expect(t).toContain('harnesses/h.v1.json on disk is not the version measured')
    expect(t).not.toContain('Use harnesses/h.v1.json')
    expect(evolveReport({ ...strictOf(true), changed: false })).toBe(evolveReport(strictOf(true)))
  })

  it('strict mode is named in the Conclusion, right after the against line or the no-version line', () => {
    expect(evolveReport(strictOf(true))).toContain('test tasks:\nstrict mode: 16 train + gate tasks, 8 test tasks\noriginal: ')
    const t = evolveReport(golden({ accepted: cand(1, EDIT, false, 'within noise (p=0.25)'), mode: { strict: true, trainGate: 4, test: 2 } }))
    expect(t).toContain('no version beat the original\nstrict mode: 4 train + gate tasks, 2 test tasks\n')
    expect(evolveReport(golden())).not.toContain('strict mode:')
  })

  it('nothing but the labelled paragraph leaks', () => {
    // A task name in each set, every run's free text: none of it may reach an output path.
    const mark = (x: ReportInput) => {
      const to: Record<string, string> = { t1: 'MARKtrain', g1: 'MARKgate', x1: 'MARKtest' }
      for (const s of Object.values(x.sets)) for (const [i, t] of s.entries()) s[i] = to[t] ?? t
      for (const l of x.lines) for (const r of l.type === 'current' || l.type === 'candidate' ? l.runs ?? [] : l.type === 'final' ? [...l.orig ?? [], ...l.last ?? []] : []) {
        r.task = to[r.task] ?? r.task
        Object.assign(r, { lastError: 'MARK', trace: 'MARK', reason: 'MARK' })
      }
      return evolveReport(x)
    }
    const v1 = mark(golden({
      accepted: cand(1, { ...EDIT, why: 'MARK' }, true, 'accepted', [pass('t1'), pass('t2'), pass('g1'), fail('g2', CF)], 1),
      refused: [cand(2, { field: 'systemPrompt', value: 'MARK' }, false, 'tied to a task'), cand(3, { field: 'loop.maxRepeats', value: 3 }, false, 'MARK reason'),
        cand(4, { field: 'loop.maxRepeats', value: 4 }, false, 'invalid config: MARK')],
    }))
    expect(v1).not.toContain('MARK')
    // Version 0 prints the refused kinds and rule 3; one kind, so its fallback sentence is the one printed.
    const v0t = mark(golden({ accepted: cand(1, { ...EDIT, why: 'MARK' }, false, 'invalid config: MARK one'),
      refused: [cand(2, { field: 'loop.maxRepeats', value: 3 }, false, 'invalid config: MARK two')] }))
    expect(v0t).toContain('  invalid config: 2')
    expect(v0t).toContain('- every refused candidate: invalid config')
    expect(v0t).not.toContain('MARK')
  })

  it('rule few tasks: only train + gate short, only test short', () => {
    expect(evolveReport(golden({ mode: { strict: false, trainGate: 4, test: 8 } }))).toContain('- add 12 tasks to train + gate for a strict verdict\n')
    expect(evolveReport(golden({ mode: { strict: false, trainGate: 16, test: 2 } }))).toContain('- add 6 tasks to test for a strict verdict\n')
  })

  it('rule knob outside evolve: fires on the check part', () => {
    const ct = 'final|check_timeout|-|-'
    expect(evolveReport(golden({ afterGate: [fail('g1', ct), fail('g2', ct)] })))
      .toContain(`- ${ct} is still the biggest failure on the gate tasks (2 of 2): the checks timed out: raise checkTimeoutS in lhb-tasks.json`)
  })

  it('rule notes: at version 0 it reads round 1; fires at half the gate, not below', () => {
    expect(evolveReport(v0())).toContain(`- the same failure (${CF}) recurs on 2 of 2 gate tasks and Notes is off`)
    const gate = (n: number, failing: number) => {
      const g = Array.from({ length: n }, (_, i) => `g${i}`)
      return evolveReport(journalOf({
        sets: { train: ['t1'], gate: g, test: ['x1'] }, mode: { strict: false, trainGate: n + 1, test: 1 }, original: {},
        current: [pass('t1'), ...g.map((t, i) => i < failing ? fail(t, CF) : pass(t))],
        cands: [cand(1, EDIT, false, 'no more PASS than current')],
      }))
    }
    expect(gate(4, 2)).toContain('recurs on 2 of 4 gate tasks')
    expect(gate(4, 1)).not.toContain('Notes is off')
    expect(gate(5, 2)).not.toContain('Notes is off')
  })

  it('the same input gives the same text', () => {
    const x = golden()
    expect(evolveReport(x)).toBe(evolveReport(structuredClone(x)))
  })
})
