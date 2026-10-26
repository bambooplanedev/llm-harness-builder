import { test, expect } from 'vitest'
import { writeFile, readFile, mkdir, chmod, unlink, rename, rm } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { loadRepoTasks } from '../src/core/repo-tasks.js'
import { cloneAt, linkNodeModules, changedPaths, protectedChanged, runCheck, patchOf, removeClone, removeCloneSync, modulesManifest, prepareModules, modulesTampered, removeAllClonesSync, finishRun, type Clone } from '../src/core/repo-clone.js'
import { childEnv } from '../src/core/tools/env.js'
import { gitRepo, tmp } from './helpers.js'

const TASKS = JSON.stringify({ tasks: [{ name: 'a', prompt: 'p', check: 'node --test' }] })
const repoWith = (files: Record<string, string> = {}) => gitRepo({ 'lhb-tasks.json': TASKS, 'src/a.js': 'a\n', 'src/a.test.js': 't\n', 'package.json': '{}', ...files })
const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: 'pipe' })
const task = (over = {}) => ({ name: 'a', prompt: 'p', check: 'true', checkTimeoutS: 30, ...over })

/** What must not change in the user's repo: config, hooks, packed-refs, refs, status. */
function fingerprint(repo: string): string {
  const h = createHash('sha256')
  for (const f of ['config', 'packed-refs']) if (existsSync(join(repo, '.git', f))) h.update(readFileSync(join(repo, '.git', f)))
  for (const f of readdirSync(join(repo, '.git', 'hooks')).sort()) h.update(f).update(readFileSync(join(repo, '.git', 'hooks', f)))
  h.update(g(repo, 'for-each-ref')).update(g(repo, '--no-optional-locks', 'status', '--porcelain'))
  return h.digest('hex')
}

async function withClone(files: Record<string, string>, fn: (c: Clone, repo: string, t: Awaited<ReturnType<typeof loadRepoTasks>>) => Promise<void>) {
  const repo = await repoWith(files)
  const t = await loadRepoTasks(repo)
  const c = await cloneAt(t)
  try { await fn(c, repo, t) } finally { await removeClone(c) }
  return { repo, t, c }
}

test('cloneAt: a detached clone in the temp dir with a probe, no origin, the user repo untouched', async () => {
  const repo = await repoWith()
  const before = fingerprint(repo)
  const t = await loadRepoTasks(repo)
  const c = await cloneAt(t)
  try {
    expect(c.dir.startsWith(await (await import('node:fs/promises')).realpath(tmpdir())) || c.dir.startsWith(tmpdir())).toBe(true)
    expect(basename(c.dir)).toMatch(/^lhb-\d{8}-\d{6}-[0-9a-f]{8}$/)
    expect(existsSync(c.probe)).toBe(true)
    expect(g(c.dir, 'rev-parse', 'HEAD').trim()).toBe(t.sha)
    expect(g(c.dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD')
    expect(g(c.dir, 'remote').trim()).toBe('')
  } finally { await removeClone(c) }
  expect(fingerprint(repo)).toBe(before)
})

test('cloneAt: a model git push origin has nowhere to go', async () => {
  await withClone({}, async (c, repo) => {
    g(c.dir, 'commit', '--allow-empty', '-qm', 'x')
    expect(() => g(c.dir, 'push', 'origin', 'HEAD:refs/heads/x')).toThrow()
    expect(g(repo, 'for-each-ref', 'refs/heads/x').trim()).toBe('')
  })
})

test('a post-checkout hook in the user repo does not run on clone', async () => {
  const repo = await repoWith()
  const marker = join(await tmp('lhb-mark-'), 'ran')
  const hook = join(repo, '.git', 'hooks', 'post-checkout')
  await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`); await chmod(hook, 0o755)
  const c = await cloneAt(await loadRepoTasks(repo))
  await removeClone(c)
  expect(existsSync(marker)).toBe(false)
})

test('protectedChanged: edits, assume-unchanged edits, new configs and deletions are all seen', async () => {
  await withClone({}, async (c, _repo, t) => {
    await writeFile(join(c.dir, 'src/a.js'), 'b\n')
    expect(await protectedChanged(c, t)).toEqual([])
    await writeFile(join(c.dir, 'src/a.test.js'), 'hacked\n')
    g(c.dir, 'update-index', '--assume-unchanged', 'src/a.test.js')
    await writeFile(join(c.dir, 'vitest.config.mjs'), 'export default {}\n')
    await unlink(join(c.dir, 'package.json'))
    expect((await protectedChanged(c, t)).sort()).toEqual(['package.json', 'src/a.test.js', 'vitest.config.mjs'])
  })
})

test('the model rewriting the clone .git cannot redirect the harness or hide an edit', async () => {
  const marker = join(await tmp('lhb-mark-'), 'ran')
  const other = await tmp('lhb-other-')
  const { repo } = await withClone({}, async (c, repo) => {
    const before = fingerprint(repo)
    await writeFile(join(c.dir, 'src/a.test.js'), 'hacked\n')
    g(c.dir, 'config', 'filter.x.clean', `touch "${marker}"`)
    await writeFile(join(c.dir, '.gitattributes'), '* filter=x\n')
    g(c.dir, 'replace', g(c.dir, 'rev-parse', 'HEAD:src/a.test.js').trim(), g(c.dir, 'rev-parse', 'HEAD:src/a.js').trim())
    g(c.dir, 'config', 'core.worktree', other)
    await rename(join(c.dir, '.git'), join(c.dir, 'gitold'))
    await writeFile(join(c.dir, '.git'), `gitdir: ${join(repo, '.git')}\n`)
    expect(await changedPaths(c, [':(glob)**/*.test.*'])).toEqual(['src/a.test.js'])
    expect(await patchOf(c)).toContain('src/a.test.js')
    expect(existsSync(marker)).toBe(false)
    expect(readdirSync(other)).toEqual([])
    expect(fingerprint(repo)).toBe(before)
  })
  expect(repo).toBeTruthy()
})

test('runCheck: exit code, 0 tests, timeout, a long output still ends in its summary', async () => {
  // src/a.test.js of the fixture would be found from the root; this folder has only a file node --test does not pick up.
  await withClone({ 'only/a.spec.js': "require('node:test')('x', () => {})\n" }, async c => {
    const env = childEnv()
    expect(await runCheck(c, task({ check: 'cd only && node --test' }), env)).toEqual({ pass: false, reason: 'the check found 0 tests' })
    expect(await runCheck(c, task({ check: 'exit 1' }), env)).toEqual({ pass: false, reason: 'check exited 1' })
    expect(await runCheck(c, task({ check: 'sleep 30', checkTimeoutS: 1 }), env)).toEqual({ pass: false, reason: 'check timed out after 1s' })
    expect(await runCheck(c, task({ check: `node -e "for (let i = 0; i < 300000; i++) console.log('noise ' + i); console.log('ℹ tests 0')"` }), env))
      .toEqual({ pass: false, reason: 'the check found 0 tests' })
    expect(await runCheck(c, task({ check: 'true' }), env)).toEqual({ pass: true })
  })
})

test('patchOf: changes and new files in, secret-looking files out, capped at 1 MiB', async () => {
  await withClone({}, async c => {
    await writeFile(join(c.dir, 'src/a.js'), 'changed\n')
    await writeFile(join(c.dir, 'new.js'), 'n\n')
    await writeFile(join(c.dir, '.env'), 'K=1\n')
    await mkdir(join(c.dir, 'sub')); await writeFile(join(c.dir, 'sub/.env'), 'K=1\n')
    await writeFile(join(c.dir, 'top.pem'), 'x\n')
    const p = await patchOf(c)
    expect(p).toContain('src/a.js'); expect(p).toContain('new.js')
    for (const s of ['.env', 'top.pem']) expect(p).not.toContain(s)
    await writeFile(join(c.dir, 'big.txt'), 'y'.repeat(3 << 20))
    const big = await patchOf(c)
    expect(Buffer.byteLength(big)).toBeLessThanOrEqual((1 << 20) + 64)
    expect(big.trimEnd().endsWith('[patch truncated at 1 MiB]')).toBe(true)
  })
})

test('removeClone does not follow the node_modules link; neither does removeCloneSync', async () => {
  for (const remove of [removeClone, async (c: Clone) => removeCloneSync(c)]) {
    const repo = await repoWith()
    const mods = await tmp('lhb-mods-')
    await mkdir(join(mods, 'node_modules', 'x'), { recursive: true }); await writeFile(join(mods, 'node_modules', 'x', 'index.js'), '1')
    const c = await cloneAt(await loadRepoTasks(repo))
    await linkNodeModules(c, mods)
    expect(existsSync(join(c.dir, 'node_modules', 'x', 'index.js'))).toBe(true)
    await remove(c)
    expect(existsSync(c.dir)).toBe(false); expect(existsSync(c.probe)).toBe(false)
    expect(await readFile(join(mods, 'node_modules', 'x', 'index.js'), 'utf8')).toBe('1')
  }
})

test('an exception between clone and removal leaves no dir', async () => {
  const repo = await repoWith()
  let dir = ''
  await expect((async () => {
    const c = await cloneAt(await loadRepoTasks(repo)); dir = c.dir
    try { throw new Error('boom') } finally { await removeClone(c) }
  })()).rejects.toThrow('boom')
  expect(existsSync(dir)).toBe(false)
})

test('linkNodeModules: nothing when the source has none', async () => {
  await withClone({}, async c => {
    await linkNodeModules(c, await tmp('lhb-empty-'))
    expect(existsSync(join(c.dir, 'node_modules'))).toBe(false)
  })
})


test('modulesManifest: stable, sees bin, code and removed packages, not tool caches', async () => {
  const d = await tmp('lhb-nm-'), nm = join(d, 'node_modules')
  await mkdir(join(nm, '.bin'), { recursive: true }); await writeFile(join(nm, '.bin', 'vitest'), 'x')
  await mkdir(join(nm, 'x')); await writeFile(join(nm, 'x', 'package.json'), '{}'); await writeFile(join(nm, 'x', 'index.js'), '1')
  await mkdir(join(nm, '@s', 'y'), { recursive: true }); await writeFile(join(nm, '@s', 'y', 'package.json'), '{}')
  const m0 = await modulesManifest(nm)
  expect(await modulesManifest(nm)).toBe(m0)
  await mkdir(join(nm, '.vite', 'vitest'), { recursive: true }); await writeFile(join(nm, '.vite', 'vitest', 'r.json'), '{}')
  expect(await modulesManifest(nm)).toBe(m0)
  await writeFile(join(nm, 'x', 'index.js'), '22')
  const m1 = await modulesManifest(nm); expect(m1).not.toBe(m0)
  await writeFile(join(nm, '.bin', 'vitest'), 'evil')
  const m2 = await modulesManifest(nm); expect(m2).not.toBe(m1)
  await rm(join(nm, '@s'), { recursive: true })
  expect(await modulesManifest(nm)).not.toBe(m2)
  expect(await modulesManifest(join(d, 'none'))).toBe('')
})

test('prepareModules: setup runs in its own clone, never in the user repo', async () => {
  const repo = await repoWith()
  const t = await loadRepoTasks(repo)
  expect(await prepareModules(t)).toEqual({ from: t.repo })
  const withSetup = await repoWith({ 'lhb-tasks.json': JSON.stringify({ tasks: [{ name: 'a', prompt: 'p', check: 'true' }], setup: 'mkdir -p node_modules/x && echo 1 > node_modules/x/index.js' }) })
  const r = await prepareModules(await loadRepoTasks(withSetup))
  try {
    expect(r.from).not.toBe(withSetup)
    expect(readFileSync(join(r.from, 'node_modules', 'x', 'index.js'), 'utf8')).toBe('1\n')
    expect(existsSync(join(withSetup, 'node_modules'))).toBe(false)
  } finally { await removeClone(r.setupClone!) }
})

test('prepareModules: a failing setup throws and leaves no clone', async () => {
  const repo = await repoWith({ 'lhb-tasks.json': JSON.stringify({ tasks: [{ name: 'a', prompt: 'p', check: 'true' }], setup: 'echo nope; exit 2' }) })
  const before = readdirSync(tmpdir()).filter(f => f.startsWith('lhb-2')).length
  await expect(prepareModules(await loadRepoTasks(repo))).rejects.toThrow('setup failed (exit 2): nope')
  expect(readdirSync(tmpdir()).filter(f => f.startsWith('lhb-2')).length).toBe(before)
})

test('protectedChanged: hiding a new protected file behind a .gitignore line is itself a protected change', async () => {
  await withClone({ '.gitignore': 'dist\n' }, async (c, _repo, t) => {
    // a build output under a dir the commit already ignores is not a change: tsc writes dist/**/*.test.js
    await mkdir(join(c.dir, 'dist', 'tests'), { recursive: true }); await writeFile(join(c.dir, 'dist', 'tests', 'x.test.js'), 'x')
    expect(await protectedChanged(c, t)).toEqual([])
    await writeFile(join(c.dir, '.gitignore'), 'dist\nvitest.config.mjs\n')
    await writeFile(join(c.dir, 'vitest.config.mjs'), 'export default { test: { include: [] } }\n')
    expect(await protectedChanged(c, t)).toEqual(['.gitignore'])
  })
})

test('modulesTampered: the link swapped for a folder, or a node_modules that was not there, is a change', async () => {
  const mods = await tmp('lhb-mods-')
  await mkdir(join(mods, 'node_modules', 'x'), { recursive: true })
  await withClone({}, async c => {
    expect(await modulesTampered(c)).toBe(false)
    await mkdir(join(c.dir, 'node_modules')); expect(await modulesTampered(c)).toBe(true)
  })
  await withClone({}, async c => {
    await linkNodeModules(c, mods)
    expect(await modulesTampered(c)).toBe(false)
    await unlink(join(c.dir, 'node_modules')); await mkdir(join(c.dir, 'node_modules', '.bin'), { recursive: true })
    expect(await modulesTampered(c)).toBe(true)
  })
})

test('removeAllClonesSync removes every clone still alive', async () => {
  const repo = await repoWith()
  const t = await loadRepoTasks(repo)
  const a = await cloneAt(t), b = await cloneAt(t)
  removeAllClonesSync()
  for (const c of [a, b]) { expect(existsSync(c.dir)).toBe(false); expect(existsSync(c.probe)).toBe(false) }
})

test('prepareModules: setup runs with the env it is given', async () => {
  const repo = await repoWith({ 'lhb-tasks.json': JSON.stringify({ tasks: [{ name: 'a', prompt: 'p', check: 'true' }], setup: 'test "$LHB_T_FOO" = 1' }) })
  const t = await loadRepoTasks(repo)
  await expect(prepareModules(t)).rejects.toThrow('setup failed (exit 1)')
  const r = await prepareModules(t, { ...childEnv(), LHB_T_FOO: '1' })
  await removeClone(r.setupClone!)
})

test('finishRun: a patch that cannot be kept is said, the clone goes anyway', async () => {
  const repo = await repoWith()
  const c = await cloneAt(await loadRepoTasks(repo))
  await writeFile(join(c.dir, 'src/a.js'), 'changed\n')
  const w = await finishRun(c, join(await tmp('lhb-x-'), 'no', 'such', 'abc.patch'))
  expect(w).toHaveLength(1)
  expect(w[0]).toMatch(/^cannot keep the patch of run abc: /)
  expect(existsSync(c.dir)).toBe(false); expect(existsSync(c.probe)).toBe(false)
})

test('finishRun: no patch file, no warning', async () => {
  const repo = await repoWith()
  const c = await cloneAt(await loadRepoTasks(repo))
  expect(await finishRun(c, undefined)).toEqual([])
  expect(existsSync(c.dir)).toBe(false)
})

test.skipIf(process.getuid?.() === 0)('finishRun: a clone that cannot be removed is said, never thrown; the probe goes', async () => {
  const repo = await repoWith()
  const c = await cloneAt(await loadRepoTasks(repo))
  const locked = join(c.dir, 'locked')
  await mkdir(locked); await writeFile(join(locked, 'f'), 'x'); await chmod(locked, 0o500)
  try {
    const w = await finishRun(c, undefined)
    expect(w.some(x => x.startsWith(`cannot remove the clone ${c.dir}: `))).toBe(true)
    expect(existsSync(c.probe)).toBe(false)
  } finally { await chmod(locked, 0o700); await removeClone(c) }
})

test('patchOf: a long patch is cut at a line end, never inside a character', async () => {
  await withClone({}, async c => {
    const ye = '\u0454' // a two-byte character
    await writeFile(join(c.dir, 'uk.txt'), (ye.repeat(99) + '\n').repeat(Math.ceil((3 << 20) / 199)))
    const p = await patchOf(c)
    expect(p).not.toContain('�')
    const lines = p.trimEnd().split('\n')
    expect(lines.at(-1)).toBe('[patch truncated at 1 MiB]')
    expect(lines.at(-2)).toBe('+' + ye.repeat(99))
  })
})
