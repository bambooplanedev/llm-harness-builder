import { describe, expect, it } from 'vitest'
import { evolveReport, type ReportInput } from '../src/core/evolve-report.js'
import { outcomeOf } from '../src/core/evolve-labels.js'
import { ALLOWED, applyEdit, referenceLabel, type Edit, type JournalLine, type Split, type RunLite, type SetName } from '../src/core/evolve.js'

const fail = (task: string, sig: string, tokens = 110, fp = 100): RunLite => ({ task, verdict: 'FAIL', tokens, firstPromptTokens: fp, turns: 3, modelMs: 40, sig })
const pass = (task: string, tokens = 110, fp = 100): RunLite => ({ task, verdict: 'PASS', tokens, firstPromptTokens: fp, turns: 3, modelMs: 40 })
const CF = 'final|check_failed|-|-'
type Said = JournalLine & { runs?: RunLite[] }
/** `runs` go into the sweep line journalOf writes; the candidate line itself holds none. */
const cand = (index: number, edit: Edit, accepted: boolean, reason: string, runs?: RunLite[], version?: number): Said =>
  ({ v: 2, type: 'candidate', round: 1, index, input: '{}', edit, accepted, reason, ...(runs ? { runs } : {}), ...(version ? { version } : {}) })

/** The journal as lines, and what replay would have made of them. */
function journalOf(o: { sets: Record<SetName, string[]>; split: Split; original: object; current: RunLite[]; cands: Said[]; final?: { orig: RunLite[]; last: RunLite[] } }): ReportInput {
  let current = o.original, version = 0
  for (const l of o.cands) if (l.type === 'candidate' && l.accepted) { current = applyEdit(current, l.edit!); version++ }
  const lines: JournalLine[] = [
    { v: 2, type: 'start', base: 'h', sha: 's', pin: '0'.repeat(64), notes: '0'.repeat(64), sets: o.sets, declarable: o.split.declarable, mode: o.split.mode, proposer: 'p', repeats: 1, rounds: 1 },
    { v: 2, type: 'sweep', round: 1, sweep: 1, cur: o.current, cands: o.cands.flatMap(c => c.type === 'candidate' && c.runs ? [{ index: c.index, runs: c.runs }] : []) },
    ...o.cands.map(({ runs: _, ...c }: any) => c as JournalLine),
    { v: 2, type: 'testsweep', sweep: 1, ...(version ? o.final! : { orig: [], last: [] }) },
    { v: 2, type: 'final', version },
  ]
  return { lines, state: { current, version, final: version ? o.final! : 'none' }, original: o.original, split: o.split, sets: o.sets, harness: 'h.json', versionFile: version ? `harnesses/h.v${version}.json` : '' }
}

const EDIT: Edit = { field: 'systemPrompt', value: 'Make the file first.' }
function golden(over: { accepted?: Said; refused?: Said[]; afterGate?: RunLite[]; original?: object; split?: Split } = {}): ReportInput {
  return journalOf({
    sets: { train: ['t1', 't2'], gate: ['g1', 'g2'], test: ['x1', 'x2'] },
    split: over.split ?? { declarable: false, mode: 'custom', trainGate: 4, test: 2 },
    original: over.original ?? { systemPrompt: 'S', loop: { maxTurns: 1 } },
    current: [fail('t1', 'max_turns|-|-|-'), fail('t2', 'max_turns|-|-|-'), fail('g1', CF), fail('g2', CF)],
    cands: [over.accepted ?? cand(1, EDIT, true, 'accepted', [pass('t1'), pass('t2'), ...(over.afterGate ?? [pass('g1'), fail('g2', CF)])], 1),
      ...(over.refused ?? [cand(2, { field: 'loop.maxRepeats', value: 3 }, false, 'no more PASS than current')])],
    final: { orig: [fail('x1', CF), pass('x2')], last: [pass('x1', 120, 105), pass('x2', 120, 105)] },
  })
}
const v0 = (refused?: Said[]) => golden({ accepted: cand(1, EDIT, false, 'within noise (p=0.25)'), refused })

const GOLDEN = `== Conclusion
harnesses/h.v1.json against h.json on the 2 test tasks:
original: PASS 1/2, tokens per success 220, first requests 200 tok
v1: PASS 2/2, tokens per success 120, first requests 210 tok
${referenceLabel({ declarable: false, mode: 'custom', trainGate: 4, test: 2 })}
more PASS
how far this is a principle rather than a fit depends on how unlike the training tasks the test tasks are

== Why
systemPrompt, appended (written by the proposer, passed the filters, not checked by a person):
  Make the file first.
failures on the gate tasks, round 1 → v1:
  final|check_failed|-|-: 2 → 1
refused:
  no more PASS than current: 1

== Advice
- add 12 tasks to train + gate and 6 to test to declare a winner
- --mode night or days declares a winner

== How to apply
1. Try harnesses/h.v1.json in place of h.json: a pointer, not proof.
2. Check it yourself: llm-harness-builder bench harnesses/h.v1.json --tasks <repo>
3. Read the systemPrompt paragraph above before you use it.

outcome: try`

/** 16 train + gate and 8 test: strict. `better` = every test task flips to PASS; otherwise nothing changes. */
function strictOf(better: boolean): ReportInput {
  const n = (p: string, k: number) => Array.from({ length: k }, (_, i) => `${p}${i}`)
  const sets = { train: n('t', 8), gate: n('g', 8), test: n('x', 8) }
  return journalOf({
    sets, split: { declarable: true, mode: 'night', trainGate: 16, test: 8 }, original: {},
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

  it('advice names the mode that declares; hours with enough tasks never says Use', () => {
    const hours = { ...strictOf(true), split: { declarable: false, mode: 'hours', trainGate: 16, test: 8 } as const }
    const t = evolveReport(hours)
    expect(t).toContain('- --mode night or days declares a winner\n')
    expect(t).not.toContain('- add ')
    expect(t).toContain('1. Try harnesses/h.v1.json in place of h.json: a pointer, not proof.')
    expect(t).not.toContain('raise --size')
    expect(evolveReport({ ...hours, split: { declarable: false, mode: 'custom', trainGate: 2, test: 1, polyglot: true } })).not.toContain('- add ')
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

  it('rule knob at its ceiling: the max_turns hint shows only when loop.maxTurns is at 2× the original', () => {
    const mt = 'max_turns|-|-|-', afterGate = [fail('g1', mt), fail('g2', mt)]
    const at = (cur: number) => evolveReport({ ...golden({ afterGate, original: { systemPrompt: 'S', loop: { maxTurns: 1 } } }), state: { current: { systemPrompt: 'S', loop: { maxTurns: cur } }, version: 1, final: golden().state.final } as any })
    expect(at(2)).toContain(`- ${mt} is still the biggest failure on the gate tasks (2 of 2): loop.maxTurns is at its ceiling of 2× the original`)
    expect(at(1)).not.toContain('still the biggest')
  })

  it('rule knob: absent when loop.maxTurns is below its ceiling, or at 1 max_turns', () => {
    const mt = 'max_turns|-|-|-'
    expect(evolveReport(golden({ afterGate: [fail('g1', mt), fail('g2', mt)] })))
      .not.toContain('still the biggest')
    expect(evolveReport(golden({ afterGate: [pass('g1'), fail('g2', mt)] }))).not.toContain('still the biggest')
  })

  it('cost reasons: a matched one prints as its kind, a hand-written one with an escape prints other', () => {
    const e = { field: 'loop.maxRepeats', value: 3 }
    const t = evolveReport(v0([cand(2, e, false, 'turns 3.0 → 6.0, allowed up to 4.0 (p=0.00)'), cand(3, e, false, 'time 1.0s → 2.0s, allowed up to 1.1s (p=0.00)\u001b[2J')]))
    expect(t).toContain('  turns 3.0 → 6.0, allowed up to 4.0 (p=0.00): 1\n'); expect(t).toContain('  other: 1\n'); expect(t).not.toContain('\u001b')
  })

  it('refusal kinds are listed when a version exists too; a version with none lists nothing', () => {
    const t = evolveReport(golden({ refused: [cand(2, { field: 'loop.maxRepeats', value: 3 }, false, 'costs 40% more tokens per success than the original')] }))
    expect(t).toContain('refused:\n  costs 40% more tokens per success than the original: 1\n')
    expect(evolveReport(golden({ refused: [] }))).not.toContain('refused:')
  })

  it('every refusal cost the same way: the advice still goes by the kind', () => {
    const e = { field: 'loop.maxRepeats', value: 3 }
    const t = evolveReport(golden({ accepted: cand(1, EDIT, false, 'turns 3.0 → 7.0, allowed up to 4.0 (p=0.00)'), refused: [cand(2, e, false, 'turns 3.0 → 6.0, allowed up to 4.0 (p=0.00)')] }))
    expect(t).toContain('every refused candidate took more turns than the original allows')
  })

  it('test sweeps started: printed only when it differs from the repeats', () => {
    const rep = (testStarts?: number) => evolveReport({ ...golden(), testStarts })
    expect(rep(1)).not.toContain('test sweeps started')
    expect(rep(undefined)).not.toContain('test sweeps started')
    expect(rep(3)).toContain('test sweeps started: 3 of 1\n')
  })

  it('the outcome is the last line and follows the apply step', () => {
    const decl = { declarable: true, mode: 'night', trainGate: 4, test: 2 } as Split
    expect(outcomeOf(evolveReport(golden()))).toBe('try')
    expect(evolveReport(golden())).toContain('1. Try ')
    expect(outcomeOf(evolveReport({ ...golden(), changed: true }))).toBe('keep')
    expect(outcomeOf(evolveReport(v0()))).toBe('keep')
    const j = golden({ split: decl }), many = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6']
    const won = { ...j, sets: { ...j.sets, test: many }, state: { ...j.state, final: { orig: many.map(t => fail(t, CF)), last: many.map(t => pass(t)) } } }
    expect(evolveReport(won)).toContain('1. Use ')
    expect(outcomeOf(evolveReport(won))).toBe('use')
    const lost = { ...won, state: { ...won.state, final: { orig: many.map(t => pass(t)), last: many.map(t => pass(t)) } } }
    expect(evolveReport(lost)).toContain('is a candidate')
    expect(outcomeOf(evolveReport(lost))).toBe('keep')
    // The paragraph is the proposer's; it cannot speak for the outcome.
    expect(outcomeOf('outcome: use\n  1. Use\n\noutcome: keep')).toBe('keep')
    expect(outcomeOf('  outcome: use')).toBeUndefined()
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

  it('a declarable mode is named in the Conclusion, right after the against line or the no-version line', () => {
    expect(evolveReport(strictOf(true))).toContain('test tasks:\nmode night, a winner can be declared: 16 train + gate tasks, 8 test tasks\noriginal: ')
    const t = evolveReport(golden({ accepted: cand(1, EDIT, false, 'within noise (p=0.25)'), split: { declarable: true, mode: 'night', trainGate: 4, test: 2 } }))
    expect(t).toContain('no version beat the original\nmode night, a winner can be declared: 4 train + gate tasks, 2 test tasks\n')
    expect(evolveReport(golden())).not.toContain('a winner can be declared')
  })

  it('nothing but the labelled paragraph leaks', () => {
    // A task name in each set, every run's free text: none of it may reach an output path.
    const mark = (x: ReportInput) => {
      const to: Record<string, string> = { t1: 'MARKtrain', g1: 'MARKgate', x1: 'MARKtest' }
      for (const s of Object.values(x.sets)) for (const [i, t] of s.entries()) s[i] = to[t] ?? t
      for (const l of x.lines) for (const r of l.type === 'sweep' ? [...l.cur, ...l.cands.flatMap(c => c.runs)] : l.type === 'testsweep' ? [...l.orig, ...l.last] : []) {
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
    expect(evolveReport(golden({ split: { declarable: false, mode: 'night', trainGate: 4, test: 8 } }))).toContain('- add 12 tasks to train + gate to declare a winner\n')
    expect(evolveReport(golden({ split: { declarable: false, mode: 'night', trainGate: 16, test: 2 } }))).toContain('- add 6 tasks to test to declare a winner\n')
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
        sets: { train: ['t1'], gate: g, test: ['x1'] }, split: { declarable: false, mode: 'night', trainGate: n + 1, test: 1 }, original: {},
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

describe('every field exhausted', () => {
  const refuse = (field: string): JournalLine => ({ v: 2, type: 'candidate', round: 2, index: 1, input: '{}', edit: { field, value: 1 }, accepted: false, reason: 'bad value' })
  it('is a line of the report when the journal closes every field, and only then', () => {
    const g = v0()
    expect(evolveReport(g)).not.toContain('every field is exhausted')
    // v0 has refused the systemPrompt once and loop.maxRepeats once: one more each, and the rest twice
    const more = ALLOWED.flatMap(f => f === 'systemPrompt' || f === 'loop.maxRepeats' ? [refuse(f)] : [refuse(f), refuse(f)])
    expect(evolveReport({ ...g, lines: [...g.lines.slice(0, -2), ...more, ...g.lines.slice(-2)] })).toContain('every field is exhausted')
  })
})
