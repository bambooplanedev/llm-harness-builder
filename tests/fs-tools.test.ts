import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile as rf, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDir, readFile, writeFile as wf, editFile, type ToolCtx } from '../src/core/tools/fs.js'

let ctx: ToolCtx
beforeEach(async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'lhb-fs-'))
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
