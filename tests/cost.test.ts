import { test, expect } from 'vitest'
import { costOf } from '../src/core/cost.js'

const u = { promptTokens: 1_000_000, completionTokens: 1_000_000 }

test('costOf: plain input and output, per million tokens', () => {
  expect(costOf(u, { input: 0.1, output: 0.5 })).toBeCloseTo(0.6)
})

test('costOf: cached tokens use their own prices', () => {
  const p = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
  expect(costOf({ ...u, cacheReadTokens: 400_000, cacheWriteTokens: 100_000 }, p)).toBeCloseTo(0.05 + 0.004 + 0.0125 + 0.5)
})

test('costOf: without cache prices cached tokens cost the input price', () => {
  expect(costOf({ ...u, cacheReadTokens: 400_000, cacheWriteTokens: 100_000 }, { input: 0.1, output: 0.5 })).toBeCloseTo(0.6)
})

test('costOf: a usage whose cache counts exceed the prompt never gives a negative term', () => {
  const c = costOf({ promptTokens: 10, completionTokens: 0, cacheReadTokens: 50 }, { input: 1, output: 1, cacheRead: 0 })
  expect(c).toBe(0)
})

test('costOf: no usage or no price is no cost', () => {
  expect(costOf(undefined, { input: 1, output: 1 })).toBeUndefined()
  expect(costOf(u, undefined)).toBeUndefined()
})
