import { test, expect } from 'vitest'
import { median, formatTable, mmss, type BenchHarness, type BenchRun } from '../src/core/bench'

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
    ({ name, config: {} as BenchHarness['config'], pass, reasons, median: { turns, toolCalls: 0, ms }, runs: new Array(3).fill({}) as BenchHarness['runs'] })
  const t = formatTable([h('bare', 1, { final: 2, parse_failed: 1 }, 7, 310400), h('tuned-hermes', 3, { final: 3 }, 5, 40000)])
  const lines = t.split('\n')
  expect(lines[0]).toMatch(/^harness\s+PASS\s+reasons\s+med turns\s+med s$/)
  expect(lines[1]).toMatch(/^bare\s+1\/3\s+final×2 parse_failed×1\s+7\s+310$/)
  expect(lines[2]).toMatch(/^tuned-hermes\s+3\/3\s+final×3\s+5\s+40$/)
  expect(lines[3]).toBe('medians over all runs incl. failures; s = wall-clock per run')
  expect(formatTable([h('x', 0, {}, 0, 0)]).split('\n')[1]).toMatch(/^x\s+0\/3\s+-\s/)
})

test('mmss: seconds under two minutes, m:ss from there', () => {
  expect(mmss(0)).toBe('0s')
  expect(mmss(95_400)).toBe('95s')
  expect(mmss(119_400)).toBe('119s')
  expect(mmss(120_000)).toBe('2:00')
  expect(mmss(1_159_000)).toBe('19:19')
})

test('formatTable: tool columns only when a run measured them', () => {
  const h = (name: string, runs: Partial<BenchRun>[]): BenchHarness =>
    ({ name, config: {} as BenchHarness['config'], pass: 0, reasons: {}, median: { turns: 0, toolCalls: 0, ms: 0 }, runs: runs as BenchRun[] })
  expect(formatTable([h('tuned', [{ toolErrors: 2 }, {}])]).split('\n')[0]).not.toContain('toolChars')
  const lines = formatTable([
    h('mcp-off', [{ toolErrors: 1 }, { toolErrors: 3 }]),
    h('mcp-on', [{ toolChars: 7167, toolErrors: 4 }, { toolChars: 7167, toolErrors: 6 }]),
  ]).split('\n')
  expect(lines[0]).toMatch(/^harness\s+PASS\s+reasons\s+med turns\s+med s\s+toolChars\s+med errs$/)
  expect(lines[1]).toMatch(/^mcp-off\s+0\/2\s+-\s+0\s+0\s+-\s+1$/)
  expect(lines[2]).toMatch(/^mcp-on\s+0\/2\s+-\s+0\s+0\s+7167\s+4$/)
})

test('formatTable: guard columns appear only when a run measured them, and are sums', () => {
  const h = (name: string, runs: Partial<BenchRun>[]): BenchHarness =>
    ({ name, config: {} as BenchHarness['config'], pass: 0, reasons: {}, median: { turns: 0, toolCalls: 0, ms: 0 }, runs: runs as BenchRun[] })
  expect(formatTable([h('tuned', [{ toolErrors: 2 }, {}])]).split('\n')[0]).not.toContain('guard')
  const lines = formatTable([
    h('tuned', [{ guardBlocks: 0, editMiss: 2 }, { guardBlocks: 0, editMiss: 1 }]),
    h('guard-only', [{ guardBlocks: 3, editMiss: 0 }, { guardBlocks: 1, editMiss: 0 }]),
  ]).split('\n')
  expect(lines[0]).toMatch(/guard\s+editMiss\s*$/)
  expect(lines[1]).toMatch(/\s0\s+3\s*$/)   // tuned: 0 guard blocks, 3 edit misses
  expect(lines[2]).toMatch(/\s4\s+0\s*$/)   // guard-only: 4 guard blocks, 0 edit misses
})

test('formatTable: an arm that had the guard off shows "-", not a misleading 0', () => {
  const h = (name: string, runs: Partial<BenchRun>[]): BenchHarness =>
    ({ name, config: {} as BenchHarness['config'], pass: 0, reasons: {}, median: { turns: 0, toolCalls: 0, ms: 0 }, runs: runs as BenchRun[] })
  const lines = formatTable([
    h('rule-none', [{ editMiss: 2 }, { editMiss: 0 }]),          // guard off: field absent
    h('guard-only', [{ guardBlocks: 1, editMiss: 0 }]),
  ]).split('\n')
  expect(lines[1]).toMatch(/\s-\s+2\s*$/)
  expect(lines[2]).toMatch(/\s1\s+0\s*$/)
})

test('formatTable: editMiss gets its own column, independent of guard — e.g. rule-none vs tuned, both guard-off', () => {
  const h = (name: string, runs: Partial<BenchRun>[]): BenchHarness =>
    ({ name, config: {} as BenchHarness['config'], pass: 0, reasons: {}, median: { turns: 0, toolCalls: 0, ms: 0 }, runs: runs as BenchRun[] })
  const lines = formatTable([
    h('rule-none', [{ editMiss: 3 }, { editMiss: 1 }]),
    h('tuned', [{ editMiss: 1 }, { editMiss: 0 }]),
  ]).split('\n')
  expect(lines[0]).toMatch(/^harness\s+PASS\s+reasons\s+med turns\s+med s\s+editMiss$/)
  expect(lines[0]).not.toContain('guard')
  expect(lines[1]).toMatch(/\s4\s*$/)
  expect(lines[2]).toMatch(/\s1\s*$/)
})
