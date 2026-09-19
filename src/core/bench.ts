// src/core/bench.ts — result shape of `bench` and the pure helpers that summarise it. No fs, no process.
import type { DoneReason, HarnessEvent } from './events.js'
import type { HarnessConfig } from './config.js'

export type BenchRun = {
  round: number; verdict: 'PASS' | 'FAIL'; reason: DoneReason | 'error'
  turns: number; toolCalls: number; parseErrors: number; lastError?: string; ms: number; workdir: string
  /** Id of the run's trace, runs/<trace>.jsonl. Absent when the run failed before it had one, and in JSON written before v2.0.3. */
  trace?: string
  /** description + schema characters every mcp server put in front of the model. Absent when the harness has no mcp server. */
  toolChars?: number
  /** Tool results that came back as errors — mcp or built-in. */
  toolErrors?: number
  /** Edits the read-before-edit guard refused. Absent when the harness had the guard off. */
  guardBlocks?: number
  /** Edits whose "old" did not occur exactly once. Absent in JSON written before v2.2. */
  editMiss?: number
}
export type BenchHarness = {
  name: string; config: HarnessConfig; pass: number; reasons: Record<string, number>
  median: { turns: number; toolCalls: number; ms: number }; runs: BenchRun[]
}
export type BenchResult = { version: 1; date: string; task: string; n: number; timeoutS: number; complete: boolean; harnesses: BenchHarness[] }

/** One row of the Bench tab's file list. `model` is what actually tells two bench files apart: `task` is always DEMO_TASK. */
export type BenchFile = { file: string; date: string; model: string; complete: boolean }
/** The run a `bench` process is executing right now, read from its still-unrenamed runs/<id>.jsonl.part. */
export type ActiveTrace = { id: string; harness: string; round: number; started: number; events: HarnessEvent[] }

/** Lower-middle element of the numerically sorted copy; [] → 0. Never mutates xs. */
export const median = (xs: number[]): number => xs.length ? [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1] : 0

/** Four of five `bare` runs are over 900 s: 1800s reads worse than 30:00. */
export const mmss = (ms: number): string => {
  const s = Math.round(ms / 1000)
  return s < 120 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function formatTable(harnesses: BenchHarness[]): string {
  // The tool columns only earn their width when a run measured them: a bench of built-in harnesses
  // prints exactly the table it printed before mcp existed.
  const tools = harnesses.some(h => h.runs.some(r => r.toolChars))
  const guard = harnesses.some(h => h.runs.some(r => r.guardBlocks !== undefined))
  const miss = harnesses.some(h => h.runs.some(r => r.editMiss !== undefined))
  const sum = (xs: (number | undefined)[]) => xs.reduce<number>((a, x) => a + (x ?? 0), 0)
  const head = ['harness', 'PASS', 'reasons', 'med turns', 'med s', ...tools ? ['toolChars', 'med errs'] : [], ...guard ? ['guard'] : [], ...miss ? ['editMiss'] : []]
  const rows = harnesses.map(h => [
    h.name, `${h.pass}/${h.runs.length}`,
    Object.entries(h.reasons).map(([k, v]) => `${k}×${v}`).join(' ') || '-',
    String(h.median.turns), String(Math.round(h.median.ms / 1000)),
    // toolChars is the same in every run of a harness, so it is taken, not averaged.
    ...tools ? [String(h.runs.find(r => r.toolChars)?.toolChars ?? '-'), String(median(h.runs.map(r => r.toolErrors ?? 0)))] : [],
    // Sums, not medians: a median of five small integers is 0 and hides the signal. An arm whose
    // runs never defined guardBlocks had the guard off and could not produce one — "-", not 0.
    ...guard ? [h.runs.some(r => r.guardBlocks !== undefined) ? String(sum(h.runs.map(r => r.guardBlocks))) : '-'] : [],
    ...miss ? [String(sum(h.runs.map(r => r.editMiss)))] : [],
  ])
  const w = head.map((c, i) => Math.max(c.length, ...rows.map(r => r[i].length)) + 2)
  const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i])).join('').trimEnd()
  return [line(head), ...rows.map(line), 'medians over all runs incl. failures; s = wall-clock per run'].join('\n')
}
