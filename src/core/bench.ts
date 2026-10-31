// src/core/bench.ts — result shape of `bench` and the pure helpers that summarise it. No fs, no process.
import type { DoneReason, HarnessEvent } from './events.js'
import type { HarnessConfig } from './config.js'
import { costCheck, type Cost } from './evolve-cost.js'
import type { RunLite } from './evolve.js'

export type BenchRun = {
  round: number; verdict: 'PASS' | 'FAIL'; reason: DoneReason | 'error'
  turns: number; toolCalls: number; parseErrors: number; lastError?: string; ms: number; workdir: string
  /** Id of the run's trace, runs/<trace>.jsonl. Absent when the run failed before it had one, and in JSON written before v2.0.3. */
  trace?: string
  /** description + schema characters every mcp server put in front of the model. Absent when the harness has no mcp server. */
  toolChars?: number
  /** Model time: the sum of the replies' latencyMs, 429 pauses left out. 0 when no reply came; absent in older JSON. */
  modelMs?: number
  /** Dollars the run's replies cost: the sum of their costUsd. Absent when the harness has no price or the server reported no usage. */
  costUsd?: number
  /** The biggest prompt + reply of the run, in the server's own tokens: how close it came to the window. Absent when the server reported no usage, and in older JSON. */
  peakTokens?: number
  /** The run's replies' prompt + completion tokens added up: what the run cost in the server's own tokens. 0 when no reply came at all; absent when replies came without usage, and in older JSON. */
  tokens?: number
  /** The prompt tokens of the run's first reply: what the harness puts in front of the model before any work. Absent when that reply had no usage. */
  firstPromptTokens?: number
  /** Calls per tool name, built-in and mcp: what the run did. Absent in JSON written before v2.59. */
  toolCounts?: Record<string, number>
  /** Lines of tool output the model saw (after any cut; a final newline is not a line). Absent in older JSON. */
  outputLines?: number
  /** The sum of the replies' usage.completion_tokens_details.reasoning_tokens. Absent when no reply reported it: a server that does not say is not a server that said 0. */
  reasoningTokens?: number
  /** Tool results that came back as errors — mcp or built-in. */
  toolErrors?: number
  /** Edits the read-before-edit guard refused. Absent when the harness had the guard off. */
  guardBlocks?: number
  /** Edits whose "old" did not occur exactly once. Absent in JSON written before v2.2. */
  editMiss?: number
  /** The task's name in a bench on the user's own tasks (bench --tasks). */
  task?: string
  /** Green tests of a task that counts them (polyglot); total is fixed per exercise, also for a run that died before its check. */
  tests?: { passed: number; total: number }
  /** The status that ended the run when it is one evolve stops on (isStop); the check did not run. */
  stop?: number
  /** That stop was a 429 after part of the reply had streamed: not retried. */
  stopMidReply?: boolean
}
export type BenchHarness = {
  name: string; config: HarnessConfig; pass: number; reasons: Record<string, number>
  median: { turns: number; toolCalls: number; ms: number }; runs: BenchRun[]
  /** What preflight learnt from the server: its window (Ollama: the harness's numCtx) and llama-server's build. Absent in JSON written before v2.27, and under the test backend. */
  server?: { nCtx?: number; build?: string }
  /** Sum of the runs' tests; set only when some run has them. */
  tests?: { passed: number; total: number }
}
export type BenchResult = { version: 1; date: string; task: string; taskName?: string; size?: number; node?: string; n: number; timeoutS: number; complete: boolean;
  /** bench --tasks: the repo (real path) and the commit its lhb-tasks.json was read from; taskName is 'tasks'. */
  tasksRepo?: string; tasksSha?: string; taskCount?: number; only?: string[]
  /** Set by Ctrl-C (or Stop bench on the page): no run of it is live any more, though its last .part stays. */
  stopped?: boolean; harnesses: BenchHarness[] }

/** One row of the Bench tab's file list. `model` and the file name tell two bench files apart; `task` is the prompt text, `taskName`/`size` say which task it was (absent in JSON written before v2.7 = slug). */
export type BenchFile = { file: string; date: string; model: string; complete: boolean }
/** The run a `bench` process is executing right now, read from its still-unrenamed runs/<id>.jsonl.part. */
export type ActiveTrace = { id: string; harness: string; round: number; started: number; events: HarnessEvent[] }

/** demo and bench pass yes: true — that approves the harness files' mcpServers and loop.untilBash too, not only the model's commands. The Bench page shows the same words. */
export const autoApproves = (cmd: 'demo' | 'bench' | 'evolve') => `${cmd} approves everything without asking: the model's commands and the harness files' mcpServers and loop.untilBash, in fresh temp workdirs`

/** The tasks `bench` runs and the largest size of each (0 = no sizes), for the page: tasks.ts reads files and cannot reach the browser. A test keeps the two equal. */
export const BENCH_TASKS: Record<string, number> = { slug: 0, pool: 10, pool2: 10, pool3: 10, sift: 12, triage: 12, judge: 12, polyglot: 47 }

/** What the Bench page starts a task's size at: polyglot is slow, so 5 of its 47; the rest start at their largest. */
export const defaultSize = (task: string): number => task === 'polyglot' ? 5 : BENCH_TASKS[task]

/** Local time as YYYYMMDD-HHMMSS. */
export const stamp = (d = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** The default name of a bench JSON, from local time: bench-YYYYMMDD-HHMMSS.json. */
export const benchFileName = (d: Date): string => `bench-${stamp(d)}.json`

/** Lower-middle element of the numerically sorted copy; [] → 0. Never mutates xs. */
export const median = (xs: number[]): number => xs.length ? [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1] : 0

/** Four of five `bare` runs are over 900 s: 1800s reads worse than 30:00. */
export const mmss = (ms: number): string => {
  const s = Math.round(ms / 1000)
  return s < 120 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 95% Wilson score interval of a PASS rate, as [low, high] in 0..1; no runs → undefined. At n = 3 it is wide on purpose: 1/3 is 0.06–0.79. */
export function wilson(pass: number, n: number, z = 1.96): [number, number] | undefined {
  if (n <= 0) return undefined
  const p = pass / n, z2 = z * z
  const center = (p + z2 / (2 * n)) / (1 + z2 / n)
  const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n)
  return [Math.max(0, center - half), Math.min(1, center + half)]
}

const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length
/** Calls per run by tool, over the runs that counted them: "bash 2.5 read_file 1"; '-' when none did. */
const toolsCell = (runs: BenchRun[]): string => {
  const rs = runs.filter(r => r.toolCounts), names = [...new Set(rs.flatMap(r => Object.keys(r.toolCounts!)))].sort()
  return rs.length ? names.map(k => `${k} ${Number(mean(rs.map(r => r.toolCounts![k] ?? 0)).toFixed(1))}`).join(' ') || '0' : '-'
}
const meanCell = (xs: (number | undefined)[]): string => { const v = xs.flatMap(x => x ?? []); return v.length ? String(Number(mean(v).toFixed(1))) : '-' }

/** The wide columns of each harness, in order: turns, tokens, model time, dollars per success on the tasks shared with the base
 *  (the first harness on the same model), then tool use. A cost past evolve's tolerance against the base ends in "!"; nothing is refused. */
export function wideCells(harnesses: BenchHarness[]): string[][] {
  const lite = (h: BenchHarness) => h.runs.map(r => ({ task: r.task ?? 'task', verdict: r.verdict, turns: r.turns, tokens: r.tokens, modelMs: r.modelMs ?? r.ms }))
  const pick = { turns: (r: RunLite) => r.turns, tokens: (r: RunLite) => r.tokens, time: (r: RunLite) => r.modelMs }
  return harnesses.map(h => {
    const base = harnesses.find(b => b.config.backend?.model === h.config.backend?.model)!
    const passes = lite(h).filter(r => r.verdict === 'PASS')
    const cell = (cost: Cost, f: (x: number) => string) => {
      const c = costCheck(lite(base), lite(h), cost, base.config.loop?.maxTurns ?? Infinity)
      if (c) return f(base === h ? c.before : c.after) + (c.over && base !== h ? '!' : '')
      // Under MIN_SHARED there is no base to judge by: the plain mean per pass, never marked.
      const v = passes.flatMap(r => pick[cost](r) ?? [])
      return v.length ? f(mean(v)) : '-'
    }
    const paid = h.runs.flatMap(r => r.verdict === 'PASS' && r.costUsd !== undefined ? r.costUsd : [])
    return [cell('turns', x => x.toFixed(1)), cell('tokens', x => String(Math.round(x))), cell('time', x => (x / 1000).toFixed(1)),
      paid.length ? String(Number(mean(paid).toPrecision(4))) : '-', toolsCell(h.runs), meanCell(h.runs.map(r => r.outputLines)), meanCell(h.runs.map(r => r.reasoningTokens))]
  })
}
export const WIDE_HEAD = ['turns/ok', 'tok/ok', 'model s/ok', '$/ok', 'tools', 'out lines', 'reason tok']

/** `wide` adds the tool-use and per-success columns; without it the table is what it always was. */
export function formatTable(harnesses: BenchHarness[], opts: { wide?: boolean } = {}): string {
  // The tool columns only earn their width when a run measured them: a bench of built-in harnesses
  // prints exactly the table it printed before mcp existed.
  const tools = harnesses.some(h => h.runs.some(r => r.toolChars))
  const cost = harnesses.some(h => h.runs.some(r => r.costUsd !== undefined))
  const guard = harnesses.some(h => h.runs.some(r => r.guardBlocks !== undefined))
  const miss = harnesses.some(h => h.runs.some(r => r.editMiss !== undefined))
  const tests = harnesses.some(h => h.tests)
  const sum = (xs: (number | undefined)[]) => xs.reduce<number>((a, x) => a + (x ?? 0), 0)
  const head = ['harness', 'PASS', '95% CI', 'reasons', 'med turns', 'med s', ...tools ? ['toolChars', 'med errs'] : [], ...cost ? ['med $'] : [], ...guard ? ['guard'] : [], ...miss ? ['editMiss'] : [], ...tests ? ['tests'] : [], ...opts.wide ? WIDE_HEAD : []]
  const wide = opts.wide ? wideCells(harnesses) : []
  const rows = harnesses.map((h, i) => [
    h.name, `${h.pass}/${h.runs.length}`,
    wilson(h.pass, h.runs.length)?.map(x => x.toFixed(2)).join('–') ?? '-',
    Object.entries(h.reasons).map(([k, v]) => `${k}×${v}`).join(' ') || '-',
    String(h.median.turns), String(Math.round(h.median.ms / 1000)),
    // toolChars is the same in every run of a harness, so it is taken, not averaged.
    ...tools ? [String(h.runs.find(r => r.toolChars)?.toolChars ?? '-'), String(median(h.runs.map(r => r.toolErrors ?? 0)))] : [],
    ...cost ? [h.runs.some(r => r.costUsd !== undefined) ? String(Number(median(h.runs.flatMap(r => r.costUsd ?? [])).toPrecision(4))) : '-'] : [],
    // Sums, not medians: a median of five small integers is 0 and hides the signal. An arm whose
    // runs never defined guardBlocks had the guard off and could not produce one — "-", not 0.
    ...guard ? [h.runs.some(r => r.guardBlocks !== undefined) ? String(sum(h.runs.map(r => r.guardBlocks))) : '-'] : [],
    ...miss ? [String(sum(h.runs.map(r => r.editMiss)))] : [],
    ...tests ? [h.tests ? `${h.tests.passed}/${h.tests.total}` : '-'] : [],
    ...wide[i] ?? [],
  ])
  const w = head.map((c, i) => Math.max(c.length, ...rows.map(r => r[i].length)) + 2)
  const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i])).join('').trimEnd()
  return [line(head), ...rows.map(line), 'medians over all runs incl. failures; s = wall-clock per run',
    '95% CI = Wilson interval of the PASS rate; two harnesses whose intervals overlap are not told apart by this bench',
    ...opts.wide ? ['turns/ok, tok/ok, model s/ok: on 5+ tasks shared with the first harness of the same model, the mean over those tasks\' passes, and ! = dearer than evolve allows; under 5, a plain mean per pass, never marked. A JSON without model time falls back to wall-clock.',
      '$/ok = plain mean over all passes, never marked. tools, out lines, reason tok = mean per run. - = not reported'] : [],
    ...tests ? ['tests = green tests over all runs; no interval: the tests of one exercise are not independent'] : []].join('\n')
}

/** How many runs a bench makes: n per harness, per task of a tasks bench. */
export const benchTotal = (r: Pick<BenchResult, 'n' | 'harnesses' | 'taskCount'>): number => r.n * r.harnesses.length * (r.taskCount ?? 1)

/** A run's heading on the Bench page: its round, and its task in a tasks bench. */
export const runTitle = (r: Pick<BenchRun, 'round' | 'task'>): string => `#${r.round}${r.task ? ` ${r.task}` : ''}`
