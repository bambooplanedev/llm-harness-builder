import { test, expect, beforeEach, afterEach } from 'vitest'
import { rm, writeFile, readFile as rf, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmp } from './helpers.js'
import { listDir, readFile, writeFile as wf, editFile, cutLines, GUARD_BLOCKED, EDIT_MISS, type ToolCtx } from '../src/core/tools/fs.js'

let ctx: ToolCtx
beforeEach(async () => {
  const workdir = await tmp('lhb-fs-')
  ctx = { workdir, maxToolOutputChars: 100 }
  await mkdir(join(workdir, 'src'))
  await writeFile(join(workdir, '.hidden'), '')
  await writeFile(join(workdir, 'a.txt'), 'hello\nworld\n')
  await writeFile(join(workdir, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n')
  await writeFile(join(workdir, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]))
})
afterEach(() => rm(ctx.workdir, { recursive: true, force: true }))

test('list_dir marks dirs, hides dotfiles', async () => {
  const out = await listDir({ path: '.' }, ctx)
  expect(out.split('\n')).toEqual(['a.txt', 'bin.dat', 'crlf.txt', 'src/'])
})

test('read_file reads whole files up to a 4 MiB ceiling', async () => {
  await writeFile(join(ctx.workdir, 'big.txt'), 'z'.repeat(1000))
  await writeFile(join(ctx.workdir, 'huge.txt'), 'z'.repeat((4 << 20) + 10))
  expect(await readFile({ path: 'a.txt' }, ctx)).toBe('hello\nworld\n')
  expect((await readFile({ path: 'big.txt' }, ctx)).length).toBe(1000)
  expect((await readFile({ path: 'huge.txt' }, ctx)).length).toBe((4 << 20) + '\n[truncated at 4194304 bytes]'.length)
})

test('read_file missing gives model-readable error', async () => {
  await expect(readFile({ path: 'nope.txt' }, ctx)).rejects.toThrow(/no such file|ENOENT/i)
})

test('write_file creates parent dirs', async () => {
  await wf({ path: 'deep/er/x.txt', content: 'hi' }, ctx)
  expect(await rf(join(ctx.workdir, 'deep/er/x.txt'), 'utf8')).toBe('hi')
})

test('edit_file replaces exactly one occurrence', async () => {
  await editFile({ path: 'a.txt', old: 'world', new: 'there' }, ctx)
  expect(await rf(join(ctx.workdir, 'a.txt'), 'utf8')).toBe('hello\nthere\n')
})

test('edit_file errors on 0 and 2 matches', async () => {
  await expect(editFile({ path: 'a.txt', old: 'zzz', new: 'y' }, ctx)).rejects.toThrow(/0 occurrences/)
  await writeFile(join(ctx.workdir, 'a.txt'), 'x x')
  await expect(editFile({ path: 'a.txt', old: 'x', new: 'y' }, ctx)).rejects.toThrow(/2 occurrences/)
})

test('edit_file refuses an edit that changes nothing; a miss is still reported as a miss', async () => {
  await expect(editFile({ path: 'a.txt', old: 'world', new: 'world' }, ctx)).rejects.toThrow(/identical/)
  await expect(editFile({ path: 'crlf.txt', old: 'two\r\nthree', new: 'two\nthree' }, ctx)).rejects.toThrow(/identical/)
  await expect(editFile({ path: 'a.txt', old: 'zzz', new: 'zzz' }, ctx)).rejects.toThrow(/0 occurrences/)
})

test('edit_file matches LF against CRLF file and preserves CRLF', async () => {
  await editFile({ path: 'crlf.txt', old: 'two\nthree', new: 'TWO' }, ctx)
  expect(await rf(join(ctx.workdir, 'crlf.txt'), 'utf8')).toBe('one\r\nTWO\r\n')
})

test('edit_file refuses binary', async () => {
  await expect(editFile({ path: 'bin.dat', old: 'A', new: 'B' }, ctx)).rejects.toThrow(/binary/)
})

test('edit_file writes $ patterns literally', async () => {
  await writeFile(join(ctx.workdir, 'a.txt'), 'x AAA y')
  await editFile({ path: 'a.txt', old: 'AAA', new: 'price is $$5 and $& done' }, ctx)
  expect(await rf(join(ctx.workdir, 'a.txt'), 'utf8')).toBe('x price is $$5 and $& done y')
})

test('all tools reject escaping paths', async () => {
  await expect(readFile({ path: '../../etc/passwd' }, ctx)).rejects.toThrow(/escapes/)
  await expect(wf({ path: '/tmp/x', content: '' }, ctx)).rejects.toThrow(/escapes/)
})

test('without the guard (no ctx.reads) editing an unread file still works', async () => {
  await editFile({ path: 'a.txt', old: 'world', new: 'there' }, ctx)
  expect(await rf(join(ctx.workdir, 'a.txt'), 'utf8')).toBe('hello\nthere\n')
})

test('guard: edit_file refuses an unread file, allows it after read_file', async () => {
  const g: ToolCtx = { ...ctx, reads: new Set() }
  await expect(editFile({ path: 'a.txt', old: 'world', new: 'there' }, g))
    .rejects.toThrow(/a\.txt has not been read in this run/)
  await readFile({ path: 'a.txt' }, g)
  await editFile({ path: 'a.txt', old: 'world', new: 'there' }, g)
  expect(await rf(join(g.workdir, 'a.txt'), 'utf8')).toBe('hello\nthere\n')
})

test('guard: two edits in a row are allowed after one read', async () => {
  const g: ToolCtx = { ...ctx, reads: new Set() }
  await readFile({ path: 'a.txt' }, g)
  await editFile({ path: 'a.txt', old: 'hello', new: 'HELLO' }, g)
  await editFile({ path: 'a.txt', old: 'world', new: 'WORLD' }, g)
  expect(await rf(join(g.workdir, 'a.txt'), 'utf8')).toBe('HELLO\nWORLD\n')
})

test('guard: the registry keys on the resolved path, not the argument', async () => {
  const g: ToolCtx = { ...ctx, reads: new Set() }
  await readFile({ path: './a.txt' }, g)
  await editFile({ path: 'src/../a.txt', old: 'world', new: 'there' }, g)
  expect(await rf(join(g.workdir, 'a.txt'), 'utf8')).toBe('hello\nthere\n')
})

test('guard: write_file refuses to overwrite an unread file but creates a new one', async () => {
  const g: ToolCtx = { ...ctx, reads: new Set() }
  await expect(wf({ path: 'a.txt', content: 'x' }, g))
    .rejects.toThrow(/a\.txt has not been read in this run/)
  await wf({ path: 'new.txt', content: 'x' }, g)
  expect(await rf(join(g.workdir, 'new.txt'), 'utf8')).toBe('x')
  // a file this run created counts as known: a second write must not be refused
  await wf({ path: 'new.txt', content: 'y' }, g)
  expect(await rf(join(g.workdir, 'new.txt'), 'utf8')).toBe('y')
})

test('the two strings bench counts by are the ones the tools write', async () => {
  const g: ToolCtx = { ...ctx, reads: new Set() }
  await expect(editFile({ path: 'a.txt', old: 'x', new: 'y' }, g)).rejects.toThrow(GUARD_BLOCKED)
  await writeFile(join(ctx.workdir, 'dup.txt'), 'x\nx\n')
  await expect(editFile({ path: 'dup.txt', old: 'x', new: 'y' }, ctx)).rejects.toThrow(EDIT_MISS)
})

test('explainEditMiss: a one-line miss that differs only in punctuation names the file line', async () => {
  await writeFile(join(ctx.workdir, 'src/s.js'), "export function f(s) {\n  return s.trim().replace(/x+/g, '-')\n}\n")
  const call = (old: string, c: ToolCtx) =>
    editFile({ path: 'src/s.js', old, new: 'X' }, c).then(() => 'edited', e => (e as Error).message)
  const plain = `"old" ${EDIT_MISS}; found 0 occurrences`
  const on: ToolCtx = { ...ctx, explainEditMiss: true }
  const semi = "return s.trim().replace(/x+/g, '-');"
  expect(await call(semi, on)).toBe(
    `${plain}. Line 2 of src/s.js matches your "old" except for punctuation or whitespace; the file has exactly:\n  return s.trim().replace(/x+/g, '-')`)
  expect(await call(semi, ctx)).toBe(plain)                                   // flag off: the old message, byte for byte
  expect(await call('return cleanedString;', on)).toBe(plain)                // nothing like it in the file
  expect(await call(';;', on)).toBe(plain)                                   // normalises to nothing: must not match the "}" line
  expect(await call("export function f(s) {;\n  return s.trim();", on)).toBe(plain)   // multi-line "old": out of scope
})

test('read_file: readMaxBytes cuts the read and says so; a file within it, or no knob, reads whole', async () => {
  await writeFile(join(ctx.workdir, 'big.txt'), '0123456789')
  expect(await readFile({ path: 'big.txt' }, { ...ctx, readMaxBytes: 4 })).toBe('0123\n[truncated at 4 bytes]')
  expect(await readFile({ path: 'big.txt' }, { ...ctx, readMaxBytes: 10 })).toBe('0123456789')
  expect(await readFile({ path: 'big.txt' }, ctx)).toBe('0123456789')
})

// ---- tools.readRanges ----------------------------------------------------------
const row = (n: number) => 'row ' + String(n).padStart(2, '0') + ' ' + 'x'.repeat(13)
const rows = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => row(a + i)).join('\n')
const TEN = rows(1, 10)
const ranged = async (over: Partial<ToolCtx> = {}) => {
  await writeFile(join(ctx.workdir, 'ten-nl.txt'), TEN + '\n'); await writeFile(join(ctx.workdir, 'ten.txt'), TEN)
  return { ...ctx, readRanges: true, ...over }
}

test('readRanges off: start and end are ignored, and a cut read is today\'s output', async () => {
  await ranged()
  expect(await readFile({ path: 'ten.txt', start: 3, end: 5 }, ctx)).toBe(await readFile({ path: 'ten.txt' }, ctx))
  expect(await readFile({ path: 'ten.txt' }, { ...ctx, readMaxBytes: 10 })).toBe('row 01 xxxxxxxxxxxxx'.slice(0, 10) + '\n[truncated at 10 bytes]')
  expect(ctx.lastRead).toBeUndefined()
})

test.each(['ten.txt', 'ten-nl.txt'])('readRanges on, %s: line ranges, 1-based and inclusive', async f => {
  const c = await ranged()
  expect(await readFile({ path: f, start: 3, end: 5 }, c)).toBe(rows(3, 5))
  expect(c.lastRead).toEqual({ first: 3, total: 10, capped: undefined })
  expect(await readFile({ path: f, start: '3', end: '5' }, c)).toBe(rows(3, 5))
  expect(await readFile({ path: f, start: 8, end: 50 }, c)).toBe(rows(8, 10))
  expect(await readFile({ path: f, start: 11 }, c)).toBe('[no lines: the file has 10]')
  expect(await readFile({ path: f }, c)).toBe(TEN)
})

test('readRanges on: an empty file, CRLF lines, and bad numbers', async () => {
  const c = await ranged()
  await writeFile(join(c.workdir, 'empty.txt'), '')
  expect(await readFile({ path: 'empty.txt' }, c)).toBe('[no lines: the file is empty]')
  expect(await readFile({ path: 'crlf.txt', start: 3 }, c)).toBe('three\r')
  for (const a of [{ start: 0 }, { start: -1 }, { start: 'abc' }, { start: 2.5 }, { start: 5, end: 3 }])
    await expect(readFile({ path: 'ten.txt', ...a }, c)).rejects.toThrow('start and end must be line numbers from 1, with end not before start')
})

test('readRanges on, readMaxBytes: the cut part is counted, a partly cut line is a line', async () => {
  const c = await ranged({ readMaxBytes: 50 })
  // bytes 0-49: rows 1-2 whole (41 bytes with the newline) + 8 chars of row 3 = 3 lines
  expect(await readFile({ path: 'ten.txt', start: 5 }, c)).toBe('[no lines: the first 50 bytes hold 3 lines; read the rest with bash]')
  expect(await readFile({ path: 'ten.txt', start: 2, end: 2 }, c)).toBe(row(2))
  expect(await readFile({ path: 'ten.txt', start: 2 }, c)).toBe(row(2) + '\n' + row(3).slice(0, 8) + '\n[truncated at 50 bytes]')
  expect(c.lastRead).toEqual({ first: 2, total: 3, capped: 50 })
})

test('cutLines keeps whole lines and names the rest', () => {
  expect(cutLines(TEN, 400, { first: 1, total: 10 })).toBe(TEN)
  const out = cutLines(TEN, 120, { first: 1, total: 10 })!
  expect(out).toBe(rows(1, 3) + '\n[lines 1-3 of 10 shown; read on with start: 4]')
  expect(out.length).toBe(109)
  expect(cutLines('y'.repeat(200), 60, { first: 1, total: 1 })).toBeUndefined()
  expect(cutLines(rows(1, 10), 120, { first: 4, total: 20, capped: 99 })).toBe(rows(1, 3) + '\n[lines 4-6 of 20+ shown; read on with start: 7]')
})

test('readRanges with the guard: a part read does not allow write_file, but allows edit_file', async () => {
  const c = await ranged({ reads: new Set<string>(), partReads: new Set<string>() })
  await readFile({ path: 'ten.txt', start: 2, end: 3 }, c)
  await expect(wf({ path: 'ten.txt', content: 'z' }, c)).rejects.toThrow('ten.txt was read only in part; read it whole with read_file before overwriting it')
  await editFile({ path: 'ten.txt', old: row(2), new: 'two' }, c)
  await readFile({ path: 'ten.txt', start: 2, end: 3 }, c)
  await readFile({ path: 'ten.txt' }, c)
  await wf({ path: 'ten.txt', content: 'z' }, c)
})
