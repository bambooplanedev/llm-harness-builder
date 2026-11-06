import { test, expect, vi } from 'vitest'
import type { HarnessEvent } from '../src/core/events.js'

const calls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../src/core/diff', async orig => {
  const m = await orig<typeof import('../src/core/diff')>()
  return { ...m, requestDiff: (...a: Parameters<typeof m.requestDiff>) => (calls.n++, m.requestDiff(...a)) }
})
import { diffsBySeq, sourcesOf } from '../web/src/reqDiffs'

const req = (seq: number, system: string): HarnessEvent => ({ seq, turn: seq, ts: seq, type: 'llm_request', payload: { messages: [{ role: 'system', content: system }, { role: 'user', content: 'go' }] } })

test('diffsBySeq: an existing pair is not recomputed when a request is appended', () => {
  const evs = [req(0, 'a'), req(1, 'b')]
  expect(diffsBySeq(evs).size).toBe(1)
  expect(calls.n).toBe(1)
  evs.push(req(2, 'c'))
  expect(diffsBySeq(evs).size).toBe(2)
  expect(calls.n).toBe(2)
})

const srcCalls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../src/core/sources', async orig => {
  const m = await orig<typeof import('../src/core/sources')>()
  return { ...m, requestSources: (p: unknown) => (srcCalls.n++, m.requestSources(p)) }
})

test('sourcesOf: one array per event; a new event does not re-read the old ones', () => {
  const evs = [req(0, 'a'), req(1, 'b')]
  const first = evs.map(sourcesOf)
  expect(first[0]).toBeDefined()
  expect(srcCalls.n).toBe(2)
  evs.push(req(2, 'c'))
  const again = evs.map(sourcesOf)
  expect(again[0]).toBe(first[0])
  expect(again[1]).toBe(first[1])
  expect(srcCalls.n).toBe(3)
  const bad: HarnessEvent = { seq: 3, turn: 3, ts: 3, type: 'llm_request', payload: { model: 'm' } }
  expect(sourcesOf(bad)).toBeUndefined()
  expect(sourcesOf(bad)).toBeUndefined()
  expect(srcCalls.n).toBe(4)
})
