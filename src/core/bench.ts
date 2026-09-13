// src/core/bench.ts — result shape of `bench` and the pure helpers that summarise it. No fs, no process.
import type { DoneReason } from './events.js'
import type { HarnessConfig } from './config.js'

export type BenchRun = {
  round: number; verdict: 'PASS' | 'FAIL'; reason: DoneReason | 'error'
  turns: number; toolCalls: number; parseErrors: number; lastError?: string; ms: number; workdir: string
  /** Id of the run's trace, runs/<trace>.jsonl. Absent when the run failed before it had one, and in JSON written before v2.0.3. */
  trace?: string
}
export type BenchHarness = {
  name: string; config: HarnessConfig; pass: number; reasons: Record<string, number>
  median: { turns: number; toolCalls: number; ms: number }; runs: BenchRun[]
}
export type BenchResult = { version: 1; date: string; task: string; n: number; timeoutS: number; complete: boolean; harnesses: BenchHarness[] }

/** Lower-middle element of the numerically sorted copy; [] → 0. Never mutates xs. */
export const median = (xs: number[]): number => xs.length ? [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1] : 0

export function formatTable(harnesses: BenchHarness[]): string {
  const head = ['harness', 'PASS', 'reasons', 'med turns', 'med s']
  const rows = harnesses.map(h => [
    h.name, `${h.pass}/${h.runs.length}`,
    Object.entries(h.reasons).map(([k, v]) => `${k}×${v}`).join(' ') || '-',
    String(h.median.turns), String(Math.round(h.median.ms / 1000)),
  ])
  const w = head.map((c, i) => Math.max(c.length, ...rows.map(r => r[i].length)) + 2)
  const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i])).join('').trimEnd()
  return [line(head), ...rows.map(line), 'medians over all runs incl. failures; s = wall-clock per run'].join('\n')
}
