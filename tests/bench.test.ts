import { test, expect } from 'vitest'
import { median, formatTable, mmss, wilson, benchTotal, runTitle, defaultSize, type BenchHarness, type BenchRun } from '../src/core/bench'

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
  expect(lines[0]).toMatch(/^harness\s+PASS\s+95% CI\s+reasons\s+med turns\s+med s$/)
  expect(lines[1]).toMatch(/^bare\s+1\/3\s+0\.06–0\.79\s+final×2 parse_failed×1\s+7\s+310$/)
  expect(lines[2]).toMatch(/^tuned-hermes\s+3\/3\s+0\.44–1\.00\s+final×3\s+5\s+40$/)
  expect(lines[3]).toBe('medians over all runs incl. failures; s = wall-clock per run')
  expect(lines[4]).toBe('95% CI = Wilson interval of the PASS rate; two harnesses whose intervals overlap are not told apart by this bench')
  expect(formatTable([h('x', 0, {}, 0, 0)]).split('\n')[1]).toMatch(/^x\s+0\/3\s+0\.00–0\.56\s+-\s/)
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
  expect(lines[0]).toMatch(/^harness\s+PASS\s+95% CI\s+reasons\s+med turns\s+med s\s+toolChars\s+med errs$/)
  expect(lines[1]).toMatch(/^mcp-off\s+0\/2\s+0\.00–0\.66\s+-\s+0\s+0\s+-\s+1$/)
  expect(lines[2]).toMatch(/^mcp-on\s+0\/2\s+0\.00–0\.66\s+-\s+0\s+0\s+7167\s+4$/)
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
  expect(lines[0]).toMatch(/^harness\s+PASS\s+95% CI\s+reasons\s+med turns\s+med s\s+editMiss$/)
  expect(lines[0]).not.toContain('guard')
  expect(lines[1]).toMatch(/\s4\s*$/)
  expect(lines[2]).toMatch(/\s1\s*$/)
})

test('wilson: 95% interval of a PASS rate, the rows the README reads; no runs → undefined', () => {
  const f = (p: number, n: number) => wilson(p, n)!.map(x => x.toFixed(2)).join('–')
  expect([f(0, 3), f(1, 3), f(2, 3), f(3, 3), f(1, 5), f(5, 5), f(9, 9)])
    .toEqual(['0.00–0.56', '0.06–0.79', '0.21–0.94', '0.44–1.00', '0.04–0.62', '0.57–1.00', '0.70–1.00'])
  expect(wilson(0, 0)).toBeUndefined()
})

test('formatTable: a harness with no finished run yet shows "-" for its interval', () => {
  const t = formatTable([{ name: 'x', config: {} as BenchHarness['config'], pass: 0, reasons: {}, median: { turns: 0, toolCalls: 0, ms: 0 }, runs: [] }])
  expect(t.split('\n')[1]).toMatch(/^x\s+0\/0\s+-\s+-\s/)
})

test('formatTable: med $ column only when a run carries a cost', () => {
  const h = (name: string, runs: Partial<BenchRun>[]): BenchHarness =>
    ({ name, config: {} as BenchHarness['config'], pass: 0, reasons: {}, median: { turns: 0, toolCalls: 0, ms: 0 }, runs: runs as BenchRun[] })
  expect(formatTable([h('a', [{}, {}])]).split('\n')[0]).not.toContain('med $')
  const lines = formatTable([h('a', [{ costUsd: 0.0123 }]), h('b', [{}])]).split('\n')
  expect(lines[0]).toMatch(/\s+med \$$/)
  expect(lines[1]).toMatch(/\s+0\.0123$/)
  expect(lines[2]).toMatch(/\s+-$/)
})

test('benchTotal counts the tasks of a tasks bench; runTitle names the task', () => {
  const r = { n: 3, harnesses: [{}, {}], taskCount: 4 } as any
  expect(benchTotal(r)).toBe(24)
  expect(benchTotal({ ...r, taskCount: undefined })).toBe(6)
  expect(runTitle({ round: 2, task: 'limit' } as any)).toBe('#2 limit')
  expect(runTitle({ round: 2 } as any)).toBe('#2')
})

test('formatTable: a tests column only when a run carries tests, with its footer and no interval', () => {
  const h = (name: string, runs: Partial<BenchRun>[], tests?: { passed: number; total: number }): BenchHarness =>
    ({ name, config: {} as BenchHarness['config'], pass: 0, reasons: {}, median: { turns: 0, toolCalls: 0, ms: 0 }, runs: runs as BenchRun[], ...tests ? { tests } : {} })
  const plain = formatTable([h('a', [{}])])
  // byte-identical to the table before polyglot existed
  expect(plain).toBe('harness  PASS  95% CI     reasons  med turns  med s\na        0/1   0.00–0.79  -        0          0\nmedians over all runs incl. failures; s = wall-clock per run\n95% CI = Wilson interval of the PASS rate; two harnesses whose intervals overlap are not told apart by this bench')
  const t = formatTable([h('a', [{ tests: { passed: 3, total: 10 } }], { passed: 3, total: 10 }), h('b', [{}])]).split('\n')
  expect(t[0]).toMatch(/\btests$/)
  expect(t[1]).toMatch(/3\/10$/)
  expect(t[2]).toMatch(/-$/)
  expect(t.at(-1)).toBe('tests = green tests over all runs; no interval: the tests of one exercise are not independent')
})

test('defaultSize: polyglot starts at 5, the rest at their largest', () => {
  expect(defaultSize('polyglot')).toBe(5)
  expect(defaultSize('pool')).toBe(10)
  expect(defaultSize('slug')).toBe(0)
})

// Pinned before --wide existed: the plain table is byte for byte what it was.
const gold = (name: string, runs: Partial<BenchRun>[], tests?: { passed: number; total: number }): BenchHarness =>
  ({ name, config: { backend: { model: 'm' }, loop: { maxTurns: 10 } } as BenchHarness['config'], pass: runs.filter(r => r.verdict === 'PASS').length, reasons: { final: 2, max_turns: 1 }, median: { turns: 4, toolCalls: 3, ms: 61000 }, tests,
    runs: runs.map((r, i) => ({ round: i + 1, verdict: 'FAIL', reason: 'final', turns: 4, toolCalls: 3, parseErrors: 0, ms: 61000, workdir: '/w', ...r })) as BenchRun[] })
test('formatTable: the plain table is unchanged by --wide existing (golden)', () => {
  const hs = [
    gold('bare', [{ verdict: 'PASS', costUsd: 0.012, toolChars: 900, toolErrors: 1, guardBlocks: 2, editMiss: 1 }, { costUsd: 0.02, toolErrors: 0, guardBlocks: 0, editMiss: 0 }, { verdict: 'PASS', costUsd: 0.5, toolErrors: 3, guardBlocks: 1, editMiss: 2 }], { passed: 7, total: 9 }),
    gold('tuned', [{ verdict: 'PASS', toolErrors: 0 }, { verdict: 'PASS' }, { verdict: 'PASS' }]),
  ]
  expect(formatTable(hs)).toMatchInlineSnapshot(`
    "harness  PASS  95% CI     reasons              med turns  med s  toolChars  med errs  med $  guard  editMiss  tests
    bare     2/3   0.21–0.94  final×2 max_turns×1  4          61     900        1         0.02   3      3         7/9
    tuned    3/3   0.44–1.00  final×2 max_turns×1  4          61     -          0         -      -      0         -
    medians over all runs incl. failures; s = wall-clock per run
    95% CI = Wilson interval of the PASS rate; two harnesses whose intervals overlap are not told apart by this bench
    tests = green tests over all runs; no interval: the tests of one exercise are not independent"
  `)
})

const five = (over: Partial<BenchRun>, extra: Partial<BenchRun> = {}) => ['a', 'b', 'c', 'd', 'e'].map(t => ({ task: t, verdict: 'PASS' as const, turns: 4, tokens: 1000, modelMs: 2000, ...over, ...extra }))
test('formatTable --wide: tool use columns, "-" for missing, 0 stays 0', () => {
  const hs = [gold('x', [{ toolCounts: { bash: 2, read_file: 4 }, outputLines: 10, reasoningTokens: 0 }, { toolCounts: {}, outputLines: 0 }, {}])]
  const [head, row] = formatTable(hs, { wide: true }).split('\n')
  expect(head).toMatch(/turns\/ok\s+tok\/ok\s+model s\/ok\s+\$\/ok\s+tools\s+out lines\s+reason tok$/)
  expect(row).toMatch(/\s-\s+-\s+-\s+-\s+bash 1 read_file 2\s+5\s+0$/)
  expect(formatTable(hs, { wide: true }).split('\n')[0]).toContain('med turns')
})
test('formatTable --wide: per-success costs on shared successes; over tolerance gets "!", nothing is refused', () => {
  const hs = [gold('base', five({}, { costUsd: 0.01 })), gold('dear', five({ turns: 8, tokens: 1000, modelMs: 2000 }, { costUsd: 0.03 }))]
  const [, base, dear] = formatTable(hs, { wide: true }).split('\n')
  expect(base).toMatch(/\s4\.0\s+1000\s+2\.0\s+0\.01\s/)
  expect(dear).toMatch(/\s8\.0!\s+1000\s+2\.0\s+0\.03\s/)
  expect(base).not.toContain('!')
})
test('formatTable --wide: under five shared tasks the cost cells are "-"; time falls back to ms', () => {
  const few = gold('base', five({}).slice(0, 4))
  expect(formatTable([few], { wide: true }).split('\n')[1]).toMatch(/\s4\.0\s+1000\s+2\.0\s+-\s+-\s+-\s+-$/)
  expect(formatTable([gold('none', [{}])], { wide: true }).split('\n')[1]).toMatch(/\s-\s+-\s+-\s+-\s+-\s+-\s+-$/)
  const old = gold('base', five({ modelMs: undefined, ms: 3000 }))
  expect(formatTable([old], { wide: true }).split('\n')[1]).toMatch(/\s3\.0\s/)
})
test('formatTable --wide: the base is the first harness on the same model; another model has its own', () => {
  const m = (name: string, model: string, over: Partial<BenchRun>) => ({ ...gold(name, five(over)), config: { backend: { model }, loop: { maxTurns: 10 } } as BenchHarness['config'] })
  const t = formatTable([m('a1', 'A', {}), m('b1', 'B', { turns: 8 }), m('a2', 'A', { turns: 8 })], { wide: true }).split('\n')
  expect(t[2]).not.toContain('!')
  expect(t[3]).toContain('8.0!')
})

test('formatTable --wide: an old JSON with a bare config renders without throwing', () => {
  const h = { ...gold('old', [{ verdict: 'PASS', ms: 5000 }]), config: {} as BenchHarness['config'] }
  expect(formatTable([h], { wide: true }).split('\n')[1]).toMatch(/\s4\.0\s+-\s+5\.0\s/)
})
