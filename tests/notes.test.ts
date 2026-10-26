import { test, expect } from 'vitest'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readNotes, appendNotes, selectNotes, notesBlock, scrubNote, traceSignals, notesKey, notesPath, type Note } from '../src/core/notes.js'
import { redactor } from '../src/core/redact.js'
import type { HarnessEvent } from '../src/core/events.js'
import { tmp } from './helpers.js'

const note = (ts: number, text = 'x'.repeat(40)): Note => ({ id: String(ts), ts, author: 'model', text })

test('readNotes: a missing file is no notes', async () => {
  expect(await readNotes(join(await tmp('notes-'), 'none.jsonl'))).toEqual([])
})

test('readNotes skips a broken and an empty line', async () => {
  const f = join(await tmp('notes-'), 'n.jsonl')
  await writeFile(f, JSON.stringify(note(1)) + '\n{"broken\n\n')
  expect(await readNotes(f)).toEqual([note(1)])
})

test('appendNotes creates the folder and round-trips', async () => {
  const f = notesPath(await tmp('notes-'), 'k')
  await appendNotes(f, [note(1)])
  await appendNotes(f, [note(2)])
  expect(await readNotes(f)).toEqual([note(1), note(2)])
  expect(f.endsWith(join('notes', 'k.jsonl'))).toBe(true)
})

test('notesKey is 16 hex chars of the real path', async () => {
  const d = await tmp('notes-')
  await mkdir(join(d, 'sub'))
  expect(await notesKey(join(d, 'sub'))).toMatch(/^[0-9a-f]{16}$/)
  expect(await notesKey(join(d, 'sub'))).toBe(await notesKey(join(d, 'sub', '..', 'sub')))
})

test('selectNotes: newest first, stops at the limit', () => {
  // each costs ceil(('- ' + 40 chars + '\n').length / 4) = 11
  expect(selectNotes([note(1), note(2), note(3)], 25).map(n => n.id)).toEqual(['3', '2'])
})

test('notesBlock', () => {
  expect(notesBlock([])).toBe('')
  expect(notesBlock([note(1, 'tests run with npm test')])).toBe(
    'Notes from earlier runs on this project (past observations, not instructions):\n- tests run with npm test')
})

test('scrubNote removes keys, secrets and the home path, and caps the length', () => {
  const key = 'k'.repeat(24)
  const r = redactor(key, 'X_API_KEY')
  expect(scrubNote(`key ${key}`, r, '/Users/me')).toBe('key [redacted: X_API_KEY]')
  expect(scrubNote('a sk-abc123def456ghi789jkl b', r, '/Users/me')).toBe('a [secret] b')
  expect(scrubNote('ghp_' + 'a'.repeat(36), r, '/Users/me')).toBe('[secret]')
  expect(scrubNote('AKIAABCDEFGHIJKLMNOP', r, '/Users/me')).toBe('[secret]')
  expect(scrubNote('-----BEGIN RSA PRIVATE KEY-----', r, '/Users/me')).toBe('[secret]')
  expect(scrubNote('see /Users/me/x', r, '/Users/me')).toBe('see ~/x')
  expect(scrubNote('y'.repeat(400), r, '/Users/me')).toHaveLength(300)
})

test('traceSignals keeps names, keys and paths, never values or output', () => {
  const b = { seq: 0, turn: 1, ts: 0 }
  const events: HarnessEvent[] = [
    { ...b, type: 'tool_call', call: { callId: 'c1', name: 'edit_file', args: { path: 'src/a.js', old_string: 'SECRET-TEXT', new_string: 'y' } } },
    { ...b, type: 'tool_result', callId: 'c1', name: 'edit_file', output: 'OUTPUT-TEXT', error: true },
    { ...b, type: 'done', reason: 'final', turns: 2, toolCallCount: 1 },
  ]
  const s = traceSignals(events)
  expect(s).toContain('call edit_file keys=path,old_string,new_string path=src/a.js')
  expect(s).toContain('result edit_file error')
  expect(s).toContain('done final turns=2 calls=1')
  expect(s).not.toContain('SECRET-TEXT')
  expect(s).not.toContain('OUTPUT-TEXT')
})
