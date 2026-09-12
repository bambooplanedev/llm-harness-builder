import { test, expect } from 'vitest'
import { median, formatTable, type BenchHarness } from '../src/core/bench'

test('median: lower-middle of a numerically sorted copy, [] → 0', () => {
  expect(median([])).toBe(0)
  expect(median([3, 1, 2])).toBe(2)
  expect(median([1, 2, 3, 4])).toBe(2)
  expect(median([310000, 40000, 95000])).toBe(95000)
  const xs = [3, 1, 2]
  median(xs)
  expect(xs).toEqual([3, 1, 2])
})

test('formatTable: header, one row per harness, caption', () => {
  const h = (name: string, pass: number, reasons: Record<string, number>, turns: number, ms: number): BenchHarness =>
    ({ name, config: {} as BenchHarness['config'], pass, reasons, median: { turns, toolCalls: 0, ms }, runs: new Array(3).fill(null) as unknown as BenchHarness['runs'] })
  const t = formatTable([h('bare', 1, { final: 2, parse_failed: 1 }, 7, 310400), h('tuned-hermes', 3, { final: 3 }, 5, 40000)])
  const lines = t.split('\n')
  expect(lines[0]).toMatch(/^harness\s+PASS\s+reasons\s+med turns\s+med s$/)
  expect(lines[1]).toMatch(/^bare\s+1\/3\s+final×2 parse_failed×1\s+7\s+310$/)
  expect(lines[2]).toMatch(/^tuned-hermes\s+3\/3\s+final×3\s+5\s+40$/)
  expect(lines[3]).toBe('medians over all runs incl. failures; s = wall-clock per run')
})
