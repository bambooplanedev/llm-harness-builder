// Shared test fixtures. Not a *.test.ts, so vitest does not collect it: importing one test file
// from another re-registers its tests, which is why these used to be copied per file instead.
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { afterAll, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessConfig } from '../src/core/config.js'
import type { Backend, ChatRequest, Delta, NormalizedResponse } from '../src/core/backends/types.js'

const made: string[] = []
/** A fresh empty directory under the OS temp dir; removed when the importing test file is done. */
export const tmp = async (prefix: string) => { const d = await mkdtemp(join(tmpdir(), prefix)); made.push(d); return d }
/** tmp() for a test that cannot await: a default parameter, a sync helper. Removed with the others. */
export const tmpSync = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d }
afterAll(async () => { await Promise.all(made.splice(0).map(d => rm(d, { recursive: true, force: true }))) })

/** The git arguments every fixture commit uses: a test user, and no signing whatever the developer's global config says. */
export const GIT_TEST = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false']

/** A valid HarnessConfig; `over` replaces whole top-level sections. One definition, so a new required field breaks one place. */
export const harness = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  name: 'h',
  backend: { kind: 'openai', baseUrl: 'http://x/v1', model: 'fake-model', temperature: 0 },
  systemPrompt: 'sys',
  tools: { enabled: ['read_file', 'bash'], approveBash: false },
  toolCalls: { mode: 'native', enforceSchema: false, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' },
  context: { maxToolOutputChars: 4000, budgetTokens: 0 },
  loop: { maxTurns: 5 },
  ...over,
})

/**
 * One scripted backend response. Everything a real NormalizedResponse has is optional and defaulted;
 * `deltas` are streamed through onDelta first, and `wait` holds send() until it settles — that is how
 * a test keeps a run open until its SSE client has connected.
 */
export type FakeResponse = Partial<NormalizedResponse> & { deltas?: Delta[]; wait?: Promise<unknown> }

export type FakeBackend = Backend & { requests: ChatRequest[] }

/** A backend that plays `queue` in order and records every request it was asked to build. `build`: the body it
 *  returns for one, the request itself by default. */
export function fakeBackend(queue: FakeResponse[], build: (req: ChatRequest) => unknown = req => req): FakeBackend {
  const requests: ChatRequest[] = []
  return {
    requests,
    async listModels() { return ['fake-model'] },
    buildPayload(req: ChatRequest) { requests.push(structuredClone(req)); return build(req) },
    async send(_payload, _signal, onDelta) {
      const r = queue.shift()
      if (!r) throw new Error('fake backend: no more responses')
      const { deltas, wait, ...rest } = r
      if (wait) await wait
      for (const d of deltas ?? []) onDelta?.(d)
      return { content: '', toolCalls: [], raw: {}, ...rest }
    },
  }
}

/** A git repo in a fresh tmp dir whose name has a space in it, with `files` written and, unless `commit: false`, committed. */
export async function gitRepo(files: Record<string, string>, o: { commit?: boolean } = {}): Promise<string> {
  const { execFileSync } = await import('node:child_process')
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  const dir = join(await tmp('lhb-repo-'), 'my repo')
  await mkdir(dir)
  const git = (...a: string[]) => execFileSync('git', [...GIT_TEST, ...a], { cwd: dir, stdio: 'pipe' })
  git('init', '-q')
  for (const [f, text] of Object.entries(files)) { await mkdir(dirname(join(dir, f)), { recursive: true }); await writeFile(join(dir, f), text) }
  if (o.commit !== false && Object.keys(files).length) { git('add', '-A'); git('commit', '-qm', 'init') }
  return dir
}

/** Commits everything in `dir` as the test user. */
export async function gitCommit(dir: string, msg = 'next'): Promise<void> {
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', [...GIT_TEST, 'add', '-A'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', [...GIT_TEST, 'commit', '-qm', msg], { cwd: dir, stdio: 'pipe' })
}

/** Listens on a free loopback port; resolves to the port. Port 0 everywhere, so parallel test files never collide. */
export const listen = async (s: Server) => { await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); return (s.address() as { port: number }).port }

// --- The CLI as a child process. tsx by absolute path: npx from a tmp cwd does not resolve it.
export const ROOT = process.cwd()
export const harnessFile = (name: string) => join(ROOT, 'harnesses', `${name}.json`)
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx'), CLI_TS = join(ROOT, 'src', 'cli.ts')
export const spawnCli = (args: string[], opts: SpawnOptions = {}) => spawn(TSX, [CLI_TS, ...args], opts)
export const spawnCliSync = (args: string[], opts: SpawnSyncOptionsWithStringEncoding) => spawnSync(TSX, [CLI_TS, ...args], opts)
/** Writes the script LHB_FAKE_BACKEND plays to dir/fake.json; returns the path. */
export const fakeFile = (dir: string, script: unknown) => { const f = join(dir, 'fake.json'); writeFileSync(f, JSON.stringify(script)); return f }
// Fresh cwd per spawn: the CLI writes runs/ into cwd, which must not be the repo.
export const cli = (args: string[], env: Record<string, string> = {}, cwd = tmpSync('lhb-cwd-')) =>
  Object.assign(spawnCliSync(args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } }), { cwd })
/** cli() for a test whose server lives in this process: spawnSync would block the server the CLI talks to. */
export const cliAsync = (args: string[], env: Record<string, string> = {}, cwd = tmpSync('lhb-cwd-')) =>
  new Promise<{ status: number | null; stdout: string; stderr: string; cwd: string }>(resolve => {
    const p = spawnCli(args, { cwd, env: { ...process.env, ...env } })
    let stdout = '', stderr = ''
    p.stdout!.on('data', d => (stdout += d)); p.stderr!.on('data', d => (stderr += d))
    p.on('close', status => resolve({ status, stdout, stderr, cwd }))
  })

// --- bench --tasks: a repo of the user's own, runs in clones. Every spawn gets its own TMPDIR, so "no clone is left"
// is about this bench only, whatever other test files run alongside.
export const tasksRepo = (tasks: object[], extra: Record<string, string> = {}) => gitRepo({ 'lhb-tasks.json': JSON.stringify({ tasks }), ...extra })
export const tasksEnv = async (fake: unknown[]) => {
  const d = await tmp('lhb-tasks-env-')
  const tmpd = join(d, 'tmp'); mkdirSync(tmpd)
  writeFileSync(join(d, 'fake.json'), JSON.stringify(fake))
  return { TMPDIR: tmpd, LHB_FAKE_BACKEND: join(d, 'fake.json'), LHB_STATE_DIR: join(d, 'state'), LHB_NOTES_DIR: join(d, 'notes') }
}
export const clonesIn = (env: { TMPDIR: string }) => readdirSync(env.TMPDIR).filter(f => f.startsWith('lhb-2'))
export const bashCall = (command: string) => ({ toolCalls: [{ name: 'bash', args: { command } }] })
export const TWO = [{ name: 'a', prompt: 'make done.txt', check: 'test -f done.txt' }, { name: 'b', prompt: 'b', check: 'exit 1' }]

// --- evolve: the same clones and fake as bench --tasks. The fake answers by what the request holds: the proposer's
// system prompt, the paragraph it proposes (bash makes done.txt: PASS), or neither (a final answer: FAIL). The
// proposer's entry goes first — after an acceptance its input holds the paragraph too, and the first entry that fits wins.
export const ALWAYS = 'ALWAYS make done.txt before you answer.'
export const evFake = (o: { value?: string; prompt?: number; doneUsage?: object } = {}) => [
  { when: 'You improve the harness', keep: true, content: JSON.stringify({ field: 'systemPrompt', value: o.value ?? ALWAYS }), usage: { promptTokens: 50, completionTokens: 5 } },
  { when: 'ALWAYS make done.txt', keep: true, ...bashCall('echo ok > done.txt'), usage: { promptTokens: o.prompt ?? 100, completionTokens: 10 } },
  { keep: true, content: 'done', usage: o.doneUsage ?? { promptTokens: 100, completionTokens: 10 } },
]
export const evHarness = (cwd: string) => {
  const h = join(cwd, 'h.json')
  writeFileSync(h, JSON.stringify({ ...JSON.parse(readFileSync(harnessFile('bare'), 'utf8')), name: 'h', tools: { enabled: ['bash'], approveBash: true }, loop: { maxTurns: 1 } }, null, 2))
  return h
}
export const evTasks = (sets: Record<'train' | 'gate' | 'test', number>, prefix = 'job') =>
  Object.entries(sets).flatMap(([set, n]) => Array.from({ length: n }, (_, i) => ({ name: `${prefix}-${set}-${i}`, prompt: 'make the file', check: 'test -f done.txt', set })))
export const journal = (cwd: string) => readFileSync(join(cwd, 'harnesses', 'h.evolve.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
export const ONE_EACH = { train: 1, gate: 1, test: 1 }
// Two accepted candidates must differ in field now, and only a paragraph steers the fake: so the runs go in order, not by what the request holds.
// After the probe: train and gate, each cur FAIL then both candidates PASS; then the test pair, original FAIL and version PASS.
export const TWO_WAYS = () => {
  const u = { usage: { promptTokens: 100, completionTokens: 10 } }
  const [no, yes] = [{ content: 'done', ...u }, { ...bashCall('echo ok > done.txt'), ...u }]
  const prop = (field: string, value: string | number) => ({ when: 'You improve the harness', content: JSON.stringify({ field, value }), usage: { promptTokens: 50, completionTokens: 5 } })
  return [prop('systemPrompt', ALWAYS), prop('loop.maxRepeats', 3), no, no, yes, yes, no, yes, yes, no, yes]
}
/** Every run a journal line holds, whatever the line. */
export const allRuns = (l: any): any[] => [...(l.runs ?? []), ...(l.cur ?? []), ...(l.cands ?? []).flatMap((c: any) => c.runs), ...(l.orig ?? []), ...(l.last ?? [])]

export const priced = (h: string) => { const c = JSON.parse(readFileSync(h, 'utf8')); writeFileSync(h, JSON.stringify({ ...c, backend: { ...c.backend, pricePerMTok: { input: 1, output: 2 } } })) }
export const evRaw = (cwd: string) => readFileSync(join(cwd, 'harnesses', 'h.evolve.jsonl'), 'utf8')
export const evFirst = async (run = ['--rounds', '1']) => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const h = evHarness(cwd)
  const r = cli(['evolve', h, '--tasks', repo, ...run, '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  return { repo, env, cwd, h }
}
export const types = (cwd: string) => journal(cwd).map(l => l.type)
export const writeJournal = (cwd: string, ls: object[]) => writeFileSync(join(cwd, 'harnesses', 'h.evolve.jsonl'), ls.map(l => JSON.stringify(l) + '\n').join(''))
