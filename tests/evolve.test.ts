import { describe, expect, it } from 'vitest'
import { ALPHA, decide, modeOf, neededFlips, referenceLabel, signP, splitSets, type Mode, type RunLite } from '../src/core/evolve.js'
import type { RepoTask } from '../src/core/repo-tasks.js'

const task = (name: string, set?: RepoTask['set']): RepoTask => ({ name, prompt: 'p', check: 'c', set, checkTimeoutS: 60 })
const run = (t: string, ok: boolean, tokens = 100, fp = 10): RunLite => ({ task: t, verdict: ok ? 'PASS' : 'FAIL', tokens, firstPromptTokens: fp })
const names = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`)
const strict: Mode = { strict: true, trainGate: 16, test: 8 }
const ref: Mode = { strict: false, trainGate: 2, test: 1 }

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
    expect(referenceLabel(m)).toBe('ОРІЄНТИР, НЕ ДОКАЗ — too few tasks (3 of 24) for a statistical conclusion; add 21 more tasks')
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

describe('evolve decide', () => {
  const tn = names(16), gate = tn.slice(12)
  const cur = tn.map(t => run(t, false))
  const flips = (k: number, extra: Partial<Record<string, boolean>> = {}) => tn.map((t, i) => run(t, extra[t] ?? i < k))
  it('strict: 5 flips none back accepted; 4 flips "within noise"; worse on gate refused even with 6 flips on train', () => {
    expect(decide(cur, flips(5), cur, gate, strict)).toMatchObject({ accepted: true, reason: 'accepted' })
    expect(decide(cur, flips(4), cur, gate, strict)).toMatchObject({ accepted: false, reason: 'within noise (p=0.06)' })
    const curG = tn.map((t, i) => run(t, i === 15))
    const cand = tn.map((t, i) => run(t, i < 7)) // 7 flips, 1 lost on the gate: sign test passes, gate does not
    expect(decide(curG, cand, curG, gate, strict)).toMatchObject({ accepted: false, reason: 'worse on gate' })
  })

  it('reference: one more PASS accepted, equal PASS refused', () => {
    const c = [run('a', true), run('b', false), run('c', false)]
    expect(decide(c, [run('a', true), run('b', true), run('c', false)], c, ['c'], ref).accepted).toBe(true)
    expect(decide(c, [run('a', false), run('b', true), run('c', false)], c, ['c'], ref)).toMatchObject({ accepted: false, reason: 'fewer PASS than current' })
  })

  it('tokens: vs the original, not the current', () => {
    const orig = [run('a', true, 100), run('b', false, 0)] // 100 tokens per success
    const zero = [run('a', false, 100), run('b', false, 100)]
    const one = (t: number) => [run('a', true, t), run('b', false, 0)]
    expect(decide(zero, one(108), orig, [], ref).accepted).toBe(true)
    // a later candidate against a current at 108: the 15% is counted from the original
    expect(decide(one(108), [run('a', true, 115), run('b', true, 115)], orig, [], ref)).toMatchObject({ accepted: false, reason: 'costs 15% more tokens per success than the original' })
    // original with 0 PASS: totals are compared
    expect(decide(zero, [run('a', true, 130), run('b', false, 100)], zero, [], ref)).toMatchObject({ accepted: false, reason: 'costs 15% more tokens than the original' })
    expect(decide(zero, [run('a', true, 105), run('b', false, 100)], zero, [], ref).accepted).toBe(true)
    const noUsage = { task: 'a', verdict: 'PASS' as const, firstPromptTokens: 10 }
    expect(decide(zero, [noUsage, run('b', false)], orig, [], ref).reason).toBe('the server gave no usage')
    expect(decide(zero, [run('a', false), run('b', false)], orig, [], ref).reason).toBe('0 PASS')
  })

  it('weight: Σ firstPromptTokens 126% of the original refused, 125% accepted', () => {
    const o = [run('a', false, 100, 50), run('b', false, 100, 50)]
    const at = (fp: number) => [run('a', true, 100, fp), run('b', false, 100, 50)]
    expect(decide(o, at(75), o, [], ref).accepted).toBe(true) // 125/100
    expect(decide(o, at(76), o, [], ref)).toMatchObject({ accepted: false, reason: 'first request 26% heavier than the original' })
  })
})
