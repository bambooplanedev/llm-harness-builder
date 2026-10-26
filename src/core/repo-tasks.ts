// The user's own tasks: lhb-tasks.json read from the repo's last commit — never from the working tree or a clone, where
// the model could rewrite it — and the consent to the commands it holds, kept by hash.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { childEnv } from './tools/env.js'
import { notesKey, stateDir } from './notes.js'

/** Every git command the harness itself runs: no hook, no fsmonitor, no system config, no replace refs, no prompt. */
export function git(args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<string> {
  const env = { ...childEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', ...extraEnv }
  return new Promise((resolve, reject) => execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    { cwd, env, maxBuffer: 64 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr).trim().split('\n')[0] || err.message)) : resolve(stdout)))
}

export type RepoTask = { name: string; prompt: string; check: string; set?: 'train' | 'gate' | 'test'; checkTimeoutS: number }
export type RepoTasks = { repo: string; sha: string; tasks: RepoTask[]; setup?: string; protect: string[]; scripts: Record<string, string>; uncommitted: boolean }

export const TASKS_FILE = 'lhb-tasks.json'

/** Paths a run may not change: tests, manifests, lock files, test-runner configs, the tasks file. Git pathspecs. */
export const DEFAULT_PROTECT = [
  ':(glob)**/*.test.*', ':(glob)**/*.spec.*', ':(glob)**/test/**', ':(glob)**/tests/**', ':(glob)**/__tests__/**',
  ':(glob)**/package.json', ':(glob)**/package-lock.json', ':(glob)**/pnpm-lock.yaml', ':(glob)**/yarn.lock',
  ':(glob)**/vitest.config.*', ':(glob)**/vitest.workspace.*', ':(glob)**/jest.config.*', ':(glob)**/.mocharc*', ':(glob)**/vite.config.*', ':(glob)**/.npmrc',
  ':(glob)**/tsconfig*.json', ':(glob)**/.gitignore', TASKS_FILE,
]

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const blank = (v: unknown) => typeof v !== 'string' || !v.trim()
const NAME = /^[A-Za-z0-9._-]{1,64}$/

export function validateTasksFile(x: unknown): string[] {
  if (!isObj(x)) return ['the file must hold an object']
  const e: string[] = []
  for (const k of Object.keys(x)) if (!['tasks', 'setup', 'protect'].includes(k)) e.push(`${k} is not a known key`)
  if (!Array.isArray(x.tasks) || !x.tasks.length || x.tasks.length > 500) e.push('tasks must be a non-empty array of at most 500')
  else {
    const seen = new Set<string>()
    x.tasks.forEach((t: unknown, i: number) => {
      const at = `tasks[${i}]`
      if (!isObj(t)) { e.push(`${at} must be an object`); return }
      for (const k of Object.keys(t)) if (!['name', 'prompt', 'check', 'set', 'checkTimeoutS'].includes(k)) e.push(`${at}.${k} is not a known key`)
      if (typeof t.name !== 'string' || !NAME.test(t.name)) e.push(`${at}.name must match [A-Za-z0-9._-], 1 to 64 chars`)
      else if (seen.has(t.name)) e.push(`${at}.name "${t.name}" is used twice`)
      else seen.add(t.name)
      if (blank(t.prompt)) e.push(`${at}.prompt must be a non-blank string`)
      if (blank(t.check)) e.push(`${at}.check must be a non-blank string`)
      if (t.set !== undefined && !['train', 'gate', 'test'].includes(t.set)) e.push(`${at}.set must be train|gate|test`)
      if (t.checkTimeoutS !== undefined && !(Number.isInteger(t.checkTimeoutS) && t.checkTimeoutS >= 1 && t.checkTimeoutS <= 86400)) e.push(`${at}.checkTimeoutS must be an integer from 1 to 86400`)
    })
  }
  if (x.setup !== undefined && blank(x.setup)) e.push('setup must be a non-blank string')
  if (x.protect !== undefined && !(Array.isArray(x.protect) && x.protect.every((p: unknown) => typeof p === 'string' && p))) e.push('protect must be an array of strings')
  return e
}

export async function loadRepoTasks(dir: string): Promise<RepoTasks> {
  let repo: string
  try {
    repo = await realpath(dir)
    if ((await git(['rev-parse', '--show-toplevel'], repo)).trim() !== repo) throw new Error()
  } catch { throw new Error(`${dir} is not a git repository`) }
  let sha: string
  try { sha = (await git(['rev-parse', '--verify', 'HEAD^{commit}'], repo)).trim() } catch { throw new Error(`${repo} has no commits`) }
  let text: string
  try { text = await git(['show', `${sha}:${TASKS_FILE}`], repo) } catch { throw new Error(`${TASKS_FILE} is not in the last commit ${sha.slice(0, 7)} (uncommitted files are not read)`) }
  let x: any
  try { x = JSON.parse(text) } catch (e) { throw new Error(`${TASKS_FILE}: not JSON: ${(e as Error).message}`) }
  const errors = validateTasksFile(x)
  if (errors.length) throw new Error(`${TASKS_FILE}: ${errors[0]}`)
  const protect = [...DEFAULT_PROTECT, ...(x.protect ?? [])]
  // Before any model time: a pathspec git rejects would fail every run's protect check only after its run.
  try { await git(['diff', '--name-only', sha, sha, '--', ...protect], repo) } catch (e) { throw new Error(`${TASKS_FILE}: protect: ${(e as Error).message}`) }
  // A committed node_modules is in every clone, where the link the runs get cannot go.
  if ((await git(['ls-tree', '--name-only', sha, 'node_modules'], repo)).trim())
    throw new Error(`node_modules is committed at ${sha.slice(0, 7)}; bench --tasks links its own: remove it from the repo`)
  let scripts: Record<string, string> = {}
  try {
    const p = JSON.parse(await git(['show', `${sha}:package.json`], repo))
    if (isObj(p.scripts)) scripts = Object.fromEntries(Object.entries(p.scripts).filter(([, v]) => typeof v === 'string')) as Record<string, string>
  } catch { /* no package.json at that commit, or not JSON: nothing npm would run */ }
  // --no-optional-locks: a plain status refreshes the user's index, and this must leave the repo as it is.
  const uncommitted = (await git(['--no-optional-locks', 'status', '--porcelain'], repo)).trim() !== ''
  return {
    repo, sha, setup: x.setup, protect, scripts, uncommitted,
    tasks: x.tasks.map((t: any) => ({ name: t.name, prompt: t.prompt, check: t.check, ...(t.set ? { set: t.set } : {}), checkTimeoutS: t.checkTimeoutS ?? 300 })),
  }
}

const SHA_LINE = (sha: string) => `commit: ${sha}`

/** What `bench --tasks` will run and where, as the user is asked to accept it. `npm test` runs the package's scripts, so they are in it. */
export type EvolveConsent = { proposer: string; fields: string[] }

/** `evolve` asks on top of the bench text, never in place of it: lines after it, so a bench hash stays what it was. */
export function consentText(t: RepoTasks, ev?: EvolveConsent): string {
  const host = (u: string) => { try { return new URL(u).host || u } catch { return u } }
  return [
    `repo: ${t.repo}`, SHA_LINE(t.sha), '',
    'setup — once, in a separate clone in the OS temp dir',
    "check — in each run's clone, after the run",
    'prompt — given to the model, whose bash runs as you, without asking, anywhere you can write', '',
    `setup: ${t.setup === undefined ? '(none)' : JSON.stringify(t.setup)}`,
    ...t.tasks.flatMap(x => [`task ${x.name}`, `  prompt: ${JSON.stringify(x.prompt)}`, `  check: ${JSON.stringify(x.check)}`]),
    'package.json scripts:', ...Object.entries(t.scripts).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`),
    ...(ev ? ["mode: evolve — the model's own prompts run unreviewed while Evolve measures them", `proposer: ${host(ev.proposer)}`, `fields: ${ev.fields.join(', ')}`] : []),
  ].join('\n')
}

/** The hash leaves the commit out: a commit that changes neither the tasks nor the scripts asks nothing again. */
export const consentHash = (t: RepoTasks, ev?: EvolveConsent): string =>
  createHash('sha256').update(consentText(t, ev).split('\n').filter(l => l !== SHA_LINE(t.sha)).join('\n')).digest('hex')

// A file of its own for evolve, so saying yes to one never takes back the yes to the other.
const consentFile = async (t: RepoTasks, ev?: EvolveConsent) => path.join(stateDir(), 'consent', `${await notesKey(t.repo)}${ev ? '.evolve' : ''}.json`)

export async function hasConsent(t: RepoTasks, ev?: EvolveConsent): Promise<boolean> {
  try { return JSON.parse(await readFile(await consentFile(t, ev), 'utf8')).hash === consentHash(t, ev) } catch { return false }
}

export async function saveConsent(t: RepoTasks, ev?: EvolveConsent): Promise<void> {
  const f = await consentFile(t, ev)
  await mkdir(path.dirname(f), { recursive: true })
  await writeFile(f, JSON.stringify({ hash: consentHash(t, ev) }) + '\n')
}
