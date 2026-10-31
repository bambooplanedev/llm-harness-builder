// One run of a user's task: a `git clone --shared` in the OS temp dir, and a probe git dir the harness reads it through.
// The model can rewrite the clone's .git (a gitfile to the user's repo, core.worktree, a clean filter, replace refs, an
// index entry marked unchanged); the probe has none of that, so what the harness sees of a run is the work tree itself.
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, lstat, mkdtemp, readdir, readlink, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { lstatSync, rmSync, unlinkSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { git, type RepoTask, type RepoTasks } from './repo-tasks.js'
import { stamp } from './bench.js'
import { runShell } from './tools/bash.js'
import { childEnv } from './tools/env.js'

export type Clone = { dir: string; probe: string; sha: string
  /** Where the clone's node_modules link points; absent when none was made. */
  link?: string }

// Every clone not yet removed: an exit for any reason (Ctrl-C during setup, a die(), the process registry's own exit)
// takes them with it.
const LIVE = new Set<Clone>()
// The directories of $LHB_FINAL_FILE not yet removed: the same exit takes them (Ctrl-C mid-check).
const FINALS = new Set<string>()
let hooked = false

/** Each clone that is still there, removed now; one that cannot be removed is said, not thrown. */
export function removeAllClonesSync(): void {
  for (const d of [...FINALS]) { rmSync(d, { recursive: true, force: true }); FINALS.delete(d) }
  for (const c of [...LIVE]) try { removeCloneSync(c) } catch (e) { console.error(`cannot remove ${c.dir}: ${(e as Error).message}`) }
}

/** A detached clone at the pinned commit with no remote (a model's `git push origin` has nowhere to go), and its probe. */
export async function cloneAt(t: RepoTasks): Promise<Clone> {
  const dir = path.join(tmpdir(), `lhb-${stamp()}-${randomBytes(4).toString('hex')}`)
  const c: Clone = { dir, probe: `${dir}-probe`, sha: t.sha }
  if (!hooked) { hooked = true; process.on('exit', removeAllClonesSync) }
  LIVE.add(c)
  try {
    await git(['clone', '--shared', '--no-checkout', '-q', t.repo, dir], tmpdir())
    await git(['checkout', '-q', '--detach', t.sha], dir)
    await git(['remote', 'remove', 'origin'], dir)
    await appendFile(path.join(dir, '.git', 'info', 'exclude'), '\n/node_modules\n')
    await git(['init', '-q', '--bare', c.probe], tmpdir())
    const objects = path.resolve(t.repo, (await git(['rev-parse', '--git-path', 'objects'], t.repo)).trim())
    await writeFile(path.join(c.probe, 'objects', 'info', 'alternates'), objects + '\n')
    // node_modules never goes into the probe's index: a link or the model's own folder is judged by modulesTampered.
    // An exclude here, not a ':(exclude)' pathspec: git add refuses that one when a .gitignore ignores the folder too.
    await writeFile(path.join(c.probe, 'info', 'exclude'), '/node_modules\n')
    return c
  } catch (e) { removeCloneSync(c); throw e }
}

export async function linkNodeModules(c: Clone, from: string): Promise<void> {
  const src = path.join(from, 'node_modules')
  if (existsSync(src)) { symlinkSync(src, path.join(c.dir, 'node_modules')); c.link = src }
}

/** Whether the clone's node_modules is no longer what the harness made: the link swapped for a folder of the model's
 *  own (whose .bin/vitest could just exit 0), pointed elsewhere, or a node_modules where there was none. */
export async function modulesTampered(c: Clone): Promise<boolean> {
  const p = path.join(c.dir, 'node_modules')
  const s = await lstat(p).catch(() => null)
  if (!c.link) return s !== null
  return !s?.isSymbolicLink() || await readlink(p) !== c.link
}

const CACHES = new Set(['.pytest_cache', '.mypy_cache', '.ruff_cache'])

/** git through the probe, on the clone's work tree, with a throwaway index that holds the work tree as it is now. */
async function probe<T>(c: Clone, fn: (g: (args: string[]) => Promise<string>) => Promise<T>): Promise<T> {
  const index = path.join(tmpdir(), `lhb-index-${randomBytes(4).toString('hex')}`)
  const g = (args: string[]) => git([`--git-dir=${c.probe}`, `--work-tree=${c.dir}`, ...args], c.dir, { GIT_INDEX_FILE: index })
  try {
    await g(['read-tree', c.sha])
    await g(['add', '-A', '--', '.'])
    // A .gitignore that ignores itself (or a folder's own) would hide everything the model added beside it (a shadow
    // `pytest/`, a `node_modules/chai`); an ignored .npmrc (a committed rule, the user's global excludes) would still be
    // read by npm. All go in, save a tool's cache that marks itself so in a folder the commit does not have: pytest,
    // mypy, ruff, and a venv (`python -m venv`) under a dot name, which no import or require can reach.
    const hidden = (await g(['ls-files', '-z', '-o', '-i', '--exclude-standard', '--', ':(glob)**/.gitignore', ':(glob)**/.npmrc'])).split('\0').filter(Boolean)
    const cache = (d: string) => CACHES.has(path.posix.basename(d)) || (path.posix.basename(d).startsWith('.') && existsSync(path.join(c.dir, d, 'pyvenv.cfg')))
    const dirs = [...new Set(hidden.filter(f => path.posix.basename(f) === '.gitignore').map(f => path.posix.dirname(f)).filter(cache))]
    const known = new Set(dirs.length ? (await g(['ls-tree', '-r', '-d', '-z', '--name-only', c.sha, '--', ...dirs.map(d => `:(literal)${d}`)])).split('\0') : [])
    const add = hidden.filter(f => path.posix.basename(f) === '.npmrc' || !dirs.includes(path.posix.dirname(f)) || known.has(path.posix.dirname(f)))
    if (add.length) await g(['add', '-f', '--', ...add.map(f => `:(literal)${f}`)])
    return await fn(g)
  } finally { await rm(index, { force: true }) }
}

/** Paths under `pathspecs` that differ from the commit: changed, added or deleted — read from the work tree, never the
 *  clone's index. Ignored files are left out by the committed rules; a rule of the model's own is a change to a
 *  .gitignore, which is protected. */
export const changedPaths = (c: Clone, pathspecs: string[]): Promise<string[]> =>
  probe(c, async g => (await g(['diff', '--cached', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', c.sha, '--', ...pathspecs])).split('\n').filter(Boolean))

export const protectedChanged = (c: Clone, t: RepoTasks): Promise<string[]> => changedPaths(c, t.protect)

const NO_TESTS = /^(?:#|ℹ) tests 0$/m

/** The run's final text is in a file whose path is `$LHB_FINAL_FILE` (empty when the run had no final), outside the clone so
 *  `git status` does not see it, removed after the check. Not a boundary: the check runs code the model could have changed. */
export async function runCheck(c: Clone, task: RepoTask, env: NodeJS.ProcessEnv, final?: string): Promise<{ pass: boolean; reason?: string }> {
  // Never through c.probe: that is the model's tree; mkdtemp is 0700 and `wx` refuses a file already there.
  const dir = await mkdtemp(path.join(tmpdir(), 'lhb-final-'))
  FINALS.add(dir)
  try {
    const file = path.join(dir, 'final.txt')
    await writeFile(file, final ?? '', { flag: 'wx' })
    return await check(c, task, { ...env, LHB_FINAL_FILE: file })
  } finally { await rm(dir, { recursive: true, force: true }); FINALS.delete(dir) }
}

async function check(c: Clone, task: RepoTask, env: NodeJS.ProcessEnv): Promise<{ pass: boolean; reason?: string }> {
  const r = await runShell(task.check, { cwd: c.dir, env, timeoutMs: task.checkTimeoutS * 1000, maxBuffer: 1 << 20, keep: 'tail' })
  if (r.spawnError !== undefined) return { pass: false, reason: `check did not start: ${r.spawnError}` }
  if (r.killed) return { pass: false, reason: `check timed out after ${task.checkTimeoutS}s` }
  // node --test finds no file and exits 0: a suite that ran nothing is not a pass.
  if (NO_TESTS.test(r.out)) return { pass: false, reason: 'the check found 0 tests' }
  return r.code === 0 ? { pass: true } : { pass: false, reason: `check exited ${r.code}` }
}

const PATCH_MAX = 1 << 20
const PATCH_EXCLUDE = [':(exclude,glob)**/.env*', ':(exclude,glob)**/*.pem', ':(exclude,glob)**/*.key']

/** What the run changed, as a patch, without files that look like secrets; binary files as "Binary files differ"; at most 1 MiB. */
export const patchOf = (c: Clone): Promise<string> => probe(c, async g => {
  const p = await g(['diff', '--cached', '--no-ext-diff', '--no-textconv', c.sha, '--', '.', ...PATCH_EXCLUDE])
  if (Buffer.byteLength(p) <= PATCH_MAX) return p
  // At the last line end before the cap: a newline is ASCII, so the cut never splits a character.
  const buf = Buffer.from(p)
  return buf.subarray(0, buf.lastIndexOf(10, PATCH_MAX) + 1).toString('utf8') + '[patch truncated at 1 MiB]\n'
})

/** The node_modules link first, so removing the clone can never reach what it points at. The probe and the registry
 *  entry go even when the clone cannot, so the exit hook does not try (and say so) a second time. */
export async function removeClone(c: Clone): Promise<void> {
  try { if ((await lstat(path.join(c.dir, 'node_modules'))).isSymbolicLink()) await unlink(path.join(c.dir, 'node_modules')) } catch { /* none */ }
  try { await rm(c.dir, { recursive: true, force: true }) } finally {
    await rm(c.probe, { recursive: true, force: true }).catch(() => {})
    LIVE.delete(c)
  }
}

/** The end of a run: its patch kept in `patchFile` (when given and not empty), the clone removed whatever happened.
 *  Never throws; says what failed, the patch or the removal. */
export async function finishRun(c: Clone, patchFile: string | undefined): Promise<string[]> {
  const warnings: string[] = []
  if (patchFile) try {
    const patch = await patchOf(c)
    if (patch.trim()) await writeFile(patchFile, patch)
  } catch (e) { warnings.push(`cannot keep the patch of run ${path.basename(patchFile, '.patch')}: ${(e as Error).message}`) }
  try { await removeClone(c) } catch (e) { warnings.push(`cannot remove the clone ${c.dir}: ${(e as Error).message}`) }
  return warnings
}

/** For a SIGINT handler that exits right after it. */
export function removeCloneSync(c: Clone): void {
  try { if (lstatSync(path.join(c.dir, 'node_modules')).isSymbolicLink()) unlinkSync(path.join(c.dir, 'node_modules')) } catch { /* none */ }
  rmSync(c.dir, { recursive: true, force: true })
  rmSync(c.probe, { recursive: true, force: true })
  LIVE.delete(c)
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
    else await add(name)
  }
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex')
}

/** Where the runs' node_modules link points: the user's repo, or — with a setup — a clone that ran it, so `npm ci`
 *  never touches the user's own tree. */
export async function prepareModules(t: RepoTasks, env: NodeJS.ProcessEnv = childEnv()): Promise<{ from: string }> {
  if (!t.setup) return { from: t.repo }
  const c = await cloneAt(t)
  const r = await runShell(t.setup, { cwd: c.dir, env, timeoutMs: 1_800_000, maxBuffer: 1 << 20, keep: 'tail' })
  if (r.code !== 0) {
    await removeClone(c)
    const last = r.out.trim().split('\n').at(-1) ?? ''
    throw new Error(`setup failed (${r.killed ? 'timed out' : r.spawnError ?? `exit ${r.code}`}): ${last}`)
  }
  return { from: c.dir }
}
