import { test, expect } from 'vitest'
import { analyzeTrace, editKind, normPath, describeCall } from '../src/core/analyze.js'
import type { HarnessEvent } from '../src/core/events.js'

let seq = 0
const e = (turn: number, x: Record<string, unknown>) => ({ seq: seq++, turn, ts: 0, ...x }) as HarnessEvent
const call = (turn: number, callId: string, name: string, args: Record<string, unknown>) => e(turn, { type: 'tool_call', call: { callId, name, args } })
const result = (turn: number, callId: string, name: string, output: string, error = false) => e(turn, { type: 'tool_result', callId, name, output, error })

test('editKind reads the real tool error texts; an unknown text is other, not lost', () => {
  expect(editKind('tool edit_file failed: "old" must occur exactly once; found 0 occurrences')).toBe('zero')
  expect(editKind('tool edit_file failed: "old" must occur exactly once; found 2 occurrences')).toBe('many')
  expect(editKind('tool edit_file failed: "old" and "new" are identical: nothing to change\nnote: identical call #2 in this run')).toBe('identical')
  expect(editKind('tool edit_file failed: src/a.js has not been read in this run; call read_file first')).toBe('notRead')
  expect(editKind('tool edit_file failed: EACCES')).toBe('other')
})

test('normPath and describeCall', () => {
  expect(normPath('./src/a.js')).toBe('src/a.js')
  expect(normPath(7)).toBe('?')
  expect(describeCall('read_file', { path: 'src/a.js' })).toBe('read_file src/a.js')
  expect(describeCall('bash', { command: 'node --test' })).toBe('bash node --test')
  expect(describeCall('bash', { command: 'x'.repeat(80) })).toBe('bash ' + 'x'.repeat(57) + '...')
  expect(describeCall('list_dir', {})).toBe('list_dir')
})

test('first edit is the first SUCCESSFUL edit; loopFile needs two failures; done is read', () => {
  const ev = [
    call(2, 'c1', 'edit_file', { path: './src/a.js' }), result(2, 'c1', 'edit_file', 'tool edit_file failed: "old" must occur exactly once; found 0 occurrences', true),
    call(3, 'c2', 'edit_file', { path: 'src/a.js' }), result(3, 'c2', 'edit_file', 'edited src/a.js'),
    call(4, 'c3', 'edit_file', { path: 'src/b.js' }), result(4, 'c3', 'edit_file', 'tool edit_file failed: "old" and "new" are identical: nothing to change', true),
    call(5, 'c4', 'edit_file', { path: 'src/b.js' }), result(5, 'c4', 'edit_file', 'tool edit_file failed: "old" and "new" are identical: nothing to change', true),
    call(5, 'c5', 'write_file', { path: 'src/c.js' }), result(5, 'c5', 'write_file', 'wrote 3 chars to src/c.js'),
    e(6, { type: 'done', reason: 'repeat_loop', turns: 6, toolCallCount: 5 }),
  ]
  const a = analyzeTrace(ev)
  expect(a.firstEdit).toBe(3)
  expect(a.edits['src/a.js']).toEqual({ calls: 2, failed: 1, byKind: { zero: 1 } })
  expect(a.edits['src/b.js']).toEqual({ calls: 2, failed: 2, byKind: { identical: 2 } })
  expect(a.loopFile).toBe('src/b.js')
  expect(a.done).toEqual({ reason: 'repeat_loop', turns: 6 })
  expect(a.stubs).toBe('unknown') // no llm_request in these events
})

test('one failed edit is not a loop; no done → done absent', () => {
  const a = analyzeTrace([call(2, 'c1', 'edit_file', { path: 'x' }), result(2, 'c1', 'edit_file', 'tool edit_file failed: boom', true)])
  expect(a.loopFile).toBeUndefined()
  expect(a.firstEdit).toBeUndefined()
  expect(a.done).toBeUndefined()
})
