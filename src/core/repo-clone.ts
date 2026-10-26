// One run of a user's task: a `git clone --shared` in the OS temp dir, and a probe git dir the harness reads it through.
// The model can rewrite the clone's .git (a gitfile to the user's repo, core.worktree, a clean filter, replace refs, an
// index entry marked unchanged); the probe has none of that, so what the harness sees of a run is the work tree itself.
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, lstat, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { lstatSync, rmSync, unlinkSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { git, type RepoTask, type RepoTasks } from './repo-tasks.js'
import { runShell } from './tools/bash.js'
import { childEnv } from './tools/env.js'

export type Clone = { dir: string; probe: string; sha: string }

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** A detached clone at the pinned commit with no remote (a model's `git push origin` has nowhere to go), and its probe. */
export async function cloneAt(t: RepoTasks): Promise<Clone> {
  const dir = path.join(tmpdir(), `lhb-${stamp()}-${randomBytes(4).toString('hex')}`)
  const c: Clone = { dir, probe: `${dir}-probe`, sha: t.sha }
  try {
    await git(['clone', '--shared', '--no-checkout', '-q', t.repo, dir], tmpdir())
    await git(['checkout', '-q', '--detach', t.sha], dir)
    await git(['remote', 'remove', 'origin'], dir)
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), '\n/node_modules\n')
    await git(['init', '-q', '--bare', c.probe], tmpdir())
    const objects = path.resolve(t.repo, (await git(['rev-parse', '--git-path', 'objects'], t.repo)).trim())
    await writeFile(path.join(c.probe, 'objects', 'info', 'alternates'), objects + '\n')
    return c
  } catch (e) { removeCloneSync(c); throw e }
}

export async function linkNodeModules(c: Clone, from: string): Promise<void> {
  const src = path.join(from, 'node_modules')
  if (existsSync(src)) symlinkSync(src, path.join(c.dir, 'node_modules'))
}

/** git through the probe, on the clone's work tree, with a throwaway index that holds the work tree as it is now. */
async function probe<T>(c: Clone, fn: (g: (args: string[]) => Promise<string>) => Promise<T>): Promise<T> {
  const index = path.join(tmpdir(), `lhb-index-${randomBytes(4).toString('hex')}`)
  const g = (args: string[]) => git([`--git-dir=${c.probe}`, `--work-tree=${c.dir}`, ...args], c.dir, { GIT_INDEX_FILE: index })
  try {
    await g(['read-tree', c.sha])
    await g(['add', '-A', '--', '.', ':(exclude)node_modules'])
    return await fn(g)
  } finally { await rm(index, { force: true }) }
}

/** Paths under `pathspecs` that differ from the commit: changed, added or deleted — read from the work tree, never the clone's index. */
export const changedPaths = (c: Clone, pathspecs: string[]): Promise<string[]> =>
  probe(c, async g => (await g(['diff', '--cached', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', c.sha, '--', ...pathspecs])).split('\n').filter(Boolean))

export const protectedChanged = (c: Clone, t: RepoTasks): Promise<string[]> => changedPaths(c, t.protect)

const NO_TESTS = /^(?:#|ℹ) tests 0$/m

export async function runCheck(c: Clone, task: RepoTask, env: NodeJS.ProcessEnv): Promise<{ pass: boolean; reason?: string }> {
  const r = await runShell(task.check, { cwd: c.dir, env, timeoutMs: task.checkTimeoutS * 1000, maxBuffer: 1 << 20, keep: 'tail' })
  if (r.spawnError !== undefined) return { pass: false, reason: `check did not start: ${r.spawnError}` }
  if (r.killed) return { pass: false, reason: `check timed out after ${task.checkTimeoutS}s` }
  // node --test finds no file and exits 0: a suite that ran nothing is not a pass.
  if (NO_TESTS.test(r.out)) return { pass: false, reason: 'the check found 0 tests' }
  return r.code === 0 ? { pass: true } : { pass: false, reason: `check exited ${r.code}` }
}

const PATCH_MAX = 1 << 20
const PATCH_EXCLUDE = [':(exclude,glob)**/.env*', ':(exclude,glob)**/*.pem', ':(exclude,glob)**/*.key', ':(exclude)node_modules']

/** What the run changed, as a patch, without files that look like secrets; binary files as "Binary files differ"; at most 1 MiB. */
export const patchOf = (c: Clone): Promise<string> => probe(c, async g => {
  const p = await g(['diff', '--cached', '--no-ext-diff', '--no-textconv', c.sha, '--', '.', ...PATCH_EXCLUDE])
  return Buffer.byteLength(p) <= PATCH_MAX ? p : Buffer.from(p).subarray(0, PATCH_MAX).toString('utf8') + '\n[patch truncated at 1 MiB]\n'
})

/** The node_modules link first, so removing the clone can never reach what it points at. */
export async function removeClone(c: Clone): Promise<void> {
  try { if ((await lstat(path.join(c.dir, 'node_modules'))).isSymbolicLink()) await unlink(path.join(c.dir, 'node_modules')) } catch { /* none */ }
  await rm(c.dir, { recursive: true, force: true })
  await rm(c.probe, { recursive: true, force: true })
}

/** For a SIGINT handler that exits right after it. */
export function removeCloneSync(c: Clone): void {
  try { if (lstatSync(path.join(c.dir, 'node_modules')).isSymbolicLink()) unlinkSync(path.join(c.dir, 'node_modules')) } catch { /* none */ }
  rmSync(c.dir, { recursive: true, force: true })
  rmSync(c.probe, { recursive: true, force: true })
}

// Tool caches the test runners write on every run: a change there is no change to the installed packages.
const SKIP = new Set(['.cache', '.vite', '.vitest', '.pnpm', '.package-lock.json', '.bin'])

/** A fingerprint of what the model could plant in a shared node_modules: every .bin entry, and each package's
 *  package.json and top-level code files. '' when there is no node_modules. */
export async function modulesManifest(nodeModules: string): Promise<string> {
  let top: string[]
  try { top = await readdir(nodeModules) } catch { return '' }
  const lines: string[] = []
  const add = async (rel: string) => { const s = await lstat(path.join(nodeModules, rel)); lines.push(`${rel}\t${s.size}\t${s.mtimeMs}`) }
  const pkg = async (rel: string) => {
    for (const f of await readdir(path.join(nodeModules, rel)).catch(() => [] as string[]))
      if (f === 'package.json' || /\.(?:c|m)?js$/.test(f)) await add(path.join(rel, f))
  }
  for (const f of await readdir(path.join(nodeModules, '.bin')).catch(() => [] as string[])) await add(path.join('.bin', f))
  for (const name of top) {
    if (SKIP.has(name)) continue
    if (name.startsWith('@')) for (const sub of await readdir(path.join(nodeModules, name)).catch(() => [] as string[])) await pkg(path.join(name, sub))
    else if ((await stat(path.join(nodeModules, name)).catch(() => null))?.isDirectory()) await pkg(name)
  }
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex')
}

/** Where the runs' node_modules link points: the user's repo, or — with a setup — a clone that ran it, so `npm ci`
 *  never touches the user's own tree. */
export async function prepareModules(t: RepoTasks): Promise<{ from: string; setupClone?: Clone }> {
  if (!t.setup) return { from: t.repo }
  const c = await cloneAt(t)
  const r = await runShell(t.setup, { cwd: c.dir, env: childEnv(), timeoutMs: 1_800_000, maxBuffer: 1 << 20, keep: 'tail' })
  if (r.code !== 0) {
    await removeClone(c)
    const last = r.out.trim().split('\n').at(-1) ?? ''
    throw new Error(`setup failed (${r.killed ? 'timed out' : r.spawnError ?? `exit ${r.code}`}): ${last}`)
  }
  return { from: c.dir, setupClone: c }
}
