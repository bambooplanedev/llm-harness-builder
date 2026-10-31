import { it, expect } from 'vitest'
import { allowedTurns, allowedTenth, costCheck, costReason } from '../src/core/evolve-cost'
import type { RunLite } from '../src/core/evolve'

const run = (task: string, turns: number, o: Partial<RunLite> = {}): RunLite => ({ task, verdict: 'PASS', turns, tokens: turns * 100, modelMs: turns * 1000, repeat: 0, ...o })
const mk = (ts: number[], o: Partial<RunLite> = {}) => ts.map((t, i) => run('t' + i, t, o))

it.each([[5, 6], [10, 12], [11, 13], [20, 22], [40, 44]])('turns %d allows %d', (b, a) => expect(allowedTurns(b)).toBeCloseTo(a))
it('a tenth is 10%', () => expect(allowedTenth(100)).toBeCloseTo(110))
it('a candidate pass past the old limit is left out of its cost', () => {
  // Cap raised to 30: the slow passes are new wins, not a dearer harness.
  const base = mk([5, 5, 5, 5, 5, 5])
  const cand = [...mk([5, 5, 5, 5, 5]), run('t5', 25)]
  expect(costCheck(base, cand, 'turns', 15)!.over).toBe(false)
  expect(costCheck(base, cand, 'turns', 15)!.shared).toBe(5)
})
it('padding on every task is over', () => expect(costCheck(mk([5, 6, 7, 8, 9, 10]), mk([10, 12, 14, 16, 18, 20]), 'turns', 30)!.over).toBe(true))
it('over the tolerance by noise alone is not over: the sign-flip p is not under 0.10', () => {
  const c = costCheck(mk([5, 5, 5, 5, 5, 5]), mk([20, 2, 5, 5, 5, 8]), 'tokens', 30)!
  expect(c.ratio).toBeGreaterThan(c.allowed / c.before)
  expect(c.p).toBeGreaterThanOrEqual(0.1)
  expect(c.over).toBe(false)
})
it('under 5 shared tasks there is no verdict', () => expect(costCheck(mk([5, 5, 5, 5]), mk([9, 9, 9, 9]), 'turns', 15)).toBeUndefined())
it('the bound is inclusive', () => {
  const c = costCheck(mk([5, 5, 5, 5, 5]), mk([6, 6, 6, 6, 6]), 'turns', 15)!
  expect(c.over).toBe(false)
  expect(c.ratio).toBeCloseTo(1.2)
})
it('a task with 1 of 3 passes counts, over its passing repeats', () => {
  const b = mk([5, 5, 5, 5]).concat([run('x', 5, { repeat: 0 }), run('x', 5, { verdict: 'FAIL', repeat: 1 }), run('x', 5, { verdict: 'FAIL', repeat: 2 })])
  const c = mk([5, 5, 5, 5]).concat([run('x', 5, { verdict: 'FAIL', repeat: 0 }), run('x', 5, { repeat: 1 }), run('x', 5, { verdict: 'FAIL', repeat: 2 })])
  expect(costCheck(b, c, 'turns', 15)!.shared).toBe(5)
})
it('time reads modelMs, tokens reads tokens', () => {
  const b = mk([5, 5, 5, 5, 5]), c = mk([5, 5, 5, 5, 5]).map(r => ({ ...r, tokens: 1000, modelMs: 5000 }))
  expect(costCheck(b, c, 'tokens', 15)!.ratio).toBeCloseTo(2)
  expect(costCheck(b, c, 'time', 15)!.ratio).toBeCloseTo(1)
})
it('a run without the metric is not eligible', () => expect(costCheck(mk([5, 5, 5, 5, 5], { turns: undefined }), mk([5, 5, 5, 5, 5]), 'turns', 15)).toBeUndefined())
it('reason names both sides, the allowance and p', () => {
  const c = costCheck(mk([5, 5, 5, 5, 5]), mk([7, 7, 7, 7, 7]), 'turns', 15)!
  expect(costReason(c, 'turns')).toMatch(/^turns 5\.0 → 7\.0, allowed up to 6\.0 \(p=0\.\d\d\)$/)
})
