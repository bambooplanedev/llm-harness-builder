// src/core/diff.ts — pure helpers that compare two runs. No fs, no process, no Vue.
import type { HarnessEvent } from './events.js'

/** One thing a turn did. `truncated` is shown but deliberately kept out of `sig`. */
export type Chip = { label: string; bad: boolean; truncated?: boolean }
/** A turn as the diff sees it: what happened (chips, sig) and what it cost (ms, tokens). */
export type Turn = { chips: Chip[]; sig: string; ms: number; tokens: number }

/** Events grouped by turn, in the order the turns appear in the trace. */
export function turnsOf(events: HarnessEvent[]): HarnessEvent[][] {
  const map = new Map<number, HarnessEvent[]>()
  for (const e of events) {
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
        // `final` after zero tool calls is the failure Trace.vue already paints red:
        // the model answered without doing anything.
        case 'done': chips.push({ label: `done: ${e.reason}`, bad: e.reason !== 'final' || e.toolCallCount === 0, truncated: false }); break
      }
    }
    return { chips, ms, tokens, sig: chips.map(c => `${c.label}${c.bad ? '!' : ''}`).join(' ') }
  })
}
