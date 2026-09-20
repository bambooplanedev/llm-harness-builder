import { test, expect, beforeEach, afterEach } from 'vitest'
import { rm, writeFile, readFile as rf, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmp } from './helpers.js'
import { listDir, readFile, writeFile as wf, editFile, GUARD_BLOCKED, EDIT_MISS, type ToolCtx } from '../src/core/tools/fs.js'

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
  expect((await readFile({ path: 'huge.txt' }, ctx)).length).toBe(4 << 20)
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
