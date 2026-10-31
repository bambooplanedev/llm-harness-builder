import { test, expect } from 'vitest'
import { writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { harnessFile as harness, cli, tmp, tasksRepo, tasksEnv, clonesIn, ALWAYS, evFake, evHarness, evTasks, journal, ONE_EACH, allRuns, evRaw, evFirst, writeJournal } from './helpers.js'
import { SIG } from '../src/core/evolve.js'

test('evolve: a candidate that turns the fake to PASS is accepted, v1 written, original byte for byte', async () => {
  const repo = await tasksRepo(evTasks({ train: 12, gate: 4, test: 8 }))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const h = evHarness(cwd), before = readFileSync(h)
  const r = cli(['evolve', h, '--tasks', repo, '--mode', 'night', '--yes', '--model', 'other'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  const lines = journal(cwd)
  const cands = lines.filter(l => l.type === 'candidate')
  // Candidate 2 is refused before the runs, so its line comes first.
  expect(cands.map(c => [c.index, c.accepted, c.reason])).toEqual([[2, false, 'field exhausted'], [1, true, 'accepted']])
  const v1 = JSON.parse(readFileSync(join(cwd, 'harnesses', 'h.v1.json'), 'utf8'))
  expect(v1.name).toBe('h.v1')
  expect(v1.systemPrompt).toContain(ALWAYS)
  expect(v1.backend.model).toBe(JSON.parse(before.toString()).backend.model)
  expect(readFileSync(h).equals(before)).toBe(true)
  expect(r.stdout).toContain('better on the tasks of this repo Evolve did not see')
  expect(r.stdout).toContain(ALWAYS)
  expect(clonesIn(env)).toEqual([])
}, 240_000)

test('evolve: every FAIL run in the journal has a sig and the journal ends with the final test', async () => {
  const repo = await tasksRepo(evTasks({ train: 12, gate: 4, test: 8 }))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes', '--model', 'other'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  const lines = journal(cwd)
  const fails = lines.flatMap(allRuns).filter(x => x.verdict === 'FAIL')
  expect(fails.length).toBeGreaterThan(0)
  for (const f of fails) expect(f.sig).toMatch(SIG)
  expect(lines[lines.length - 1]).toMatchObject({ type: 'final', version: 1 })
  expect(lines.find(l => l.type === 'testsweep').orig).toHaveLength(8)
}, 120_000)

test('evolve: the proposer\'s request has no repo path or task name', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH, 'quartz'), { 'src/widget_parser.ts': 'export {}\n' })
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  const inputs = journal(cwd).filter(l => l.type === 'candidate').map(l => l.input)
  expect(inputs).toHaveLength(2)
  expect(journal(cwd).find(l => l.type === 'proposal')).toBeTruthy()
  for (const i of inputs) for (const s of ['quartz', 'widget_parser', 'lhb-tasks', 'src/', realpathSync(repo)]) expect(i).not.toContain(s)
  expect(JSON.parse(inputs[0]).failures[0]).toMatchObject({ count: 1, calls: {} })
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: reference mode on 1+1+1 says \u041e\u0420\u0406\u0404\u041d\u0422\u0418\u0420 in the output and the journal start line is not declarable', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(r.stdout + r.stderr).toContain('\u041e\u0420\u0406\u0404\u041d\u0422\u0418\u0420, \u041d\u0415 \u0414\u041e\u041a\u0410\u0417')
  expect(r.stdout).toContain('more PASS')
  expect(journal(cwd)[0]).toMatchObject({ type: 'start', declarable: false, mode: 'custom' })
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve --mode: neither a mode nor flags refuses, naming the three; a mode with --size or --rounds refuses; an unknown mode refuses', () => {
  const bad = (args: string[], re: RegExp) => { const r = cli(['evolve', harness('bare'), ...args]); expect(r.status).toBe(2); expect(r.stderr).toMatch(re) }
  bad(['--tasks', 'x'], /^error: evolve needs --mode hours, night or days/m)
  bad(['--task', 'polyglot'], /^error: evolve needs --mode hours, night or days/m)
  bad(['--tasks', 'x', '--mode', 'night', '--rounds', '1'], /^error: --mode cannot go with --size or --rounds$/m)
  bad(['--task', 'polyglot', '--mode', 'hours', '--size', '6'], /^error: --mode cannot go with --size or --rounds$/m)
  bad(['--tasks', 'x', '--mode', 'custom'], /^error: --mode must be hours, night or days$/m)
}, 60_000)

test('evolve --mode hours: enough tasks, more PASS on test, and still a pointer: never Use vN', async () => {
  const repo = await tasksRepo(evTasks({ train: 12, gate: 4, test: 8 }))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--mode', 'hours', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(journal(cwd)[0]).toMatchObject({ type: 'start', mode: 'hours', repeats: 1, rounds: 1, declarable: false })
  expect(r.stdout).toContain('\u041e\u0420\u0406\u0404\u041d\u0422\u0418\u0420, \u041d\u0415 \u0414\u041e\u041a\u0410\u0417 — --mode hours is orientation only')
  expect(r.stdout).toContain('--mode night or days declares a winner')
  expect(r.stdout).not.toContain(`Use ${join('harnesses', 'h.v1.json')}`)
  expect(r.stdout).toContain(`Try ${join('harnesses', 'h.v1.json')}`)
}, 240_000)

test('evolve --mode night on too few tasks: it runs three repeats, labels orientation, says why; another mode refuses the resume', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-'), h = evHarness(cwd)
  const r = cli(['evolve', h, '--tasks', repo, '--mode', 'night', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(r.stderr).toContain('mode night: up to 25 runs: 1 probe, 18 sweeps, 6 test')
  expect(journal(cwd)[0]).toMatchObject({ type: 'start', mode: 'night', repeats: 3, rounds: 1, declarable: false })
  expect(journal(cwd).filter(l => l.type === 'sweep')).toHaveLength(3)
  expect(r.stdout).toContain('too few tasks (3 of 24) for a statistical conclusion; add 21 more tasks')
  expect(r.stdout).not.toContain('orientation only')
  expect(r.stdout).not.toContain('Use ')
  const before = evRaw(cwd)
  const d = cli(['evolve', h, '--tasks', repo, '--mode', 'days', '--yes'], env, cwd)
  expect(d.status).toBe(2)
  expect(d.stderr).toContain('this journal ran --mode night; run the same command with it')
  expect(evRaw(cwd)).toBe(before)
  // The same command prints the journal's report: repeats and rounds came from its start line.
  const same = cli(['evolve', h, '--tasks', repo, '--mode', 'night', '--yes'], env, cwd)
  expect(same.status, same.stderr).toBe(0)
  expect(same.stdout).toBe(r.stdout)
  // Nothing runs, so no run count.
  expect(same.stderr).not.toContain('up to 25 runs')
  // --report needs neither a mode nor flags.
  expect(cli(['evolve', h, '--tasks', repo, '--report'], env, cwd).stdout).toBe(r.stdout)
}, 120_000)

test('evolve --mode: after the probe, what the rest costs and the smallest gain; money only with a price, an upper bound at one repeat', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(r.stderr).toMatch(/^mode custom: up to 9 runs: 1 probe, 6 sweeps, 2 test$/m)
  // A probe of all FAIL has no variance; the gate's own flips are the floor in every mode.
  expect(r.stderr).toMatch(/^estimate: up to 8 more runs, about \d+\.\d h; the smallest gain told from noise: at most \+5 tasks of 2 \(upper bound at 1 repeat\)$/m)
  const cwd2 = await tmp('lhb-cwd-'), h = evHarness(cwd2), c = JSON.parse(readFileSync(h, 'utf8'))
  writeFileSync(h, JSON.stringify({ ...c, backend: { ...c.backend, pricePerMTok: { input: 1, output: 2 } } }))
  const p = cli(['evolve', h, '--tasks', repo, '--mode', 'night', '--yes', '--max-usd', '5'], env, cwd2)
  expect(p.status, p.stderr).toBe(0)
  expect(p.stderr).toMatch(/^estimate: up to 24 more runs, about \d+\.\d h, about \$0\.\d\d; the smallest gain told from noise: \+\d+ tasks of 2$/m)
}, 120_000)

test('evolve: a resume with no flags or the wrong ones is told how the journal ran, never to delete it', async () => {
  const { repo, env, cwd, h } = await evFirst(['--mode', 'night'])
  writeJournal(cwd, journal(cwd).filter(l => l.type !== 'final'))
  const before = evRaw(cwd)
  for (const flags of [[], ['--mode', 'days'], ['--rounds', '1']]) {
    const r = cli(['evolve', h, '--tasks', repo, ...flags, '--yes'], env, cwd)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('this journal ran --mode night; run the same command with it')
    expect(r.stderr).not.toContain('delete')
  }
  expect(evRaw(cwd)).toBe(before)
  // A corrupt journal keeps its own error, flags or none.
  writeFileSync(join(cwd, 'harnesses', 'h.evolve.jsonl'), 'nope\n')
  const c = cli(['evolve', h, '--tasks', repo, '--yes'], env, cwd)
  expect(c.status).toBe(2)
  expect(c.stderr).toContain('line 1: not JSON')
  // So does a journal with no start line.
  writeFileSync(join(cwd, 'harnesses', 'h.evolve.jsonl'), '')
  expect(cli(['evolve', h, '--tasks', repo, '--yes'], env, cwd).stderr).toContain('does not begin with a start line')
}, 120_000)

test('evolve --task polyglot: a stopped custom journal names its --size and --rounds', async () => {
  const { LHB_FAKE_BACKEND: _, ...env } = await tasksEnv([])
  const cwd = await tmp('lhb-cwd-'), h = evHarness(cwd), url = ['--base-url', 'http://127.0.0.1:1'], fake = join(cwd, 'fake.json')
  // Stopped by the key before its first run: the journal holds its start line alone.
  writeFileSync(fake, JSON.stringify([{ throw: { status: 401 } }]))
  expect(cli(['evolve', h, '--task', 'polyglot', '--size', '3', '--rounds', '2'], { ...env, LHB_FAKE_BACKEND: fake }, cwd).status).toBe(1)
  for (const flags of [[], ['--mode', 'night'], ['--size', '6', '--rounds', '2']]) {
    const r = cli(['evolve', h, '--task', 'polyglot', ...flags, ...url], env, cwd)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('this journal ran --size 3 --rounds 2; run the same command with it')
  }
}, 60_000)

for (const [what, edit] of [['mode', { mode: 'days' }], ['repeats', { repeats: 2 }], ['rounds', { rounds: 2 }]] as const)
  test(`evolve: a start line with its ${what} edited by hand is refused, on a run and under --report`, async () => {
    const { repo, env, cwd, h } = await evFirst(['--mode', 'night'])
    const lines = journal(cwd)
    writeJournal(cwd, [{ ...lines[0], ...edit }, ...lines.slice(1)])
    const before = evRaw(cwd)
    const run = cli(['evolve', h, '--tasks', repo, '--mode', 'night', '--yes'], env, cwd)
    expect(run.status).toBe(2)
    expect(run.stderr).toMatch(what === 'mode' ? /this journal ran --mode days/ : /the harness or its options changed since this evolve started/)
    const rep = cli(['evolve', h, '--tasks', repo, '--report'], env, cwd)
    expect(rep.status).toBe(2)
    expect(rep.stderr).toContain('the harness or its options changed since this evolve started')
    expect(rep.stdout).toBe('')
    expect(evRaw(cwd)).toBe(before)
  }, 120_000)

test('evolve --rounds 6 on a finished journal refuses and names how it ran: rounds are pinned', async () => {
  const { repo, env, cwd, h } = await evFirst()
  const before = evRaw(cwd)
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '6', '--yes'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain('this journal ran --rounds 1; run the same command with it')
  expect(evRaw(cwd)).toBe(before)
}, 120_000)

