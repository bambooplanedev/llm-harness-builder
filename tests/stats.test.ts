import { it, expect } from 'vitest'
import { permP, signFlipP, smallestGain, PERMS } from '../src/core/stats'

it('one stratum 5/5 against 0/5 is exactly 1/252', () => {
  const r = permP([{ a: [0,0,0,0,0], b: [1,1,1,1,1] }], 'greater')
  expect(r).toEqual({ p: 1 / 252, perms: 252, exact: true })
})
it('constant strata do not multiply the count', () => expect(permP([{ a: [1,1], b: [1,1] }, { a: [0], b: [1] }], 'greater').perms).toBe(2))
it('over PERMS it samples, with the seed: same input, same p', () => {
  const s = Array.from({ length: 8 }, () => ({ a: [0,1,0], b: [1,0,1] }))
  const r = permP(s, 'two')
  expect(r.exact).toBe(false); expect(r.perms).toBe(PERMS); expect(permP(s, 'two')).toEqual(r)
})
it('two-sided is symmetric', () => expect(permP([{ a: [1,1], b: [0,0] }], 'two').p).toBe(permP([{ a: [0,0], b: [1,1] }], 'two').p))
it('signFlipP on five positive diffs is 1/32, on zero diffs 1', () => { expect(signFlipP([1,1,1,1,1])).toBe(1 / 32); expect(signFlipP([])).toBe(1) })

// By hand: z = 1.6449 + 0.8416 = 2.4865; k = ceil(z * sqrt(2·p(1−p) / (N·R)) * N).
it('smallestGain: p=.5, 32 tasks: R=5 → 4.45 → 5, R=3 → 5.74 → 6; R=1 → 9.95 → 10, an upper bound', () => {
  expect(smallestGain(0.5, 5, 32)).toEqual({ tasks: 5, bound: false })
  expect(smallestGain(0.5, 3, 32)).toEqual({ tasks: 6, bound: false })
  expect(smallestGain(0.5, 1, 32)).toEqual({ tasks: 10, bound: true })
})

it('smallestGain: p=.25, 16 tasks, R=4: sqrt(.375/64)=.07655 → 3.05 → 4; a probe of all one verdict still needs one task', () => {
  expect(smallestGain(0.25, 4, 16)).toEqual({ tasks: 4, bound: false })
  expect(smallestGain(0, 3, 32)).toEqual({ tasks: 1, bound: false })
  expect(smallestGain(1, 1, 32)).toEqual({ tasks: 1, bound: true })
})
