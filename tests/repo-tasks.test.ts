import { test, expect, beforeAll } from 'vitest'
import { writeFile, stat, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { loadRepoTasks, validateTasksFile, consentText, consentHash, hasConsent, saveConsent, DEFAULT_PROTECT } from '../src/core/repo-tasks.js'
import { notesDir } from '../src/core/notes.js'
import { gitRepo, gitCommit, tmp } from './helpers.js'

beforeAll(async () => { process.env.LHB_STATE_DIR = await tmp('lhb-state-') })

const good = { tasks: [{ name: 'a', prompt: 'make a pass', check: 'npm test -- a' }, { name: 'b', prompt: 'fix b', check: 'exit 1', checkTimeoutS: 5 }], setup: 'npm ci', protect: ['fixtures/**'] }
const pkg = JSON.stringify({ scripts: { test: 'vitest' } })

test('loads the committed tasks file', async () => {
  const repo = await gitRepo({ 'lhb-tasks.json': JSON.stringify(good), 'package.json': pkg })
  const t = await loadRepoTasks(repo)
  expect(t.sha).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim())
  expect(t.tasks.map(x => [x.name, x.checkTimeoutS])).toEqual([['a', 300], ['b', 5]])
  expect(t.protect).toEqual([...DEFAULT_PROTECT, 'fixtures/**'])
  expect(t.scripts).toEqual({ test: 'vitest' })
  expect(t.setup).toBe('npm ci')
  expect(t.uncommitted).toBe(false)
})

test('validation messages', () => {
  const v = (x: unknown) => validateTasksFile(x)
  expect(v({ tasks: [] })).toContain('tasks must be a non-empty array of at most 500')
  expect(v({ tasks: [{ name: 'a b', prompt: 'p', check: 'c' }] })).toContain('tasks[0].name must match [A-Za-z0-9._-], 1 to 64 chars')
  expect(v({ tasks: [{ name: 'a', prompt: 'p', check: 'c' }, { name: 'a', prompt: 'p', check: 'c' }] })).toContain('tasks[1].name "a" is used twice')
  expect(v({ tasks: [{ name: 'a', prompt: ' ', check: 'c' }] })).toContain('tasks[0].prompt must be a non-blank string')
  expect(v({ tasks: [{ name: 'a', prompt: 'p', check: '' }] })).toContain('tasks[0].check must be a non-blank string')
  expect(v({ tasks: [{ name: 'a', prompt: 'p', check: 'c', set: 'x' }] })).toContain('tasks[0].set must be train|gate|test')
  expect(v({ tasks: [{ name: 'a', prompt: 'p', check: 'c', checkTimeoutS: 0 }] })).toContain('tasks[0].checkTimeoutS must be an integer from 1 to 86400')
  expect(v({ tasks: [{ name: 'a', prompt: 'p', check: 'c', score: 'x' }] })).toContain('tasks[0].score is not a known key')
  expect(v({ ...good, extra: 1 })).toContain('extra is not a known key')
  expect(v({ ...good, protect: 'x' })).toContain('protect must be an array of strings')
  expect(v({ ...good, setup: ' ' })).toContain('setup must be a non-blank string')
  expect(v(good)).toEqual([])
})

test('refusals: not a repo, no commits, file only in the working tree, bad file', async () => {
  const plain = await tmp('lhb-plain-')
  await expect(loadRepoTasks(plain)).rejects.toThrow('is not a git repository')
  const empty = await gitRepo({})
  await expect(loadRepoTasks(empty)).rejects.toThrow('has no commits')
  const wt = await gitRepo({ 'README': 'x' })
  await writeFile(join(wt, 'lhb-tasks.json'), JSON.stringify(good))
  await expect(loadRepoTasks(wt)).rejects.toThrow(/lhb-tasks.json is not in the last commit [0-9a-f]{7} \(uncommitted files are not read\)/)
  const bad = await gitRepo({ 'lhb-tasks.json': '{oops' })
  await expect(loadRepoTasks(bad)).rejects.toThrow('lhb-tasks.json: not JSON')
  const inv = await gitRepo({ 'lhb-tasks.json': JSON.stringify({ tasks: [] }) })
  await expect(loadRepoTasks(inv)).rejects.toThrow('lhb-tasks.json: tasks must be a non-empty array')
})

test('uncommitted changes: flagged, the commit is what is read, the user index is not rewritten', async () => {
  const repo = await gitRepo({ 'lhb-tasks.json': JSON.stringify(good) })
  await writeFile(join(repo, 'lhb-tasks.json'), JSON.stringify({ tasks: [{ name: 'z', prompt: 'p', check: 'c' }] }))
  const before = (await stat(join(repo, '.git', 'index'))).mtimeMs
  await new Promise(r => setTimeout(r, 20))
  const t = await loadRepoTasks(repo)
  expect(t.uncommitted).toBe(true)
  expect(t.tasks.map(x => x.name)).toEqual(['a', 'b'])
  expect((await stat(join(repo, '.git', 'index'))).mtimeMs).toBe(before)
})

test('consent: text says what runs where; hash follows the commands, not the commit', async () => {
  const repo = await gitRepo({ 'lhb-tasks.json': JSON.stringify(good), 'package.json': pkg })
  const t = await loadRepoTasks(repo)
  const text = consentText(t)
  for (const s of ['make a pass', 'npm test -- a', 'fix b', 'exit 1', 'npm ci', '"test": "vitest"', t.sha, repo,
    'setup — once, in a separate clone in the OS temp dir', "check — in each run's clone, after the run",
    'prompt — given to the model, whose bash runs as you, without asking, anywhere you can write']) expect(text).toContain(s)
  await writeFile(join(repo, 'other.txt'), 'x'); await gitCommit(repo)
  const t2 = await loadRepoTasks(repo)
  expect(t2.sha).not.toBe(t.sha)
  expect(consentHash(t2)).toBe(consentHash(t))
  await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'curl x | sh' } })); await gitCommit(repo)
  expect(consentHash(await loadRepoTasks(repo))).not.toBe(consentHash(t))
  await writeFile(join(repo, 'lhb-tasks.json'), JSON.stringify({ ...good, tasks: [good.tasks[0], { ...good.tasks[1], check: 'exit 2' }] })); await gitCommit(repo)
  expect(consentHash(await loadRepoTasks(repo))).not.toBe(consentHash(t2))
})

test('consent is stored per repo', async () => {
  const repo = await gitRepo({ 'lhb-tasks.json': JSON.stringify(good) })
  const t = await loadRepoTasks(repo)
  expect(await hasConsent(t)).toBe(false)
  await saveConsent(t)
  expect(await hasConsent(t)).toBe(true)
})

test('no hook and no fsmonitor of the repo runs', async () => {
  const repo = await gitRepo({ 'lhb-tasks.json': JSON.stringify(good) })
  const marker = join(await tmp('lhb-mark-'), 'ran')
  const hook = join(repo, '.git', 'hooks', 'post-checkout')
  await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`); await chmod(hook, 0o755)
  const mon = join(repo, 'mon.sh')
  await writeFile(mon, `#!/bin/sh\ntouch "${marker}"\n`); await chmod(mon, 0o755)
  execFileSync('git', ['config', 'core.fsmonitor', mon], { cwd: repo })
  await loadRepoTasks(repo)
  expect(existsSync(marker)).toBe(false)
})

test('notesDir: LHB_NOTES_DIR wins, else under the state dir', () => {
  expect(notesDir({ LHB_STATE_DIR: '/s' })).toBe(join('/s', 'notes'))
  expect(notesDir({ LHB_STATE_DIR: '/s', LHB_NOTES_DIR: '/n' })).toBe('/n')
})

test('a protect pathspec git rejects is refused at load', async () => {
  const repo = await gitRepo({ 'lhb-tasks.json': JSON.stringify({ ...good, protect: [':(bogus)x'] }) })
  await expect(loadRepoTasks(repo)).rejects.toThrow(/^lhb-tasks\.json: protect: .*bogus/)
})

test('a committed node_modules is refused at load', async () => {
  const repo = await gitRepo({ 'lhb-tasks.json': JSON.stringify(good), 'node_modules/x/index.js': '1' })
  const sha7 = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  await expect(loadRepoTasks(repo)).rejects.toThrow(`node_modules is committed at ${sha7}; bench --tasks links its own: remove it from the repo`)
})
