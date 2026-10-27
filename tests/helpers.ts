// Shared test fixtures. Not a *.test.ts, so vitest does not collect it: importing one test file
// from another re-registers its tests, which is why these used to be copied per file instead.
import { mkdtemp, rm } from 'node:fs/promises'
import { afterAll } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessConfig } from '../src/core/config.js'
import type { Backend, ChatRequest, Delta, NormalizedResponse } from '../src/core/backends/types.js'

const made: string[] = []
/** A fresh empty directory under the OS temp dir; removed when the importing test file is done. */
export const tmp = async (prefix: string) => { const d = await mkdtemp(join(tmpdir(), prefix)); made.push(d); return d }
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
