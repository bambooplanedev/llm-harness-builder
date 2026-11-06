import { requestDiff, type ReqDiff } from '../../src/core/diff'
import type { HarnessEvent } from './api'

/** The diff of a request against the previous one, once per (event, previous payload): events never change after they arrive. */
const cache = new WeakMap<object, { prev: unknown; diff: ReqDiff | undefined }>()

/** seq of an llm_request → what it changed against the previous llm_request (any turn); no entry for the first or an unreadable pair. */
export function diffsBySeq(events: HarnessEvent[]): Map<number, ReqDiff> {
  const out = new Map<number, ReqDiff>()
  let prev: unknown, seen = false
  for (const e of events) {
    if (e.type !== 'llm_request') continue
    if (seen) {
      let c = cache.get(e)
      if (!c || c.prev !== prev) cache.set(e, c = { prev, diff: requestDiff(prev, e.payload) })
      if (c.diff) out.set(e.seq, c.diff)
    }
    prev = e.payload; seen = true
  }
  return out
}
