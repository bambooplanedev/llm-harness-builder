// src/core/diff.ts — pure helpers that compare two runs. No fs, no process, no Vue.
import { quitWithoutWork, type HarnessEvent } from './events.js'
import type { HarnessConfig } from './config.js'
import type { BenchRun } from './bench.js'

/** One side of a comparison: the bench row with its verdict, the harness config behind it, its trace. */
export type DiffSide = { name: string; run: BenchRun; config: HarnessConfig; events: HarnessEvent[] }

/** One thing a turn did. `truncated` is shown but deliberately kept out of `sig`. */
export type Chip = { label: string; bad: boolean; truncated?: boolean }
/** A turn as the diff sees it: what happened (chips, sig) and what it cost (ms, tokens). */
export type Turn = { chips: Chip[]; sig: string; ms: number; tokens: number }

/** Events grouped by turn, in the order the turns appear in the trace. */
export function turnsOf(events: HarnessEvent[]): HarnessEvent[][] {
  // turn 0 is pre-loop setup (mcp servers), not a turn — unless the run *ended* there, in which
  // case it is the only thing the diff has to show: counting it otherwise would shift every
  // later turn on one side of a diff and put the divergence marker in the wrong place.
  const endedAtZero = events.some(e => e.turn === 0 && e.type === 'done')
  const map = new Map<number, HarnessEvent[]>()
  for (const e of events) {
    if (e.turn === 0 && !endedAtZero) continue
    const g = map.get(e.turn)
    if (g) g.push(e); else map.set(e.turn, [e])
  }
  return [...map.values()]
}

/**
 * Compact per-turn signature of a trace: what happened, not what was said.
 * llm_request/llm_response/context_stats/approval_required produce no chip — every turn has them,
 * so they tell two runs apart in no way; the last two contribute the turn's cost instead.
 */
export function skeleton(events: HarnessEvent[]): Turn[] {
  return turnsOf(events).map(group => {
    const chips: Chip[] = []
    const byCall = new Map<string, Chip>() // a tool_result marks the chip its own call made
    let ms = 0, tokens = 0
    for (const e of group) {
      switch (e.type) {
        case 'llm_response': ms = e.latencyMs; break
        case 'context_stats': tokens = e.exactTokens ?? e.estimatedTokens; break
        case 'parse_error': chips.push({ label: 'parse error', bad: true, truncated: false }); break
        case 'error': chips.push({ label: 'error', bad: true, truncated: false }); break
        case 'final_check': chips.push({ label: e.passed ? 'check passed' : 'check failed', bad: !e.passed, truncated: false }); break
        case 'context_reset': chips.push({ label: 'context reset', bad: false, truncated: false }); break
        case 'tool_call': {
          const chip: Chip = { label: e.call.name, bad: false, truncated: false }
          byCall.set(e.call.callId, chip)
          chips.push(chip)
          break
        }
        case 'tool_result': {
          const chip = byCall.get(e.callId)
          if (chip) { chip.bad ||= e.error; chip.truncated ||= e.truncated }
          break
        }
        case 'done': chips.push({ label: `done: ${e.reason}`, bad: e.reason !== 'final' || quitWithoutWork(e), truncated: false }); break
      }
    }
    return { chips, ms, tokens, sig: chips.map(c => `${c.label}${c.bad ? '!' : ''}`).join(' ') }
  })
}

/** Every scalar and array of a config object, as dotted path → JSON text. Arrays stay whole leaves. */
function leaves(v: unknown, prefix = ''): [string, string][] {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return Object.entries(v).flatMap(([k, x]) => leaves(x, prefix ? `${prefix}.${k}` : k))
  }
  return [[prefix, JSON.stringify(v) ?? 'undefined']]
}

/**
 * Leaf-by-leaf difference of two harness configs. `name` is the harness's label, not a knob,
 * so it never counts as a difference. Order: a's leaves in their own order, then b-only ones.
 */
export function configDiff(a: HarnessConfig, b: HarnessConfig): { path: string; a: string; b: string }[] {
  const rest = new Map(leaves(b))
  const out: { path: string; a: string; b: string }[] = []
  for (const [path, av] of leaves(a)) {
    const bv = rest.get(path) ?? 'undefined'
    rest.delete(path)
    if (path !== 'name' && bv !== av) out.push({ path, a: av, b: bv })
  }
  for (const [path, bv] of rest) if (path !== 'name') out.push({ path, a: 'undefined', b: bv })
  return out
}

/**
 * Which lines only one side has. A set difference, not an LCS: two 2 KB system prompts side by
 * side are not a diff, "only in A: /no_think" is. Blank lines carry nothing and are dropped.
 */
export function lineDiff(a: string, b: string): { onlyA: string[]; onlyB: string[] } {
  const [sa, sb] = [a, b].map(s => new Set(s.split('\n').filter(l => l.trim())))
  return { onlyA: [...sa].filter(l => !sb.has(l)), onlyB: [...sb].filter(l => !sa.has(l)) }
}
