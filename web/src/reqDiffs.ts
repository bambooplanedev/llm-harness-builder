import { requestDiff, type ReqDiff } from '../../src/core/diff'
import { requestSources, type Source } from '../../src/core/sources'
import type { HarnessEvent } from './api'

/** Most lines one diff block renders; the rest is counted, not drawn. */
export const MAX_DIFF_LINES = 100
/** Most chars an opened source row shows; the rest is counted. */
export const MAX_SOURCE_CHARS = 20000

/** Where each part of a request came from, read once per event (undefined is cached too). */
const srcCache = new WeakMap<object, Source[] | undefined>()
export function sourcesOf(e: HarnessEvent): Source[] | undefined {
  if (e.type !== 'llm_request') return undefined
  if (!srcCache.has(e)) srcCache.set(e, requestSources(e.payload))
  return srcCache.get(e)
}

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

/** A request set against the same-numbered request of another run: `k` is its 1-based ordinal; `missing` = the other run has no k-th; no entry for an unreadable pair. */
export type Versus = { k: number; diff?: ReqDiff; missing?: true }
const vsCache = new WeakMap<object, { other: unknown; diff: ReqDiff | undefined }>()

/** seq of an llm_request → how it differs from the same-numbered request of `other`. */
export function versusBySeq(events: HarnessEvent[], other: HarnessEvent[]): Map<number, Versus> {
  const out = new Map<number, Versus>()
  const theirs = other.filter(o => o.type === 'llm_request')
  let k = 0
  for (const e of events) {
    if (e.type !== 'llm_request') continue
    k++
    if (k > theirs.length) { out.set(e.seq, { k, missing: true }); continue }
    const payload = (theirs[k - 1] as Extract<HarnessEvent, { type: 'llm_request' }>).payload
    let c = vsCache.get(e)
    if (!c || c.other !== payload) vsCache.set(e, c = { other: payload, diff: requestDiff(payload, e.payload) })
    if (c.diff) out.set(e.seq, { k, diff: c.diff })
  }
  return out
}
