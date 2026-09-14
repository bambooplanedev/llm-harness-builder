import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, symlink, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmp } from './helpers.js'
import { resolveInside, validateWorkdir } from '../src/core/tools/sandbox.js'

let root: string, outside: string
beforeEach(async () => {
  root = await tmp('lhb-wd-')
  outside = await tmp('lhb-out-')
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'sub', 'f.txt'), 'x')
  await symlink(outside, join(root, 'escape'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) })

test('relative path inside resolves', async () => {
  expect(await resolveInside(root, 'sub/f.txt')).toMatch(/sub\/f\.txt$/)
})
test('../ escapes', async () => {
  await expect(resolveInside(root, '../x')).rejects.toThrow(/escapes/)
})
test('absolute path outside escapes', async () => {
  await expect(resolveInside(root, '/etc/passwd')).rejects.toThrow(/escapes/)
})
test('symlink to outside escapes, even for a not-yet-existing file under it', async () => {
  await expect(resolveInside(root, 'escape/new/file.txt')).rejects.toThrow(/escapes/)
})
test('dangling symlink leaf pointing outside is rejected', async () => {
  await symlink(join(outside, 'victim.txt'), join(root, 'evil'))
  await expect(resolveInside(root, 'evil')).rejects.toThrow(/escapes/)
})
test('dangling symlink dir component is rejected', async () => {
  await symlink(join(outside, 'nodir'), join(root, 'evildir'))
  await expect(resolveInside(root, 'evildir/file.txt')).rejects.toThrow(/escapes/)
})
test('not-yet-existing file inside resolves', async () => {
  expect(await resolveInside(root, 'new/dir/file.txt')).toMatch(/new\/dir\/file\.txt$/)
})
test('validateWorkdir rejects /, home, missing, file', async () => {
  expect(await validateWorkdir('/')).toMatch(/root/)
  expect(await validateWorkdir(homedir())).toMatch(/home/)
  expect(await validateWorkdir(join(root, 'nope'))).toMatch(/exist/)
  expect(await validateWorkdir(join(root, 'sub', 'f.txt'))).toMatch(/directory/)
  expect(await validateWorkdir(root)).toBeNull()
})
