import { test, expect, vi } from 'vitest'
import type { HarnessEvent } from '../src/core/events.js'

const calls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../src/core/diff', async orig => {
  const m = await orig<typeof import('../src/core/diff')>()
  return { ...m, requestDiff: (...a: Parameters<typeof m.requestDiff>) => (calls.n++, m.requestDiff(...a)) }
})
import { diffsBySeq } from '../web/src/reqDiffs'

const req = (seq: number, system: string): HarnessEvent => ({ seq, turn: seq, ts: seq, type: 'llm_request', payload: { messages: [{ role: 'system', content: system }, { role: 'user', content: 'go' }] } })

test('diffsBySeq: an existing pair is not recomputed when a request is appended', () => {
  const evs = [req(0, 'a'), req(1, 'b')]
  expect(diffsBySeq(evs).size).toBe(1)
  expect(calls.n).toBe(1)
  evs.push(req(2, 'c'))
  expect(diffsBySeq(evs).size).toBe(2)
  expect(calls.n).toBe(2)
})
