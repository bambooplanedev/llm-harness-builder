import { test, expect, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { copyFileSync, existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, harnessFile as harness, cli, tmp, tasksRepo, tasksEnv, clonesIn, bashCall, evFake, evHarness, evTasks, journal, ONE_EACH, TWO_WAYS, priced, evRaw, evFirst, types, writeJournal, gitCommit } from './helpers.js'

test('evolve: a proposal with a URL is refused before any run', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake({ value: 'see https://x.io' }))
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  const cands = journal(cwd).filter(l => l.type === 'candidate')
  expect(cands).toHaveLength(2)
  // Candidate 1's field is closed for candidate 2: asked twice, it stays on it.
  expect(cands.map(c => [c.index, c.reason])).toEqual([[1, 'looks like a command or an address'], [2, 'field exhausted']])
  expect(types(cwd)).not.toContain('sweep')
  expect(r.stdout).toContain('no version beat the original')
  expect(existsSync(join(cwd, 'harnesses', 'h.v1.json'))).toBe(false)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: candidate 2 is told candidate 1\'s field is closed and moves to another', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const other = { when: 'closed for now, propose another: systemPrompt', keep: true, content: JSON.stringify({ field: 'loop.maxRepeats', value: 3 }), usage: { promptTokens: 50, completionTokens: 5 } }
  const env = await tasksEnv([other, ...evFake()])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  const cands = journal(cwd).filter(l => l.type === 'candidate')
  expect(cands.map(c => [c.index, c.edit.field])).toEqual(expect.arrayContaining([[1, 'systemPrompt'], [2, 'loop.maxRepeats']]))
  expect(r.stderr).toContain('proposer: 110 tokens')
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: a reply on a closed field is asked once more, then journaled field exhausted with no runs', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  const lines = journal(cwd)
  expect(lines.find(l => l.type === 'candidate' && l.index === 2)).toMatchObject({ accepted: false, reason: 'field exhausted', edit: { field: 'systemPrompt' } })
  expect(lines.filter(l => l.type === 'sweep').every(l => l.cands.length === 1)).toBe(true)
  // 55 tokens a call: candidate 1 once, candidate 2 twice.
  expect(r.stderr).toContain('proposer: 165 tokens')
}, 120_000)

test('evolve: with every field closed the rounds end and the report says so', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  // Refused before any run (a string where a number goes), two fields a round, each twice: eight fields in eight rounds.
  const fields = ['systemPrompt', 'loop.maxTurns', 'loop.maxRepeats', 'loop.freshContext', 'loop.repeatTemperature', 'loop.repeatThinkTokens', 'context.maxToolOutputChars', 'context.budgetTokens']
  const bad = (field: string) => ({ content: JSON.stringify({ field, value: field === 'systemPrompt' ? ' ' : 'x' }), usage: { promptTokens: 50, completionTokens: 5 } })
  const asks = fields.flatMap((f, i) => i % 2 ? [] : [bad(f), bad(fields[i + 1]!), bad(f), bad(fields[i + 1]!)])
  const env = await tasksEnv([{ content: 'done', usage: { promptTokens: 100, completionTokens: 10 } }, ...asks])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '9', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(r.stdout).toContain('every field is exhausted')
  expect(r.stderr).toContain('proposer: 880 tokens')
  expect(journal(cwd).filter(l => l.type === 'candidate')).toHaveLength(16)
  expect(types(cwd)).not.toContain('sweep')
}, 120_000)

test('evolve: a candidate whose first request is heavier than the ceiling is refused', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  // The same total tokens per run on both sides, so only the first request's weight differs.
  const env = await tasksEnv(evFake({ prompt: 200, doneUsage: { promptTokens: 100, completionTokens: 110 } }))
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  const c = journal(cwd).find(l => l.type === 'candidate' && l.index === 1)
  expect([c.accepted, c.reason]).toEqual([false, 'first request 100% heavier than the original'])
  expect(journal(cwd).find(l => l.type === 'sweep').cands[0].runs).toHaveLength(2)
  expect(r.stdout).toContain('no version beat the original')
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: refuses when harnesses/h.v1.json already exists, before any run', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  mkdirSync(join(cwd, 'harnesses')); writeFileSync(join(cwd, 'harnesses', 'h.v1.json'), '{}\n')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain(join('harnesses', 'h.v1.json'))
  expect(readFileSync(join(cwd, 'harnesses', 'h.v1.json'), 'utf8')).toBe('{}\n')
  expect(existsSync(join(cwd, 'runs'))).toBe(false)
  expect(existsSync(join(cwd, 'harnesses', 'h.evolve.jsonl'))).toBe(false)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

// --max-usd: the harness's own price is what counts. A run of the fake costs $0.00012 (100 + 10 tokens at $1 and $2), a proposal $0.00006.

test('evolve --max-usd: a priced harness needs the flag, an unpriced one refuses it, a bad value is an argument error', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-'), h = evHarness(cwd)
  const run = (extra: string[]) => cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes', ...extra], env, cwd)
  const plain = run(['--max-usd', '1'])
  expect(plain.status).toBe(2)
  expect(plain.stderr).toContain('no price to count against')
  priced(h)
  const bare = run([])
  expect(bare.status).toBe(2)
  expect(bare.stderr).toMatch(/^error: evolve on a priced harness needs --max-usd <dollars>/m)
  for (const v of ['0', '-1', 'abc', 'Infinity']) { const r = run([`--max-usd=${v}`]); expect(r.status, v).toBe(2); expect(r.stderr, v).toMatch(/^error: --max-usd must be a positive number$/m) }
  expect(existsSync(join(cwd, 'harnesses'))).toBe(false)
}, 120_000)

test('evolve --max-usd: a priced harness with an unpriced proposer starts and says the proposer is not counted', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-'), h = evHarness(cwd), p = join(cwd, 'p.json')
  priced(h); copyFileSync(harness('bare'), p)
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes', '--max-usd', '5', '--proposer', p], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(r.stderr).toMatch(/^the proposer has no price: its calls are not counted against --max-usd$/m)
  expect(journal(cwd).some(l => l.type === 'proposal' && l.costUsd !== undefined)).toBe(false)
}, 120_000)

test('evolve --max-usd: the limit stops before a run, drops the cut sweep, and the same command with a higher limit continues; --report needs no flag', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-'), h = evHarness(cwd)
  priced(h)
  const run = (limit: string) => cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes', '--max-usd', limit], env, cwd)
  // The probe ($0.00012) and the proposals ($0.00006 each) fit; the first sweep's second run does not.
  const stopped = run('0.0004')
  expect(stopped.status, stopped.stderr).toBe(1)
  expect(stopped.stderr).toMatch(/^evolve stopped: spent \$0\.\d+ of \$0\.0004; the cut sweep's money is in the journal, its runs are not; run again with a higher --max-usd to continue$/m)
  const lines = journal(cwd)
  // The first sweep's first run: its money stays though its runs go.
  expect(lines.at(-1).type).toBe('cut')
  expect(lines.at(-1).costUsd).toBeCloseTo(0.00012, 9)
  expect(lines.some(l => l.type === 'sweep')).toBe(false)
  expect(lines.find(l => l.type === 'proposal').costUsd).toBeCloseTo(0.00006, 9)
  expect(clonesIn(env)).toEqual([])
  // Over the limit already: nothing is asked.
  const again = run('0.0004')
  expect(again.status).toBe(1)
  expect(again.stderr).toContain('evolve stopped: spent $')
  const go = run('5')
  expect(go.status, go.stderr).toBe(0)
  expect(go.stdout).toMatch(/^spent \$0\.\d+$/m)
  const rep = cli(['evolve', h, '--tasks', repo, '--report'], env, cwd)
  expect(rep.status, rep.stderr).toBe(0)
  expect(rep.stdout).toBe(go.stdout)
}, 180_000)

test('evolve: without consent and without a terminal it shows the evolve consent and stops', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1'], env, cwd)
  expect(r.status).toBe(2)
  for (const s of ['mode: evolve', 'fields: systemPrompt', 'pass --yes']) expect(r.stderr).toContain(s)
  expect(existsSync(join(cwd, 'harnesses', 'h.evolve.jsonl'))).toBe(false)
  expect(existsSync(join(cwd, 'runs'))).toBe(false)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

for (const [what, fake, money] of [
  ['a sweep', () => [evFake()[0], { content: 'done', usage: { promptTokens: 100, completionTokens: 10 } }, { content: 'done', usage: { promptTokens: 100, completionTokens: 10 } }, { throw: { status: 401 } }], 0.00012],
  ['a proposal', () => { const prop = { ...evFake()[0], keep: false }; return [prop, prop, { ...prop, throw: { status: 401 } }, evFake()[2]] }, 0.00006],
] as const) test(`evolve: a stop on a refused key drops ${what} and keeps its money in a cut line`, async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(fake() as object[])
  const cwd = await tmp('lhb-cwd-'), h = evHarness(cwd)
  priced(h)
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes', '--max-usd', '5'], env, cwd)
  expect(r.status, r.stderr).toBe(1)
  expect(r.stderr).toContain('answered 401')
  const last = journal(cwd).at(-1)
  expect(last.type).toBe('cut')
  expect(last.costUsd).toBeCloseTo(money, 9)
  // The same command goes on past it; the report counts it.
  writeFileSync(env.LHB_FAKE_BACKEND, JSON.stringify(evFake()))
  const go = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes', '--max-usd', '5'], env, cwd)
  expect(go.status, go.stderr).toBe(0)
  expect(types(cwd)).toContain('cut')
}, 120_000)

for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) test(`evolve: ${sig} in a sweep keeps the finished runs' money in a cut line and leaves no clone`, async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv([])
  const cwd = await tmp('lhb-cwd-'), h = evHarness(cwd), mark = join(cwd, 'in-the-run')
  const [prop, , done] = evFake()
  writeFileSync(env.LHB_FAKE_BACKEND, JSON.stringify([prop, { when: 'ALWAYS make done.txt', keep: true, ...bashCall(`touch ${mark}; sleep 60`), usage: { promptTokens: 100, completionTokens: 10 } }, done]))
  priced(h)
  const p = spawn(process.execPath, ['--import', pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(ROOT, 'src', 'cli.ts'), 'evolve', h, '--tasks', repo, '--rounds', '1', '--yes', '--max-usd', '5'], { cwd, env: { ...process.env, ...env }, stdio: 'ignore' })
  try {
    await vi.waitFor(() => expect(existsSync(mark)).toBe(true), { timeout: 60_000, interval: 100 })
    expect(await new Promise(done => { p.on('exit', done); p.kill(sig) })).toBe(code)
  } finally { p.kill('SIGKILL') }
  const last = journal(cwd).at(-1)
  expect(last.type).toBe('cut')
  expect(last.costUsd).toBeCloseTo(0.00012, 9)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

// --- evolve resume: stopped and started again, it goes on from the journal or says why not.

test('evolve: a journal moved away and started again is attempt 2; a resume and --report keep attempt 1', async () => {
  const { repo, env, cwd, h } = await evFirst()
  const jf = join(cwd, 'harnesses', 'h.evolve.jsonl')
  expect(journal(cwd)[0].attempt).toBe(1)
  expect(cli(['evolve', h, '--tasks', repo, '--report'], env, cwd).stdout).toContain('attempt 1')
  expect(cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd).stdout).toContain('attempt 1')
  rmSync(jf); rmSync(join(cwd, 'harnesses', 'h.v1.json'), { force: true })
  expect(cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd).status).toBe(0)
  expect(journal(cwd)[0].attempt).toBe(2)
  expect(cli(['evolve', h, '--tasks', repo, '--report'], env, cwd).stdout).toContain('attempt 2')
  // A start line without it, or a counter nobody can read: unknown, never a guess.
  const lines = evRaw(cwd).split('\n'), { attempt, ...start } = JSON.parse(lines[0]!)
  writeFileSync(jf, [JSON.stringify(start), ...lines.slice(1)].join('\n'))
  expect(cli(['evolve', h, '--tasks', repo, '--report'], env, cwd).stdout).toContain('attempt unknown')
}, 240_000)

test('evolve: the attempt counts on over a commit that leaves the tasks alone and a reformatted harness; a changed task starts anew', async () => {
  const { repo, env, cwd, h } = await evFirst()
  const again = () => {
    rmSync(join(cwd, 'harnesses', 'h.evolve.jsonl')); rmSync(join(cwd, 'harnesses', 'h.v1.json'), { force: true })
    const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
    expect(r.status, r.stderr).toBe(0)
    return journal(cwd)[0].attempt
  }
  writeFileSync(join(repo, 'other.txt'), 'x'); await gitCommit(repo, 'unrelated')
  const c = JSON.parse(readFileSync(h, 'utf8'))
  writeFileSync(h, JSON.stringify(Object.fromEntries(Object.entries(c).reverse())))
  expect(again()).toBe(2)
  writeFileSync(join(repo, 'lhb-tasks.json'), JSON.stringify({ tasks: evTasks(ONE_EACH).map(t => ({ ...t, prompt: 'make the file now' })) })); await gitCommit(repo, 'tasks')
  expect(again()).toBe(1)
}, 240_000)

test('evolve: a garbage attempt counter stays as it is and every start is unknown', async () => {
  const { repo, env, cwd, h } = await evFirst()
  const dir = join(env.LHB_STATE_DIR!, 'evolve-attempts'), f = join(dir, readdirSync(dir).find(n => n.endsWith('.txt'))!)
  writeFileSync(f, 'junk')
  for (let i = 0; i < 2; i++) {
    rmSync(join(cwd, 'harnesses', 'h.evolve.jsonl')); rmSync(join(cwd, 'harnesses', 'h.v1.json'), { force: true })
    const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('attempt count is unreadable')
    expect(journal(cwd)[0]).not.toHaveProperty('attempt')
    expect(readFileSync(f, 'utf8')).toBe('junk')
    expect(cli(['evolve', h, '--tasks', repo, '--report'], env, cwd).stdout).toContain('attempt unknown')
  }
}, 240_000)

test('evolve: a journal cut between a round\'s candidate lines resumes at the next, from its sweeps, with no run', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(TWO_WAYS())
  const cwd = await tmp('lhb-cwd-')
  const h = evHarness(cwd)
  expect(cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd).status).toBe(0)
  const lines = evRaw(cwd).trim().split('\n')
  const cut = lines.findIndex(l => JSON.parse(l).type === 'candidate')
  const won = journal(cwd).filter(l => l.type === 'candidate').map(c => [c.index, c.accepted, c.reason])
  writeFileSync(join(cwd, 'harnesses', 'h.evolve.jsonl'), lines.slice(0, cut + 1).join('\n') + '\n')
  // Either may win on the fake's clock; when candidate 2 did, the kept journal has no line for v1.
  if (!won[0]![1]) rmSync(join(cwd, 'harnesses', 'h.v1.json'))
  writeFileSync(env.LHB_FAKE_BACKEND, JSON.stringify(evFake().slice(1)))
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(journal(cwd).filter(l => l.type === 'candidate').map(c => [c.index, c.accepted, c.reason])).toEqual(won)
  expect(journal(cwd).filter(l => l.type === 'sweep')).toHaveLength(1)
  expect(evRaw(cwd).startsWith(lines.slice(0, cut + 1).join('\n') + '\n')).toBe(true)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: a tampered journal is refused', async () => {
  const { repo, env, cwd, h } = await evFirst()
  const lines = evRaw(cwd).trim().split('\n').map(l => JSON.parse(l))
  const acc = lines.find(l => l.type === 'candidate' && l.accepted)
  acc.edit = { field: 'tools.enabled', value: 'bash' }
  writeFileSync(join(cwd, 'harnesses', 'h.evolve.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain('cannot resume')
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: a new commit in the repo refuses to resume', async () => {
  const { repo, env, cwd, h } = await evFirst()
  await writeFile(join(repo, 'other.txt'), 'x'); await gitCommit(repo)
  const before = evRaw(cwd)
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain('the repo has a new commit since this evolve started')
  expect(evRaw(cwd)).toBe(before)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

// --- evolve: what costs a night if it goes wrong is refused before the runs it would waste.

test('evolve: a server that gives no usage stops after the original\'s runs, before any candidate', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake().map(({ usage: _, ...e }) => e))
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain(`the server gave no usage for the original's runs; evolve needs a server that reports token usage; delete ${join('harnesses', 'h.evolve.jsonl')} to start over`)
  // The probe is the first look at the usage: no proposal, no sweep.
  expect(types(cwd)).toEqual(['start', 'probe'])
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: a server that is down costs no attempt and leaves no journal', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const { LHB_FAKE_BACKEND: _, ...env } = await tasksEnv([])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes', '--base-url', 'http://127.0.0.1:1'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain('preflight:')
  for (const f of ['h.evolve.jsonl', 'h.evolve.notes.jsonl']) expect(existsSync(join(cwd, 'harnesses', f))).toBe(false)
  expect(existsSync(join(env.LHB_STATE_DIR!, 'evolve-attempts'))).toBe(false)
  expect(clonesIn(env)).toEqual([])
}, 60_000)

test('evolve: an edited harness or another --model refuses to resume', async () => {
  const { repo, env, cwd, h } = await evFirst()
  const before = evRaw(cwd)
  const m = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes', '--model', 'other'], env, cwd)
  expect(m.status).toBe(2)
  expect(m.stderr).toContain(`the harness or its options changed since this evolve started; this evolve has finished: see its results with --report and the harness and options it ran with, or move away ${join('harnesses', 'h.evolve.jsonl')} and ${join('harnesses', 'h.v*.json')} to start over`)
  writeFileSync(h, readFileSync(h, 'utf8') + '\n')
  const e = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(e.status).toBe(2)
  expect(e.stderr).toContain('the harness or its options changed since this evolve started')
  expect(evRaw(cwd)).toBe(before)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: a proposer that cannot be reached stops without a candidate line; the next evolve continues at that candidate', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const [, always, done] = evFake()
  // No entry answers the proposer: its send throws, as a refused connection would.
  const env = await tasksEnv([always, { ...done, when: 'make the file' }])
  const cwd = await tmp('lhb-cwd-')
  const h = evHarness(cwd)
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain('proposer failed: fake backend: no response for this request')
  expect(types(cwd)).toEqual(['start', 'probe'])
  expect(clonesIn(env)).toEqual([])
  const before = evRaw(cwd)
  writeFileSync(env.LHB_FAKE_BACKEND, JSON.stringify(evFake()))
  const again = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(again.status, again.stderr).toBe(0)
  expect(evRaw(cwd).startsWith(before)).toBe(true)
  expect(journal(cwd).filter(l => l.type === 'candidate').map(c => c.index)).toEqual([2, 1])
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: on resume the next version file existing or a link is refused before any run', async () => {
  const { repo, env, cwd, h } = await evFirst()
  // Without its final line the journal is unfinished: the run path, past the report.
  writeJournal(cwd, journal(cwd).filter(l => l.type !== 'final'))
  const v2 = join(cwd, 'harnesses', 'h.v2.json'), before = evRaw(cwd)
  writeFileSync(v2, '{}\n')
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain(`${join('harnesses', 'h.v2.json')} already exists`)
  rmSync(v2); symlinkSync(join(cwd, 'elsewhere.json'), v2)
  const l = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(l.status).toBe(2)
  expect(l.stderr).toContain('is a symbolic link')
  expect(evRaw(cwd)).toBe(before)
  expect(existsSync(join(cwd, 'elsewhere.json'))).toBe(false)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: started again after it finished, it measures nothing and prints the same report', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const h = evHarness(cwd)
  const first = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(first.status, first.stderr).toBe(0)
  const before = evRaw(cwd), runs = readdirSync(join(cwd, 'runs')).length
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(r.stdout).toBe(first.stdout)
  expect(evRaw(cwd)).toBe(before)
  expect(readdirSync(join(cwd, 'runs'))).toHaveLength(runs)
}, 120_000)


// --- evolve --report: the journal's report again, with nothing run; or why there is none.
test('evolve: --report prints exactly what the run printed, and runs nothing', async () => {
  const repo = await tasksRepo(evTasks({ train: 12, gate: 4, test: 8 }))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const h = evHarness(cwd)
  const first = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes', '--model', 'other'], env, cwd)
  expect(first.status, first.stderr).toBe(0)
  const before = evRaw(cwd), runs = readdirSync(join(cwd, 'runs'))
  const r = cli(['evolve', h, '--tasks', repo, '--report', '--model', 'other'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(r.stdout).toBe(first.stdout)
  expect(evRaw(cwd)).toBe(before)
  expect(readdirSync(join(cwd, 'runs'))).toEqual(runs)
  expect(r.stderr).not.toContain('mode: evolve')
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: --report needs no API key: it reads only the journal', async () => {
  const repo = await tasksRepo(evTasks({ train: 12, gate: 4, test: 8 }))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const h = evHarness(cwd), p = join(cwd, 'p.json')
  // The proposer's key too: under --report only its bytes are pinned.
  const ph = JSON.parse(readFileSync(h, 'utf8'))
  writeFileSync(p, JSON.stringify({ ...ph, backend: { ...ph.backend, kind: 'openai', apiKeyEnv: 'LHB_REPORT_API_KEY' } }))
  const flags = ['--proposer', p, '--kind', 'openai', '--api-key-env', 'LHB_REPORT_API_KEY']
  const first = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes', ...flags], { ...env, LHB_REPORT_API_KEY: 'k' }, cwd)
  expect(first.status, first.stderr).toBe(0)
  const r = cli(['evolve', h, '--tasks', repo, '--report', ...flags], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(r.stdout).toBe(first.stdout)
}, 120_000)

test('evolve: the report says when vN on disk is not the version measured', async () => {
  const { repo, env, cwd, h } = await evFirst()
  const v1 = join(cwd, 'harnesses', 'h.v1.json')
  const same = cli(['evolve', h, '--tasks', repo, '--report'], env, cwd)
  expect(same.status, same.stderr).toBe(0)
  expect(same.stdout).toContain(`Try ${join('harnesses', 'h.v1.json')} in place of h.json`)
  writeFileSync(v1, readFileSync(v1, 'utf8').replace('"name"', '"description": "x",\n  "name"'))
  const r = cli(['evolve', h, '--tasks', repo, '--report'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(r.stdout).toContain(`${join('harnesses', 'h.v1.json')} on disk is not the version measured`)
  expect(r.stdout).not.toContain(`Try ${join('harnesses', 'h.v1.json')}`)
  expect(r.stdout).not.toContain(`Use ${join('harnesses', 'h.v1.json')}`)
}, 120_000)

// After the run the report reads only the journal: what moved in the repo or the snapshot since does not hide it.
for (const [what, change] of [
  ['a new commit', async (repo: string) => { await writeFile(join(repo, 'other.txt'), 'x'); await gitCommit(repo) }],
  ['a new commit that edits lhb-tasks.json', async (repo: string) => { await writeFile(join(repo, 'lhb-tasks.json'), JSON.stringify({ tasks: evTasks({ train: 2, gate: 2, test: 2 }, 'new') })); await gitCommit(repo) }],
  ['the notes snapshot is gone', async (_: string, cwd: string) => rmSync(join(cwd, 'harnesses', 'h.evolve.notes.jsonl'))],
] as const) test(`evolve: --report prints after ${what}`, async () => {
  const { repo, env, cwd, h } = await evFirst()
  const first = cli(['evolve', h, '--tasks', repo, '--report'], env, cwd)
  expect(first.status, first.stderr).toBe(0)
  await change(repo, cwd)
  const r = cli(['evolve', h, '--tasks', repo, '--report'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(r.stdout).toBe(first.stdout)
  // A resume still refuses: its runs would mix two commits or two snapshots.
  expect(cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd).status).toBe(2)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

