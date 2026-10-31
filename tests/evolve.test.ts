import { describe, expect, it } from 'vitest'
import { ALPHA, boundBy, applyEdit, numbersOf, usable, parseJournal, replay, verdict, bindingTokens, checkEdit, decide, passGain, failureGroups, reasonKind, signatureOf, SIG, modeOf, neededFlips, parseProposal, proposerInput, proposerRequest, referenceLabel, signP, splitSets, PROPOSAL_SCHEMA, type Edit, type Mode, type RunLite } from '../src/core/evolve.js'
import type { HarnessEvent } from '../src/core/events.js'
import { harness } from './helpers.js'
import type { RepoTask } from '../src/core/repo-tasks.js'
import { loadPolyglot, polyglotBinding } from '../src/core/polyglot.js'

const task = (name: string, set?: RepoTask['set']): RepoTask => ({ name, prompt: 'p', check: 'c', set, checkTimeoutS: 60 })
const run = (t: string, ok: boolean, tokens = 100, fp = 10): RunLite => ({ task: t, verdict: ok ? 'PASS' : 'FAIL', tokens, firstPromptTokens: fp, turns: 3, modelMs: 40 })
const names = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`)
const strict: Mode = { strict: true, trainGate: 16, test: 8 }
const ref: Mode = { strict: false, trainGate: 2, test: 1 }
const dec = (cur: RunLite[], cand: RunLite[], orig: RunLite[], gateNames: string[], mode: Mode, origMaxTurns = 10) => decide({ cur, cand, orig, gateNames, mode, origMaxTurns })

describe('evolve sets and tests', () => {
  it('splitSets: set in the file wins, the rest by sha1 of the name, stable', () => {
    // first byte of sha1 mod 4: eps 1, zeta 1 (train); alpha 2, beta 2 (gate); gamma 3, delta 3 (test)
    const ts = ['eps', 'zeta', 'alpha', 'beta', 'gamma', 'delta'].map(n => task(n))
    expect(splitSets(ts)).toEqual({ train: ['eps', 'zeta'], gate: ['alpha', 'beta'], test: ['gamma', 'delta'] })
    ts[0] = task('eps', 'test')
    expect(splitSets(ts)).toEqual({ train: ['zeta'], gate: ['alpha', 'beta'], test: ['eps', 'gamma', 'delta'] })
  })

  it('modeOf: 16+8 strict, 1+1+1 reference with N and M in the label, an empty set refused', () => {
    const sets = (t: number, g: number, x: number) => ({ train: names(t), gate: names(g), test: names(x) })
    expect(modeOf(sets(10, 6, 8))).toEqual({ strict: true, trainGate: 16, test: 8 })
    expect(modeOf(sets(10, 6, 7))).toMatchObject({ strict: false })
    const m = modeOf(sets(1, 1, 1)) as Mode
    expect(m.strict).toBe(false)
    expect(referenceLabel(m)).toBe('\u041e\u0420\u0406\u0404\u041d\u0422\u0418\u0420, \u041d\u0415 \u0414\u041e\u041a\u0410\u0417 \u2014 too few tasks (3 of 24) for a statistical conclusion; add 21 more tasks')
    expect(modeOf(sets(0, 3, 3))).toBe('evolve needs at least one task in each of train, gate and test (have 0/3/3)')
  })

  it('signP: (5,0) < 0.05, (4,0) = 0.0625, (5,1) > 0.05, (0,0) = 1', () => {
    expect(signP(5, 0)).toBeLessThan(ALPHA)
    expect(signP(4, 0)).toBe(0.0625)
    expect(signP(5, 1)).toBeGreaterThan(ALPHA)
    expect(signP(0, 0)).toBe(1)
    expect(neededFlips()).toBe(5)
  })
})

describe('evolve decide: repeats, the one PASS test, the cost gates', () => {
  const T = names(16), gate = T.slice(12)
  const rep = (t: string, oks: boolean[], o: Partial<RunLite> = {}): RunLite[] => oks.map((ok, repeat) => ({ ...run(t, ok), repeat, ...o }))
  it('three repeats per task do not overwrite each other', () => {
    const cur = T.flatMap(t => rep(t, [false, false, false]))
    const cand = T.flatMap((t, i) => rep(t, i < 5 ? [true, true, true] : [false, false, false]))
    expect(passGain(cur, cand).improved).toBe(5)
    expect(dec(cur, cand, cur, gate, strict)).toMatchObject({ accepted: true, numbers: { pass: 15 } })
    // a pass in one repeat of a task counts for that task alone
    expect(passGain(cur, T.flatMap((t, i) => rep(t, [i === 0, i === 0, false])))).toMatchObject({ improved: 1 })
  })
  it('one task 4/4 against 0/4 passes the p but is within noise: improved is 1, 5 are needed', () => {
    const cur = T.flatMap(t => rep(t, [false, false, false, false]))
    const cand = T.flatMap((t, i) => rep(t, [i === 0, i === 0, i === 0, i === 0]))
    const g = passGain(cur, cand)
    expect(g.p).toBeLessThan(ALPHA); expect(g.improved).toBe(1)
    expect(dec(cur, cand, cur, gate, strict)).toMatchObject({ accepted: false, reason: 'within noise (p=0.01)' })
  })
  it('more PASS at 3x tokens per success: refused by the all-tokens gate', () => {
    const cur = T.map(t => run(t, false))
    const orig = T.map((t, i) => run(t, i < 2, 100))
    expect(dec(cur, T.map((t, i) => run(t, i < 5, 300)), orig, gate, strict)).toMatchObject({ accepted: false, reason: expect.stringMatching(/^costs \d+% more tokens per success than the original$/) })
  })
  it('under 5 shared tasks the all-tokens gate alone decides: 4 shared passes, turns over tolerance within the cap, accepted', () => {
    const ts = ['a', 'b', 'c', 'd']
    const cur = ts.map(t => run(t, false)), orig = ts.map(t => run(t, true))
    const cand = ts.map((t): RunLite => ({ ...run(t, true), turns: 6 })) // 3 -> 6: past +1, inside the cap of 10
    expect(dec(cur, cand, orig, [], ref)).toMatchObject({ accepted: true })
    // one more shared task and the same turns are refused: the skip is the MIN_SHARED rule, not a blind spot
    const five = [...ts, 'e']
    expect(dec(five.map(t => run(t, false)), five.map((t): RunLite => ({ ...run(t, true), turns: 6 })), five.map(t => run(t, true)), [], ref).reason).toMatch(/^turns /)
  })
  it('a 0-PASS original and a 5-PASS candidate can be accepted', () => {
    const cur = T.map(t => run(t, false))
    expect(dec(cur, T.map((t, i) => run(t, i < 5)), cur, gate, strict)).toMatchObject({ accepted: true })
  })
  it('turns and tokens against the original, time against the current: cur and orig differ in all three, so a swapped base flips each refusal', () => {
    const R: Mode = { strict: false, trainGate: 16, test: 8 }
    // orig: turns 3, 100 tokens, 5 s; cur: turns 8, 400 tokens, 1 s. The dear original failures keep its tokens per success high.
    const orig = T.map((t, i) => ({ ...run(t, i < 10, i < 10 ? 100 : 1000), modelMs: 5000 }))
    const cur = T.map((t, i) => ({ ...run(t, i < 10, 400), turns: 8, modelMs: 1000 }))
    const cand = (o: Partial<RunLite>) => T.map(t => ({ ...run(t, true), modelMs: 1000, ...o }))
    expect(dec(cur, cand({}), orig, gate, R).accepted).toBe(true)
    const turns = dec(cur, cand({ turns: 6 }), orig, gate, R) // 6 against the original's 3; against the current's 8 it would be fine
    expect(turns.reason).toBe('turns 3.0 → 6.0, allowed up to 4.0 (p=0.00)'); expect(reasonKind(turns.reason)).toBe('over tolerance: turns')
    const tokens = dec(cur, cand({ tokens: 200 }), orig, gate, R) // 200 against 100; against 400 it would be fine
    expect(tokens.reason).toBe('tokens 100 → 200, allowed up to 110 (p=0.00)'); expect(reasonKind(tokens.reason)).toBe('over tolerance: tokens')
    const time = dec(cur, cand({ modelMs: 2000 }), orig, gate, R) // 2 s against the current's 1 s; against the original's 5 s it would be fine
    expect(time.reason).toBe('time 1.0s → 2.0s, allowed up to 1.1s (p=0.00)'); expect(reasonKind(time.reason)).toBe('over tolerance: time')
  })
  it('candidate passes past origMaxTurns on shared tasks are a new win, not a dearer harness: accepted through decide', () => {
    const orig = T.map(t => run(t, true)), cur = T.map((t, i) => run(t, i < 10))
    const cand = T.map((t): RunLite => ({ ...run(t, true), turns: 20 }))
    expect(decide({ cur, cand, orig, gateNames: gate, mode: ref, origMaxTurns: 10 }).accepted).toBe(true)
    expect(decide({ cur, cand, orig, gateNames: gate, mode: ref, origMaxTurns: 30 }).reason).toBe('turns 3.0 → 20.0, allowed up to 4.0 (p=0.00)')
  })
  it('strict: 5 tasks up and 3 down is within noise on the p, though improved reaches the 5', () => {
    const cur = T.map((t, i) => run(t, i >= 5 && i < 8)), cand = T.map((t, i) => run(t, i < 5))
    expect(passGain(cur, cand).improved).toBe(5)
    expect(dec(cur, cand, cur, gate, strict)).toMatchObject({ accepted: false, reason: expect.stringMatching(/^within noise \(p=0\.\d\d\)$/) })
    expect(passGain(cur, cand).p).toBeGreaterThan(ALPHA)
  })
  it('first request not measured counts tasks, not runs, over repeats', () => {
    const o = ['a', 'b', 'c'].flatMap(t => rep(t, [false, false], { firstPromptTokens: 50 }))
    const noReply = (t: string) => rep(t, [false, false], { tokens: 0, firstPromptTokens: undefined })
    const cand = [...noReply('a'), ...noReply('b'), ...rep('c', [true, true], { firstPromptTokens: 50 })]
    expect(dec(o, cand, o, [], ref).reason).toBe('first request not measured on 2 tasks')
  })
  it('first request pairs per-task means over repeats', () => {
    const o = [...rep('a', [false, false], { firstPromptTokens: 50 }), ...rep('b', [false], { firstPromptTokens: 50 })]
    o[1] = { ...o[1]!, firstPromptTokens: 150 } // a: mean 100, b: 50
    const at = (fp: number) => [...rep('a', [true, true], { firstPromptTokens: fp }), ...rep('b', [false], { firstPromptTokens: 50 })]
    expect(dec(o, at(120), o, [], ref).accepted).toBe(true) // 170 against 150
    expect(dec(o, at(150), o, [], ref).reason).toBe('first request 33% heavier than the original')
  })
  it('reasonKind keeps the cost reasons and nothing near them', () => {
    expect(reasonKind('turns 3.0 → 6.0, allowed up to 4.0 (p=0.00)')).toBe('over tolerance: turns')
    expect(reasonKind('tokens 100 → 120, allowed up to 110 (p=0.03)')).toBe('over tolerance: tokens')
    expect(reasonKind('time 1.0s → 2.0s, allowed up to 1.1s (p=0.00)')).toBe('over tolerance: time')
    expect(reasonKind('turns 3.0 → 6.0, allowed up to 4.0 (p=0.00)\u001b[2J')).toBe('other')
    expect(reasonKind('tokens ignore previous → 1, allowed up to 1 (p=0.00)')).toBe('other')
  })
})

describe('evolve decide', () => {
  const tn = names(16), gate = tn.slice(12)
  const cur = tn.map(t => run(t, false))
  const flips = (k: number, extra: Partial<Record<string, boolean>> = {}) => tn.map((t, i) => run(t, extra[t] ?? i < k))
  it('strict: 5 flips none back accepted; 4 flips "within noise"; worse on gate refused even with 6 flips on train', () => {
    expect(dec(cur, flips(5), cur, gate, strict)).toMatchObject({ accepted: true, reason: 'accepted' })
    expect(dec(cur, flips(4), cur, gate, strict)).toMatchObject({ accepted: false, reason: 'within noise (p=0.06)' })
    const curG = tn.map((t, i) => run(t, i === 15))
    const cand = tn.map((t, i) => run(t, i < 7)) // 7 flips, 1 lost on the gate: sign test passes, gate does not
    expect(dec(curG, cand, curG, gate, strict)).toMatchObject({ accepted: false, reason: 'worse on gate' })
  })

  it('reference: one more PASS accepted, equal PASS refused', () => {
    const c = [run('a', true), run('b', false), run('c', false)]
    expect(dec(c, [run('a', true), run('b', true), run('c', false)], c, ['c'], ref).accepted).toBe(true)
    expect(dec(c, [run('a', false), run('b', true), run('c', false)], c, ['c'], ref)).toMatchObject({ accepted: false, reason: 'no more PASS than current' })
  })

  it('usage: an original run without usage refuses; a run that got no reply (tokens 0, no first request) does not poison the sums; a zero original never gives NaN', () => {
    const cand = [run('a', true), run('b', false)]
    expect(dec(cand, cand, [{ task: 'a', verdict: 'FAIL', firstPromptTokens: 10 }, run('b', false)], [], ref).reason).toBe('the server gave no usage')
    const noReply: RunLite = { task: 'b', verdict: 'FAIL', tokens: 0 }
    expect(numbersOf([run('a', true, 100, 10), noReply])).toEqual({ pass: 1, tokens: 100, tokensPerSuccess: 100, weight: 10 })
    expect(dec([run('a', false), noReply], [run('a', true), noReply], [run('a', false), noReply], [], ref)).toMatchObject({ accepted: true })
    const zero: RunLite[] = [{ task: 'a', verdict: 'FAIL', tokens: 0 }, noReply]
    expect(dec(zero, cand, zero, [], ref)).toMatchObject({ accepted: false, reason: 'the server gave no usage' })
    expect(usable(zero)).toBe(false)
    expect(usable(cand)).toBe(true)
  })

  it('tokens: vs the original, not the current', () => {
    const orig = [run('a', true, 100), run('b', false, 0)] // 100 tokens per success
    const zero = [run('a', false, 100), run('b', false, 100)]
    const one = (t: number) => [run('a', true, t), run('b', false, 0)]
    expect(dec(zero, one(108), orig, [], ref).accepted).toBe(true)
    // a later candidate against a current at 108: the 15% is counted from the original
    expect(dec(one(108), [run('a', true, 115), run('b', true, 115)], orig, [], ref)).toMatchObject({ accepted: false, reason: 'costs 15% more tokens per success than the original' })
    // original with 0 PASS: totals are compared
    expect(dec(zero, [run('a', true, 130), run('b', false, 100)], zero, [], ref)).toMatchObject({ accepted: false, reason: 'costs 15% more tokens than the original' })
    expect(dec(zero, [run('a', true, 105), run('b', false, 100)], zero, [], ref).accepted).toBe(true)
    const noUsage = { task: 'a', verdict: 'PASS' as const, firstPromptTokens: 10 }
    expect(dec(zero, [noUsage, run('b', false)], orig, [], ref).reason).toBe('the server gave no usage')
    expect(dec(zero, [run('a', false), run('b', false)], orig, [], ref).reason).toBe('0 PASS')
  })

  it('weight: Σ firstPromptTokens 126% of the original refused, 125% accepted', () => {
    const o = [run('a', false, 100, 50), run('b', false, 100, 50)]
    const at = (fp: number) => [run('a', true, 100, fp), run('b', false, 100, 50)]
    expect(dec(o, at(75), o, [], ref).accepted).toBe(true) // 125/100
    expect(dec(o, at(76), o, [], ref)).toMatchObject({ accepted: false, reason: 'first request 26% heavier than the original' })
  })

  it('weight: a candidate run with no first request where the original has one is refused; a task neither measured is left out of both sums', () => {
    const T = names(10)
    const orig = T.map((t, i) => run(t, i < 3, 100, 100))
    // A bloated prompt overflows the window on 4 tasks: no reply, so no first request, while 4 others PASS.
    const cand = T.map((t, i): RunLite => i < 4 ? { task: t, verdict: 'FAIL', tokens: 0 } : run(t, i < 8, 100, 200))
    expect(dec(orig, cand, orig, [], ref)).toMatchObject({ accepted: false, reason: 'first request not measured on 4 tasks' })
    // t0 got no reply on the original: its 1000 on the candidate is in neither sum, so 9 x 120 against 9 x 100.
    const o2 = T.map((t, i): RunLite => i === 0 ? { task: t, verdict: 'FAIL', tokens: 0 } : run(t, i < 3, 100, 100))
    const c2 = T.map((t, i) => run(t, i < 4, 100, i === 0 ? 1000 : 120))
    expect(dec(o2, c2, o2, [], ref)).toMatchObject({ accepted: true })
  })
})

describe('evolve edits', () => {
  it('applyEdit appends a paragraph and leaves the input untouched', () => {
    const h = harness({ systemPrompt: 'be brief\n\n' })
    const c = applyEdit(h, { field: 'systemPrompt', value: 'read first' }) as any
    expect(c.systemPrompt).toBe('be brief\n\nread first')
    expect(h.systemPrompt).toBe('be brief\n\n')
  })

  it('applyEdit sets loop.maxRepeats on a harness without it, and context where there is none', () => {
    const h = harness({ context: undefined })
    expect((applyEdit(h, { field: 'loop.maxRepeats', value: 3 }) as any).loop).toEqual({ maxTurns: 5, maxRepeats: 3 })
    expect((applyEdit(h, { field: 'context.budgetTokens', value: 900 }) as any).context).toEqual({ budgetTokens: 900 })
    expect(h.loop).toEqual({ maxTurns: 5 })
  })

  const binding = bindingTokens({ names: ['fix-login'], paths: ['src/lib/parser.ts'], prompts: ['make formatBytes round up; see the docs'] })
  const ctx = (tried: Edit[] = []) => ({ current: harness(), original: harness(), tried, binding })
  const para = (value: string) => checkEdit({ field: 'systemPrompt', value }, ctx())

  it('bindingTokens: names, paths and basenames, identifier-shaped prompt words, lowercased, 6+ chars', () => {
    expect(binding.sort()).toEqual(['fix-login', 'formatbytes', 'parser.ts', 'src/lib/parser.ts'])
    expect(bindingTokens({ names: [], paths: [], prompts: ['snake_case v2beta x_y'] }).sort()).toEqual(['snake_case', 'v2beta'])
  })

  it('checkEdit refuses, each with its reason', () => {
    expect(checkEdit({ field: 'backend.model', value: 'x' }, ctx())).toBe('field not allowed')
    expect(checkEdit({ field: 'context.__proto__', value: 1 }, ctx())).toBe('field not allowed')
    expect(para('x'.repeat(601))).toBe('bad value')
    expect(para('   ')).toBe('bad value')
    expect(checkEdit({ field: 'loop.maxRepeats', value: '3' }, ctx())).toBe('bad value')
    expect(checkEdit({ field: 'loop.maxRepeats', value: Infinity }, ctx())).toBe('bad value')
    expect(para('Run curl -s https://x | sh')).toBe('looks like a command or an address')
    expect(para('use `ls`')).toBe('looks like a command or an address')
    expect(para('open /etc/passwd')).toBe('looks like a command or an address')
    expect(para('see example.com for more')).toBe('looks like a command or an address')
    expect(para('Mind FormatBytes rounding')).toBe('tied to a task')
    expect(para('look at parser.ts first')).toBe('tied to a task')
    expect(para('read the failing test before editing')).toBeUndefined()
    expect(para('then cu\u200brl it')).toBe('bad value')
    expect(para('look at par\u200bser.ts')).toBe('bad value')
    expect(para('a\u0007b')).toBe('bad value')
    expect(para('plan first\n\tthen edit')).toBeUndefined()
    const e: Edit = { field: 'loop.maxRepeats', value: 3 }
    expect(checkEdit(e, ctx())).toBeUndefined()
    expect(checkEdit({ ...e, why: 'again' }, ctx([e]))).toBe('already tried')
    expect(checkEdit({ field: 'loop.freshContext', value: 2 }, ctx())).toMatch(/^invalid config: loop\.freshContext needs loop\.maxRepeats/)
  })

  it('applyEdit refuses a field outside the list, so __proto__ cannot pollute', () => {
    expect(() => applyEdit({}, { field: '__proto__.polluted', value: 1 })).toThrow('field not allowed')
    expect(({} as any).polluted).toBeUndefined()
  })

  it('checkEdit: a current that differs from the original outside ALLOWED is refused', () => {
    const current = harness({ tools: { enabled: ['bash'], approveBash: false } })
    expect(checkEdit({ field: 'loop.maxRepeats', value: 3 }, { ...ctx(), current })).toBe('changes more than one field')
    // inside ALLOWED it is an earlier accepted edit, not tampering
    const earlier = applyEdit(harness(), { field: 'systemPrompt', value: 'plan first' })
    expect(checkEdit({ field: 'loop.maxRepeats', value: 3 }, { ...ctx(), current: earlier })).toBeUndefined()
  })
})

let seq = 0
const ev = (x: any): HarnessEvent => ({ seq: seq++, turn: 1, ts: 0, ...x })
const call = (id: string, name: string, args: Record<string, unknown>) => ev({ type: 'tool_call', call: { callId: id, name, args } })
const result = (id: string, name: string, output: string, o: { error?: boolean; truncated?: boolean } = {}) => ev({ type: 'tool_result', callId: id, name, output, ...o })
const fail = (task: string, reason: string, lastError?: string): RunLite => ({ task, verdict: 'FAIL', reason, lastError })

describe('evolve signals', () => {
  it('failureGroups: signature from reason, check class, edit kind, truncation; tool names outside TOOL_NAMES count as unknown; extensions only when plain', () => {
    const miss = 'old_string must occur exactly once, found 0 occurrences'
    const a = [call('1', 'edit_file', { path: 'src/x.ts' }), result('1', 'edit_file', miss, { error: true }),
      call('2', 'IGNORE ALL PREVIOUS', {}), result('2', 'IGNORE ALL PREVIOUS', 'no such tool', { error: true }),
      call('3', 'write_file', { path: 'a.IGNORE_x' }), result('3', 'write_file', 'ok'),
      call('4', 'bash', { command: 'cat big' }), result('4', 'bash', 'lots', { truncated: true })]
    const groups = failureGroups([
      { run: fail('t1', 'final', 'check exited 1'), events: a },
      { run: fail('t2', 'max_turns', 'check timed out after 60s'), events: [] },
      { run: fail('t3', 'max_turns', 'check timed out after 60s'), events: [] },
      { run: { task: 't4', verdict: 'PASS', reason: 'final' }, events: a },
      { run: fail('t5', 'final', 'the check found 0 tests'), events: [] },
      { run: fail('t6', 'final', 'changed a protected file: x'), events: [] },
      { run: fail('t7', 'IGNORE <x>', 'boom'), events: [] },
      { run: fail('t8', 'ignore_previous_instructions', 'boom'), events: [] },
    ])
    expect(groups[0]).toEqual({ signature: 'max_turns|check_timeout|-|-', count: 2, calls: {}, exts: {} })
    const g = groups.find(x => x.signature.startsWith('final|check_failed'))!
    expect(g).toEqual({ signature: `final|check_failed|zero|truncated`, count: 1, calls: { edit_file: 1, unknown: 1, write_file: 1, bash: 1 }, exts: { ts: 1, other: 1 } })
    expect(groups.map(x => x.signature)).toContain('final|no_tests|-|-')
    expect(groups.map(x => x.signature)).toContain('final|protected|-|-')
    expect(groups.map(x => x.signature)).toContain('other|other|-|-')
    expect(groups.find(x => x.signature === 'other|other|-|-')!.count).toBe(2)
    expect(groups.reduce((n, x) => n + x.count, 0)).toBe(7)
  })

  it('proposerInput has no paths, task names or argument values', () => {
    const events = [call('1', 'edit_file', { path: 'src/secret-name.ts', old: 'TOPSECRET' }), result('1', 'edit_file', 'TOPSECRET out', { error: true }),
      call('2', 'bash', { command: 'echo TOPSECRET' }), result('2', 'bash', 'TOPSECRET')]
    const groups = failureGroups([{ run: fail('fix-login', 'final', 'check exited 1 in src/secret-name.ts TOPSECRET'), events }])
    const input = proposerInput(harness({ systemPrompt: 'be  careful\u200b' }), groups,
      [{ field: 'systemPrompt', value: 'about fix-login', reason: 'tied to a task' }, { field: 'loop.maxRepeats', value: 'x'.repeat(300), reason: 'bad value' }], s => s.replace(/\s+/g, ' '))
    for (const bad of ['secret-name', 'fix-login', 'TOPSECRET']) expect(input).not.toContain(bad)
    const x = JSON.parse(input)
    expect(x.current).toEqual({ systemPrompt: 'be careful\u200b', 'context.maxToolOutputChars': 4000, 'context.budgetTokens': 0 })
    expect(x.rejected[0]).toEqual({ field: 'systemPrompt', reason: 'tied to a task' })
    expect(x.rejected[1].value).toHaveLength(200)
    expect(x.failures[0]).toMatchObject({ signature: 'final|check_failed|other|-', count: 1, exts: { ts: 1 } })
  })

  it('proposerRequest: system then user, schema and /no_think only when asked', () => {
    const r = proposerRequest('m', 'IN', { schema: false, noThink: false })
    expect(r.model).toBe('m')
    expect(r.messages.map(m => m.role)).toEqual(['system', 'user'])
    expect(r.messages[0].content).toMatch(/^You improve the harness of a coding agent\./)
    expect(r.messages[0].content).toContain('loop.maxRepeats')
    expect(r.messages[0].content).not.toContain('/no_think')
    expect(r.messages[1].content).toBe('IN')
    expect(r.responseSchema).toBeUndefined()
    const s = proposerRequest('m', 'IN', { schema: true, noThink: true })
    expect(s.responseSchema).toBe(PROPOSAL_SCHEMA)
    expect(s.messages[0].content).toMatch(/\n\/no_think$/)
  })

  it('parseProposal: bare, fenced, after <think>, garbage throws', () => {
    const want = { field: 'loop.maxRepeats', value: 3, why: 'loops' }
    expect(parseProposal(JSON.stringify(want))).toEqual(want)
    expect(parseProposal('Here:\n```json\n{"field":"systemPrompt","value":"plan first"}\n```')).toEqual({ field: 'systemPrompt', value: 'plan first' })
    expect(parseProposal('<think>{"field": 1}</think>{"field":"loop.maxRepeats","value":2}')).toEqual({ field: 'loop.maxRepeats', value: 2 })
    expect(() => parseProposal('no idea')).toThrow('no edit in the reply')
    expect(() => parseProposal('{"field":"loop.maxRepeats","value":true}')).toThrow('no edit in the reply')
  })
  it('signatureOf of a max_turns FAIL with a truncated tool result is max_turns|-|-|truncated, and failureGroups shares it', () => {
    const ev = [call('4', 'bash', { command: 'cat big' }), result('4', 'bash', 'lots', { truncated: true })]
    const r = { task: 't1', verdict: 'FAIL' as const, reason: 'max_turns' }
    expect(signatureOf(r, ev)).toBe('max_turns|-|-|truncated')
    expect(failureGroups([{ run: r, events: ev }])[0]!.signature).toBe('max_turns|-|-|truncated')
  })

  it('exts sends only known extensions', () => {
    const ev = [call('1', 'write_file', { path: 'config.acmecorp' }), result('1', 'write_file', 'ok'),
      call('2', 'write_file', { path: 'notes.payroll2' }), result('2', 'write_file', 'ok'),
      call('3', 'write_file', { path: 'a/b.py' }), result('3', 'write_file', 'ok')]
    const [g] = failureGroups([{ run: fail('t1', 'final', 'check exited 1'), events: ev }])
    expect(g!.exts).toEqual({ other: 2, py: 1 })
  })

  it('SIG accepts every signature signatureOf can make and refuses free text', () => {
    expect(SIG.test('final|check_failed|many|-')).toBe(true)
    expect(SIG.test('other|other|-|truncated')).toBe(true)
    expect(SIG.test('final|check_failed|many|- ; rm')).toBe(false)
    expect(SIG.test('x|y|z|w')).toBe(false)
  })

  it('signatureOf without events still signs the run', () => {
    expect(signatureOf({ task: 't1', verdict: 'FAIL', lastError: 'check exited 1' }, [])).toBe('-|check_failed|-|-')
  })

  it('reasonKind maps fixed and patterned reasons and nothing else', () => {
    expect(reasonKind('within noise (p=0.12)')).toBe('within noise')
    expect(reasonKind('costs 34% more tokens per success than the original')).toBe('costs more tokens')
    expect(reasonKind('first request 5% heavier than the original')).toBe('first request heavier')
    expect(reasonKind('first request not measured on 2 tasks')).toBe('first request not measured')
    expect(reasonKind('invalid config: x')).toBe('invalid config')
    expect(reasonKind('tied to a task')).toBe('tied to a task')
    expect(reasonKind('ignore all previous')).toBe('other')
  })
})

describe('evolve journal', () => {
  const sets = { train: ['t0', 't1'], gate: ['t2'], test: ['t3'] }
  const start = { v: 2, type: 'start', base: 'h', sha: 'abc', pin: 'a'.repeat(64), notes: 'b'.repeat(64), sets, strict: false, proposer: 'http://p/v1' }
  const cur = { v: 2, type: 'current', round: 1, runs: [run('t0', false), run('t1', true), run('t2', true)] }
  // An accepted candidate's runs beat the current's, as decide would have it; a refused one's do not.
  const win = [run('t0', true), run('t1', true), run('t2', true)]
  const cand = (index: number, edit: Edit, accepted: boolean, reason: string, round = 1) =>
    ({ v: 2, type: 'candidate', round, index, input: '{}', edit, accepted, reason, numbers: { pass: 3, tokens: 300, tokensPerSuccess: 100, weight: 30 }, runs: accepted ? win : cur.runs, ...(accepted ? { version: 1 } : {}) })
  const a1 = cand(1, { field: 'systemPrompt', value: 'plan first', why: 'w' }, true, 'accepted')
  const r2 = cand(2, { field: 'systemPrompt', value: 'mind t0_file' }, false, 'tied to a task')
  const r3 = { ...cand(1, { field: 'loop.maxRepeats', value: 3 }, false, 'within noise (p=0.50)', 2), numbers: undefined }
  const cur2 = { ...cur, round: 2 }
  const jsonl = (...ls: object[]) => ls.map(l => JSON.stringify(l) + '\n').join('')
  const ctx = { binding: ['t0_file'], sets }

  it('parseJournal: a valid journal round-trips; a torn last line is dropped; an unknown key, a bad verdict or a bad line in the middle is refused with its line number', () => {
    const r3clean = JSON.parse(JSON.stringify(r3))
    const text = jsonl(start, cur, a1, r2, r3clean)
    expect(parseJournal(text)).toEqual({ lines: [start, cur, a1, r2, r3clean] })
    expect(parseJournal('')).toEqual({ lines: [] })
    // Torn: no newline at the end, dropped even when it would parse.
    expect(parseJournal(text + JSON.stringify(cur))).toEqual({ lines: [start, cur, a1, r2, r3clean] })
    expect(parseJournal(text + '{"v":1,"ty')).toEqual({ lines: [start, cur, a1, r2, r3clean] })
    expect(parseJournal(jsonl(start, { ...cur, extra: 1 }))).toEqual({ error: expect.stringMatching(/^line 2: /) })
    expect(parseJournal(jsonl(start, { ...cur, runs: [{ ...run('t0', true), verdict: 'OK' }] }))).toEqual({ error: expect.stringMatching(/^line 2: /) })
    expect(parseJournal(jsonl(start, { ...cur, runs: [run('../x', true)] }))).toEqual({ error: expect.stringMatching(/^line 2: /) })
    expect(parseJournal(jsonl(start) + '{"v":1,"ty\n' + jsonl(cur))).toEqual({ error: expect.stringMatching(/^line 2: /) })
    expect(parseJournal(jsonl(start, cur, { ...a1, edit: { ...a1.edit, extra: 1 } }))).toEqual({ error: expect.stringMatching(/^line 3: /) })
    expect(parseJournal(jsonl({ ...start, v: 3 }))).toEqual({ error: expect.stringMatching(/^line 1: /) })
    expect(parseJournal(jsonl({ ...start, v: 1 }))).toEqual({ error: expect.stringContaining('older evolve journal') })
    const { turns: _t, ...noTurns } = run('t0', true) as Required<RunLite>
    expect(parseJournal(jsonl(start, { ...cur, runs: [noTurns] }))).toEqual({ error: 'line 2: runs: [0] missing turns' })
    const { modelMs: _m, ...noMs } = run('t0', true) as Required<RunLite>
    expect(parseJournal(jsonl(start, { ...cur, runs: [noMs] }))).toEqual({ error: 'line 2: runs: [0] missing modelMs' })
    const priced = { ...cur, runs: [{ ...run('t0', true), costUsd: 0.01, repeat: 2 }] }
    expect(parseJournal(jsonl(start, priced))).toEqual({ lines: [start, priced] })
    expect(parseJournal(jsonl({ ...start, sets: { ...sets, more: [] } }))).toEqual({ error: expect.stringMatching(/^line 1: /) })
    const { pin: _, ...noPin } = start
    expect(parseJournal(jsonl(noPin))).toEqual({ error: 'line 1: missing pin' })
    expect(parseJournal(jsonl({ ...start, pin: 'x' }))).toEqual({ error: expect.stringMatching(/^line 1: pin: /) })
  })

  const tr = (ok = true) => [run('t3', ok)]
  const fin = (o: object = {}) => ({ v: 2, type: 'final', version: 1, orig: tr(false), last: tr(true), ...o })

  it('a run with a sig outside the vocabulary is refused', () => {
    expect(parseJournal(jsonl(start, { ...cur, runs: [{ ...run('t0', false), sig: 'x ; rm' }] }))).toEqual({ error: expect.stringMatching(/^line 2: .*sig/) })
    expect(parseJournal(jsonl(start, { ...cur, runs: [{ ...run('t0', false), sig: 'final|check_failed|many|-' }] }))).toHaveProperty('lines')
  })

  it('a start line without notes is refused', () => {
    const { notes: _, ...noNotes } = start
    expect(parseJournal(jsonl(noNotes))).toEqual({ error: 'line 1: missing notes' })
  })

  it('replay holds the journal to the original\'s loop.maxTurns: an accepted line whose verdict depends on the cap replays', () => {
    const big = { train: ['t0', 't1', 't2', 't3', 't4'], gate: ['t5', 't6'], test: ['t7'] }
    const st = { ...start, sets: big }
    const base = ['t0', 't1', 't2', 't3', 't4', 't5', 't6'].map((t, i) => run(t, i > 0)) // 6 PASS at 3 turns
    // all 7 PASS at 8 turns: past +1 on the 6 shared, but 8 > the cap of 5 (harness()), so not compared and accepted
    const dear = base.map((r): RunLite => ({ ...r, verdict: 'PASS', turns: 8 }))
    const c = { ...a1, runs: dear }
    const r = replay([st, { ...cur, runs: base }, c] as any, harness(), { binding: [], sets: big }) as any
    expect(r.error).toBeUndefined(); expect(r.version).toBe(1)
  })

  it('a final line is kept only as the journal\'s last line, for the replayed version, on the test tasks', () => {
    const lines = (...ls: object[]) => (parseJournal(jsonl(...ls)) as any).lines
    const ok = replay(lines(start, cur, a1, fin()), harness(), ctx) as any
    expect(ok.final).toEqual({ orig: tr(false), last: tr(true) })
    expect((replay(lines(start, cur, a1, fin(), { ...cur, round: 2 }), harness(), ctx) as any).final).toBeUndefined()
    expect(replay(lines(start, cur, a1, fin({ version: 2 })), harness(), ctx)).toEqual({ error: expect.stringContaining('final') })
    expect(replay(lines(start, cur, a1, fin({ orig: [run('t0', false)] })), harness(), ctx)).toEqual({ error: expect.stringContaining('final') })
    const two = { ...ctx, sets: { ...sets, test: ['t3', 't4'] } }
    const s2 = { ...start, sets: two.sets }
    const both = [run('t4', true), run('t3', true)]
    // Order does not matter; a name repeated in place of another does.
    expect((replay(lines(s2, cur, a1, fin({ orig: both, last: both })), harness(), two) as any).final).toEqual({ orig: both, last: both })
    expect(replay(lines(s2, cur, a1, fin({ orig: [run('t3', false), run('t3', false)], last: both })), harness(), two)).toEqual({ error: expect.stringContaining('final') })
    expect(replay(lines(start, cur, a1, { v: 2, type: 'final', version: 1, orig: tr() }), harness(), ctx)).toEqual({ error: expect.stringContaining('final') })
  })

  it('a final line for version 0 has no runs', () => {
    const lines = (...ls: object[]) => (parseJournal(jsonl(...ls)) as any).lines
    expect((replay(lines(start, cur, { v: 2, type: 'final', version: 0 }), harness(), ctx) as any).final).toBe('none')
    expect(replay(lines(start, cur, { v: 2, type: 'final', version: 0, orig: tr() }), harness(), ctx)).toEqual({ error: expect.stringContaining('final') })
  })

  it('parseJournal: an inherited or prototype key is refused with its line number, never a throw', () => {
    expect(parseJournal('{"v":1,"type":"__proto__"}\n')).toEqual({ error: expect.stringMatching(/^line 1: /) })
    expect(parseJournal('{"v":1,"type":"hasOwnProperty"}\n')).toEqual({ error: expect.stringMatching(/^line 1: /) })
    expect(parseJournal(jsonl({ ...cur, constructor: {} }))).toEqual({ error: expect.stringMatching(/^line 1: /) })
    expect(parseJournal(JSON.stringify(cur).slice(0, -1) + ',"__proto__":{}}\n')).toEqual({ error: expect.stringMatching(/^line 1: /) })
    expect(parseJournal(jsonl({ ...cur, runs: [{ ...run('t0', true), toString: 1 }] }))).toEqual({ error: expect.stringMatching(/^line 1: /) })
    expect(parseJournal(jsonl({ ...a1, edit: { ...a1.edit, constructor: 'x' } }))).toEqual({ error: expect.stringMatching(/^line 1: /) })
  })

  it('replay: a reason the harness does not write reaches the proposer as other; a value holding a binding token goes without its value', () => {
    const odd = cand(2, { field: 'loop.maxRepeats', value: 4 }, false, 'see src/secret-name.ts')
    const leak = cand(1, { field: 'systemPrompt', value: 'mind t0_file' }, false, '0 PASS', 2)
    const ok = cand(2, { field: 'loop.maxRepeats', value: 5 }, false, 'costs 12% more tokens per success than the original', 2)
    const cfg = cand(3, { field: 'src/t0_file.ts', value: 1 }, false, 'invalid config: t0_file is bad', 2)
    const r = replay([start, cur, a1, odd, cur2, leak, ok, cfg] as any, harness(), ctx) as any
    expect(r.rejected).toEqual([{ field: 'loop.maxRepeats', value: 4, reason: 'other' }, { field: 'systemPrompt', reason: '0 PASS' },
      { field: 'loop.maxRepeats', value: 5, reason: 'costs 12% more tokens per success than the original' }, { field: 'other', value: 1, reason: 'other' }])
  })

  it('replay rebuilds the current from the original and the accepted edits', () => {
    const lines = (parseJournal(jsonl(start, cur, a1, r2, cur2, JSON.parse(JSON.stringify(r3)))) as any).lines
    const r = replay(lines, harness(), ctx) as any
    expect(r.error).toBeUndefined()
    expect(r.current).toEqual(applyEdit(harness(), { field: 'systemPrompt', value: 'plan first' }))
    expect(r.version).toBe(1)
    expect(r.baseline).toEqual(cur.runs)
    expect(r.done).toEqual([{ round: 1, index: 0 }, { round: 1, index: 1 }, { round: 1, index: 2 }, { round: 2, index: 0 }, { round: 2, index: 1 }])
    expect(r.tried).toEqual([a1.edit, r2.edit, r3.edit])
    expect(r.rejected).toEqual([{ field: 'systemPrompt', reason: 'tied to a task' }, { field: 'loop.maxRepeats', value: 3, reason: 'within noise (p=0.50)' }])
  })

  it('refuses an accepted edit outside ALLOWED written into the journal', () => {
    const bad = cand(2, { field: 'loop.untilBash', value: 'rm -rf x' }, true, 'accepted')
    expect(replay([start, cur, a1, bad] as any, harness(), ctx)).toEqual({ error: 'cannot resume: round 1 candidate 2: accepted edit 2: field not allowed' })
    const dup = cand(2, a1.edit, true, 'accepted')
    expect(replay([start, cur, a1, dup] as any, harness(), ctx)).toEqual({ error: 'cannot resume: round 1 candidate 2: accepted edit 2: already tried' })
    expect(replay([cur] as any, harness(), ctx)).toEqual({ error: expect.stringMatching(/^cannot resume: /) })
    // No round 1 current first: there is no baseline to compare with.
    expect(replay([start, a1] as any, harness(), ctx)).toEqual({ error: expect.stringMatching(/^cannot resume: .*round 1/) })
    expect(replay([start, { ...cur, round: 2 }] as any, harness(), ctx)).toEqual({ error: expect.stringMatching(/^cannot resume: .*round 1/) })
    expect(replay([start] as any, harness(), ctx)).toMatchObject({ version: 0, baseline: undefined })
  })

  // The proposal goes in before its runs: a stop between them cannot re-roll it.
  const prop = (c: { round: number; index: number; input: string; edit?: Edit }) => ({ v: 2, type: 'proposal', round: c.round, index: c.index, input: c.input, edit: c.edit })
  it('a proposal line parses; one without an edit or with an extra key is refused', () => {
    expect(parseJournal(jsonl(start, cur, prop(a1), a1))).toEqual({ lines: [start, cur, prop(a1), a1] })
    expect(parseJournal(jsonl(start, cur, { ...prop(a1), edit: undefined }))).toEqual({ error: 'line 3: missing edit' })
    expect(parseJournal(jsonl(start, cur, { ...prop(a1), extra: 1 }))).toEqual({ error: expect.stringMatching(/^line 3: /) })
  })

  it('replay: a proposal followed by its candidate is not a second line and adds nothing; one without its candidate is pending', () => {
    const lines = (...ls: object[]) => (parseJournal(jsonl(...ls)) as any).lines
    // Refused by decide, so it passed the edit checks: the only kind with a proposal.
    const n2 = cand(2, { field: 'loop.maxRepeats', value: 4 }, false, 'no more PASS than current')
    const old = replay(lines(start, cur, a1, n2), harness(), ctx) as any
    const r = replay(lines(start, cur, prop(a1), a1, prop(n2), n2), harness(), ctx) as any
    expect(r).toEqual(old)
    expect(old.pending).toBeUndefined()
    const p = replay(lines(start, cur, a1, prop(n2)), harness(), ctx) as any
    expect(p.pending).toEqual({ round: 1, index: 2, input: '{}', edit: n2.edit })
    expect(p.tried).toEqual([a1.edit])
    expect(p.done).toEqual(old.done.slice(0, 2))
  })

  it('replay refuses a candidate whose edit differs from its proposal, a proposal not followed by its candidate, one for a done slot, and one that fails the edit checks', () => {
    const other = { ...a1, edit: { field: 'systemPrompt', value: 'other' } }
    expect(replay([start, cur, prop(a1), other] as any, harness(), ctx)).toEqual({ error: 'cannot resume: round 1 candidate 1: its edit or input is not the one proposed' })
    expect(replay([start, cur, prop(a1), { ...a1, input: '{"other":1}' }] as any, harness(), ctx)).toEqual({ error: 'cannot resume: round 1 candidate 1: its edit or input is not the one proposed' })
    expect(replay([start, cur, prop(a1), r2] as any, harness(), ctx)).toEqual({ error: 'cannot resume: round 1 candidate 1: a proposal without its candidate' })
    expect(replay([start, cur, prop(a1), prop(a1)] as any, harness(), ctx)).toEqual({ error: 'cannot resume: round 1 candidate 1: a proposal without its candidate' })
    expect(replay([start, cur, prop(a1), fin()] as any, harness(), ctx)).toEqual({ error: 'cannot resume: round 1 candidate 1: a proposal without its candidate' })
    expect(replay([start, cur, a1, prop(a1)] as any, harness(), ctx)).toEqual({ error: 'cannot resume: round 1 candidate 1: a second line for it' })
    expect(replay([start, cur, a1, prop({ ...r2, edit: a1.edit })] as any, harness(), ctx)).toEqual({ error: 'cannot resume: round 1 candidate 2: proposed edit: already tried' })
    expect(replay([start, cur, prop({ ...r2, edit: { field: 'loop.untilBash', value: 'x' } })] as any, harness(), ctx)).toEqual({ error: 'cannot resume: round 1 candidate 2: proposed edit: field not allowed' })
  })

  // The journal is checked, not trusted: a decision its own numbers do not support is refused, naming its slot.
  it('replay refuses an accepted line the journal\'s numbers do not support', () => {
    const lost = cand(1, { field: 'loop.maxRepeats', value: 3 }, false, '0 PASS')
    lost.runs = [run('t0', false), run('t1', false), run('t2', false)]
    expect((replay([start, cur, lost] as any, harness(), ctx) as any).error).toBeUndefined()
    // The flip alone, and the flip with a forged reason: decide on the line's own runs says no.
    for (const forged of [{ ...lost, accepted: true, version: 1 }, { ...lost, accepted: true, version: 1, reason: 'accepted' }])
      expect(replay([start, cur, forged] as any, harness(), ctx)).toEqual({ error: expect.stringMatching(/^cannot resume: round 1 candidate 1: /) })
    // The other way: a win written as a refusal.
    expect(replay([start, cur, { ...a1, accepted: false, reason: 'worse on gate', version: undefined }] as any, harness(), ctx)).toEqual({ error: expect.stringMatching(/^cannot resume: round 1 candidate 1: /) })
    // An accepted line without runs has nothing to check against.
    expect(replay([start, cur, { ...a1, runs: undefined }] as any, harness(), ctx)).toEqual({ error: expect.stringMatching(/^cannot resume: round 1 candidate 1: /) })
    // A candidate is compared with the candidate kept before it in its round, as the run loop does: a1's runs, not cur's.
    const same = { ...cand(2, { field: 'loop.maxRepeats', value: 3 }, true, 'accepted'), version: 2 }
    expect(replay([start, cur, a1, same] as any, harness(), ctx)).toEqual({ error: expect.stringMatching(/^cannot resume: round 1 candidate 2: /) })
    // A round's candidate with runs before that round's current runs has nothing to be compared with.
    expect(replay([start, cur, { ...a1, round: 2 }] as any, harness(), ctx)).toEqual({ error: expect.stringMatching(/^cannot resume: round 2 candidate 1: /) })
  })

  it('replay refuses a second line for the same slot', () => {
    const again = cand(1, { field: 'loop.freshContext', value: 2 }, false, '0 PASS')
    expect(replay([start, cur, a1, again] as any, harness(), ctx)).toEqual({ error: expect.stringMatching(/^cannot resume: round 1 candidate 1: /) })
    expect(replay([start, cur, cur] as any, harness(), ctx)).toEqual({ error: expect.stringMatching(/^cannot resume: round 1 current runs: /) })
  })

  it('replay refuses an accepted line whose version is not the next one', () => {
    for (const version of [7, 2, undefined])
      expect(replay([start, cur, { ...a1, version }] as any, harness(), ctx)).toEqual({ error: expect.stringMatching(/^cannot resume: round 1 candidate 1: /) })
  })

  it('refuses sets that differ from the file\'s', () => {
    expect(replay([start, cur] as any, harness(), { ...ctx, sets: { ...sets, test: ['t3', 't4'] } })).toEqual({ error: expect.stringMatching(/^cannot resume: .*sets/) })
  })

  it('verdict: strict better / noise / worse texts; reference label and "more PASS"; never "better in general"', () => {
    const P = 'how far this is a principle rather than a fit depends on how unlike the training tasks the test tasks are'
    const T = names(8)
    const all = (ok: boolean) => T.map(t => run(t, ok))
    const v = (o: RunLite[], l: RunLite[], m: Mode) => verdict(o, l, m, 10)
    const text = (o: RunLite[], l: RunLite[], m: Mode) => v(o, l, m).lines.join('\n')
    expect(v(all(false), all(true), strict)).toEqual({ better: true, lines: ['better on the tasks of this repo Evolve did not see', P] })
    expect(text(all(true), all(false), strict)).toBe(`worse on the tasks of this repo Evolve did not see\n${P}`)
    expect(v(all(true), all(false), strict).better).toBe(false)
    expect(text(all(true), all(true), strict)).toBe(`not told apart from noise on the tasks of this repo Evolve did not see\n${P}`)
    // Paired by name: the same PASS count on swapped tasks is two flips each way, noise.
    expect(text([run('a', true), run('b', false)], [run('b', true), run('a', false)], strict)).toMatch(/^not told apart from noise/)
    expect(v([run('t0', false)], [run('t0', true)], ref)).toEqual({ better: true, lines: [referenceLabel(ref), 'more PASS', P] })
    expect(text([run('t0', true)], [run('t0', false)], ref)).toBe(`${referenceLabel(ref)}\nfewer PASS\n${P}`)
    expect(text([run('t0', true)], [run('t0', true)], ref)).toBe(`${referenceLabel(ref)}\nnot told apart\n${P}`)
    for (const m of [strict, ref]) for (const [o, l] of [[all(false), all(true)], [all(true), all(false)]]) expect(text(o!, l!, m)).not.toMatch(/in general/)
  })

  it('verdict: a PASS gain with tokens x3 is not better, and the line names the cost', () => {
    const T = names(8)
    const v = verdict(T.map(t => run(t, false)), T.map(t => run(t, true, 300)), strict, 10)
    expect(v.better).toBe(false)
    expect(v.lines[0]).toMatch(/not better: costs \d+% more tokens/)
    expect(v.lines.join('\n')).not.toMatch(/^better /)
    // Passes on both sides, tokens x3 on the shared ones: the per-task turns/tokens gate speaks.
    const six = names(6), o = [...six.map(t => run(t, true)), run('x', false), run('y', false)]
    const l = [...six.map(t => run(t, true, 100)), run('x', true, 100), run('y', true, 100)].map(r => r.task.length === 2 ? r : { ...r, tokens: 300 })
    expect(verdict(o, l, strict, 10).better).toBe(false)
  })

  it('verdict: repeats on the test tasks count, 5+ improved tasks with costs in bounds is better', () => {
    const T = names(8), reps = (t: string, oks: boolean[], tokens = 100) => oks.map((ok, repeat) => ({ ...run(t, ok, tokens), repeat }))
    const o = T.flatMap(t => reps(t, [false, false, false])), l = T.flatMap((t, i) => reps(t, i < 6 ? [true, true, false] : [false, false, false]))
    expect(verdict(o, l, strict, 10)).toMatchObject({ better: true, lines: [expect.stringMatching(/^better /), expect.anything()] })
    // 4 tasks improved are under the sign test's floor.
    const few = T.flatMap((t, i) => reps(t, i < 4 ? [true, true, true] : [false, false, false]))
    expect(verdict(o, few, strict, 10).better).toBe(false)
  })
})

describe('evolve on polyglot', () => {
  const p = loadPolyglot()
  const sets = { train: ['a'], gate: ['b'], test: ['c'] }

  it('boundBy: a token under 6 chars by word boundary, a longer one as a substring', () => {
    expect(boundBy('Score each Poker hand', ['poker'])).toBe(true)
    expect(boundBy('pokers and pokerface', ['poker'])).toBe(false)
    expect(boundBy('see formatBytesHelper', ['formatbytes'])).toBe(true)
    expect(boundBy(3, ['poker'])).toBe(false)
  })

  it('the binding of polyglot exercises: poker is not bound; a hyphenated exercise name and a recorded test name are', () => {
    const poker = p.exercises.find(e => e.name === 'poker')!
    const binding = bindingTokens(polyglotBinding(p, ['space-age', 'poker']))
    expect(binding).not.toContain('poker')
    expect(binding).toContain('space-age')
    expect(binding).toContain(poker.tests[0]!.toLowerCase())
    expect(binding).toContain('space-age.test.js')
    const para = (value: string) => checkEdit({ field: 'systemPrompt', value }, { current: harness(), original: harness(), tried: [], binding })
    expect(para('When a task is like poker, rank the cases first.')).toBeUndefined()
    expect(para('On space-age, convert the units first.')).toBe('tied to a task')
    expect(para(`Mind ${poker.tests[0]} first.`)).toBe('tied to a task')
    expect(para('Read the failing test before editing.')).toBeUndefined()
    // A hyphenated name no longer in the set is still a binding word; a single word is not.
    expect(bindingTokens(polyglotBinding(p, ['gone-away', 'gone']))).toEqual(['gone-away'])
  })

  it('a short repo task name binds nothing: an accepted paragraph using it still replays', () => {
    const binding = bindingTokens({ names: ['test', 'fix'], paths: [], prompts: [] })
    expect(binding).toEqual([])
    const start = { v: 2, type: 'start', base: 'h', sha: 'abc', pin: 'a'.repeat(64), notes: 'b'.repeat(64), sets: { train: ['test'], gate: ['fix'], test: ['c'] }, strict: false, proposer: 'p' }
    const cur = { v: 2, type: 'current', round: 1, runs: [run('test', false), run('fix', false)] }
    const won = [run('test', true), run('fix', true)]
    const a = { v: 2, type: 'candidate', round: 1, index: 1, input: '{}', edit: { field: 'systemPrompt', value: 'run the test first, then fix it' }, accepted: true, reason: 'accepted', numbers: { pass: 2, tokens: 200, tokensPerSuccess: 100, weight: 20 }, runs: won, version: 1 }
    const r = replay([start, cur, a] as any, harness(), { binding, sets: start.sets })
    expect('error' in r ? r.error : r.version).toBe(1)
  })

  it('replay drops a refused value bound by a short name, by word boundary', () => {
    const start = { v: 2, type: 'start', base: 'h', sha: 'polyglot:x:3', pin: 'a'.repeat(64), notes: 'b'.repeat(64), sets, strict: false, proposer: 'p' }
    const cur = { v: 2, type: 'current', round: 1, runs: [run('a', false), run('b', false)] }
    const c = (index: number, value: string) => ({ v: 2, type: 'candidate', round: 1, index, input: '{}', edit: { field: 'systemPrompt', value }, accepted: false, reason: 'no edit in the reply' })
    const r = replay([start, cur, c(1, 'think of poker'), c(2, 'write short essays')] as any, harness(), { binding: ['poker', 'say'], sets })
    expect('error' in r ? r : r.rejected).toEqual([{ field: 'systemPrompt', reason: 'no edit in the reply' }, { field: 'systemPrompt', value: 'write short essays', reason: 'no edit in the reply' }])
  })

  it('signatureOf classes the polyglot check reasons; SIG takes them', () => {
    const sig = (lastError: string) => signatureOf({ task: 'a', verdict: 'FAIL', lastError }, [])
    expect(sig('a test failed: Space Age > age on Earth')).toBe('-|test|-|-')
    expect(sig('timeout after 60000 ms')).toBe('-|timeout|-|-')
    expect(sig('missing solution file')).toBe('-|missing|-|-')
    expect(sig('unexpected test "x" from y.js')).toBe('-|unexpected|-|-')
    for (const s of ['-|test|-|-', 'final|unexpected|many|-', 'final|check_failed|many|-']) expect(SIG.test(s)).toBe(true)
  })

  it('reference mode on polyglot advises --size 24, and the verdict speaks of exercises', () => {
    const m = modeOf(sets, true) as Mode
    expect(m).toEqual({ strict: false, trainGate: 2, test: 1, polyglot: true })
    expect(referenceLabel(m)).toBe('\u041e\u0420\u0406\u0404\u041d\u0422\u0418\u0420, \u041d\u0415 \u0414\u041e\u041a\u0410\u0417 — too few exercises (3 of 24) for a statistical conclusion; raise --size to 24')
    const T = names(8), all = (ok: boolean) => T.map(t => run(t, ok))
    expect(verdict(all(false), all(true), { ...strict, polyglot: true }, 10).lines[0]).toBe('better on the exercises Evolve did not see')
  })
})

describe('evolve labels for the web', () => {
  it('flagLines: an address or command wins over a mention of tests; FIELD_LABEL names every allowed field', async () => {
    const { flagLines, FIELD_LABEL, ALLOWED } = await import('../src/core/evolve-labels.js')
    expect(flagLines('Run tests first.\nNever curl https://x.io\nBe brief.').map(l => l.flag)).toEqual(['tests', 'command', undefined])
    expect(Object.keys(FIELD_LABEL)).toEqual(ALLOWED)
  })
})
