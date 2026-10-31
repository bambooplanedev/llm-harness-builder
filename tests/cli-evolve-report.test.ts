import { test, expect } from 'vitest'
import { writeFile, readFile } from 'node:fs/promises'
import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { loadPolyglot } from '../src/core/polyglot.js'
import { ROOT, harnessFile as harness, cli, tmp, tasksRepo, tasksEnv, clonesIn, bashCall, TWO, ALWAYS, evFake, evHarness, evTasks, journal, ONE_EACH, TWO_WAYS, allRuns, priced, evRaw, evFirst, types, writeJournal, gitRepo, gitCommit } from './helpers.js'

test('evolve: --report when the start commit is no longer in the repo says so', async () => {
  const { repo, env, cwd, h } = await evFirst()
  const lines = journal(cwd)
  lines[0].sha = 'f'.repeat(40)
  writeFileSync(join(cwd, 'harnesses', 'h.evolve.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  const r = cli(['evolve', h, '--tasks', repo, '--report'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain(`the commit this evolve started at (fffffff) is no longer in the repo; the report cannot be shown from ${join('harnesses', 'h.evolve.jsonl')}`)
  expect(r.stdout).toBe('')
}, 120_000)

test('evolve: the start-over hint names the version files', async () => {
  const { repo, env, cwd, h } = await evFirst()
  // Unfinished: the final test is not in the journal.
  writeFileSync(join(cwd, 'harnesses', 'h.evolve.jsonl'), journal(cwd).filter(l => l.type !== 'final').map(l => JSON.stringify(l)).join('\n') + '\n')
  const m = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes', '--model', 'other'], env, cwd)
  expect(m.status).toBe(2)
  expect(m.stderr).toContain(`; delete ${join('harnesses', 'h.evolve.jsonl')} and move away ${join('harnesses', 'h.v*.json')} to start over`)
}, 120_000)

test('evolve: a finished evolve started again after a new commit points at --report, not at deleting its results', async () => {
  const { repo, env, cwd, h } = await evFirst()
  await writeFile(join(repo, 'other.txt'), 'x'); await gitCommit(repo)
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain(`the repo has a new commit since this evolve started; this evolve has finished: see its results with --report and the harness and options it ran with, or move away ${join('harnesses', 'h.evolve.jsonl')} and ${join('harnesses', 'h.v*.json')} to start over`)
  expect(r.stderr).not.toContain('delete')
}, 120_000)

test('evolve: a journal with a flipped decision is refused on resume and on --report', async () => {
  const { repo, env, cwd, h } = await evFirst()
  const lines = journal(cwd)
  const refused = lines.find(l => l.type === 'candidate' && !l.accepted)
  // The second candidate is refused before any run (field exhausted): flip it, as if it had been measured.
  Object.assign(refused, { accepted: true, reason: 'accepted', version: 2, edit: { field: 'loop.maxRepeats', value: 3 } })
  writeFileSync(join(cwd, 'harnesses', 'h.evolve.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  const r = cli(['evolve', h, '--tasks', repo, '--report'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain(`cannot resume: round 1 candidate 2: `)
  expect(r.stderr).toContain(`; the report cannot be shown from ${join('harnesses', 'h.evolve.jsonl')}`)
  const again = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(again.status).toBe(2)
  expect(again.stderr).toContain(`cannot resume: round 1 candidate 2: `)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: the run\'s stdout is the report and nothing else', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(r.stdout.startsWith('== Conclusion')).toBe(true)
  expect(r.stdout).not.toContain('proposer:')
  expect(r.stderr).toContain('proposer: ')
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve --report without a journal says so', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--report'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain(`no evolve journal at ${join('harnesses', 'h.evolve.jsonl')}`)
  expect(existsSync(join(cwd, 'harnesses'))).toBe(false)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve --report on an unfinished evolve says it has not finished', async () => {
  const { repo, env, cwd, h } = await evFirst()
  const lines = evRaw(cwd).trim().split('\n')
  expect(JSON.parse(lines[lines.length - 1]!).type).toBe('final')
  writeFileSync(join(cwd, 'harnesses', 'h.evolve.jsonl'), lines.slice(0, -1).join('\n') + '\n')
  const r = cli(['evolve', h, '--tasks', repo, '--report'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain('has not finished')
  expect(r.stdout).toBe('')
  expect(clonesIn(env)).toEqual([])
}, 120_000)

for (const [what, edit, says] of [
  ['a journal of another base', (s: any) => ({ ...s, base: 'x' }), 'written for another harness'],
  ['a stage-3 journal', ({ notes, ...s }: any) => s, 'cannot resume'],
] as const) test(`evolve --report on ${what} is refused`, async () => {
  const { repo, env, cwd, h } = await evFirst()
  const lines = evRaw(cwd).trim().split('\n')
  writeFileSync(join(cwd, 'harnesses', 'h.evolve.jsonl'), [JSON.stringify(edit(JSON.parse(lines[0]!))), ...lines.slice(1)].join('\n') + '\n')
  const r = cli(['evolve', h, '--tasks', repo, '--report'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain(says)
  // The journal is the report's only source: no advice to delete it.
  expect(r.stderr).not.toContain('delete')
  expect(r.stderr).toContain(`the report cannot be shown from ${join('harnesses', 'h.evolve.jsonl')}`)
  expect(r.stdout).toBe('')
  // The same check on a plain resume.
  const again = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(again.status).toBe(2)
  expect(again.stderr).toContain(says)
  expect(again.stderr).toContain('delete')
  expect(clonesIn(env)).toEqual([])
}, 120_000)
for (const [what, tamper] of [
  ['a rewritten notes snapshot stops the next run', (f: string) => writeFileSync(f, readFileSync(f, 'utf8') + '{"note":"x"}\n')],
  ['a deleted notes snapshot stops the next run the same way', (f: string) => rmSync(f)],
] as const) test(`evolve: ${what}`, async () => {
  const { repo, env, cwd, h } = await evFirst()
  tamper(join(cwd, 'harnesses', 'h.evolve.notes.jsonl'))
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain('the notes snapshot changed')
  expect(r.stderr).toContain(`; this evolve has finished: see its results with --report and the harness and options it ran with, or move away ${join('harnesses', 'h.evolve.jsonl')} and ${join('harnesses', 'h.v*.json')} to start over`)
  expect(journal(cwd).some(l => l.round === 2)).toBe(false)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: ./harnesses as a symbolic link is refused before anything is written', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-'), away = await tmp('lhb-away-')
  symlinkSync(away, join(cwd, 'harnesses'))
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain('harnesses is a symbolic link')
  expect(readdirSync(away)).toEqual([])
  expect(existsSync(join(cwd, 'runs'))).toBe(false)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: a proposer reply in prose is a journaled rejection, no edit in the reply', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const [p, ...rest] = evFake()
  const env = await tasksEnv([{ ...p, content: 'I would tell it to plan first.' }, ...rest])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(journal(cwd).filter(l => l.type === 'candidate').map(c => c.reason)).toEqual(['no edit in the reply', 'no edit in the reply'])
  expect(r.stdout).toContain('no version beat the original')
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: a proposer reply cut at maxTokens is a journaled rejection that says so', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const [p, ...rest] = evFake()
  const env = await tasksEnv([{ ...p, content: '{"field":"systemPrompt","value":"Plan', truncated: true }, ...rest])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(journal(cwd).filter(l => l.type === 'candidate').map(c => c.reason)).toEqual(['reply cut at maxTokens', 'reply cut at maxTokens'])
}, 120_000)

// --- evolve sweeps: arms side by side per task, every sweep one journal line. More than one sweep is --mode night: three.
const runOrder = (stderr: string) => [...stderr.matchAll(/(h\.\S+) #(\d+) (job-\S+)/g)].map(m => `${m[1]} ${m[2]} ${m[3]}`)

test('evolve: the arms interleave, per task cur, c1, c2; the test sweep orig, last; the journal has one sweep line', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(TWO_WAYS())
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(runOrder(r.stderr)).toEqual([
    'h.cur 1 job-train-0', // the probe
    'h.cur 1 job-train-0', 'h.r1c1 1 job-train-0', 'h.r1c2 1 job-train-0',
    'h.cur 1 job-gate-0', 'h.r1c1 1 job-gate-0', 'h.r1c2 1 job-gate-0',
    'h.orig 1 job-test-0', 'h.v1 1 job-test-0',
  ])
  expect(types(cwd)).toEqual(['start', 'probe', 'proposal', 'proposal', 'sweep', 'candidate', 'candidate', 'testsweep', 'final'])
  const lines = journal(cwd)
  expect(lines[0]).toMatchObject({ repeats: 1, rounds: 1 })
  expect(lines[1].runs.map((x: any) => x.task)).toEqual(['job-train-0'])
  const s = lines.find(l => l.type === 'sweep')
  expect(s).toMatchObject({ round: 1, sweep: 1 })
  expect(s.cands.map((c: any) => c.index)).toEqual([1, 2])
  for (const x of [...s.cur, ...s.cands.flatMap((c: any) => c.runs)]) expect(x.repeat).toBe(1)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: both accepted in a sweep keeps one, the other lost; the report on resume agrees', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(TWO_WAYS())
  const cwd = await tmp('lhb-cwd-')
  const h = evHarness(cwd)
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  const cs = journal(cwd).filter(l => l.type === 'candidate')
  expect(cs.filter(c => c.accepted)).toHaveLength(1)
  expect(cs.filter(c => !c.accepted).map(c => c.reason)).toEqual(['lost to the other candidate'])
  for (const c of cs) expect(c.runs).toBeUndefined()
  expect(existsSync(join(cwd, 'harnesses', 'h.v2.json'))).toBe(false)
  const rep = cli(['evolve', h, '--tasks', repo, '--report'], env, cwd)
  expect(rep.status, rep.stderr).toBe(0)
  expect(rep.stdout).toBe(r.stdout)
}, 120_000)

test('evolve: a stop after sweep 2 keeps both sweeps; on resume only sweep 3 runs, nothing is proposed again', async () => {
  const NIGHT = ['--mode', 'night']
  const { repo, env, cwd, h } = await evFirst(NIGHT)
  const lines = journal(cwd)
  rmSync(join(cwd, 'harnesses', 'h.v1.json'))
  writeJournal(cwd, lines.slice(0, lines.findLastIndex(l => l.type === 'sweep')))
  const [, a, d] = evFake()
  // A real stop first: the key goes in sweep 3's first run, and both sweeps stay.
  writeFileSync(env.LHB_FAKE_BACKEND, JSON.stringify([{ when: 'make the file', throw: { status: 402 } }, a, d]))
  const before = evRaw(cwd)
  const stopped = cli(['evolve', h, '--tasks', repo, ...NIGHT, '--yes'], env, cwd)
  expect(stopped.status, stopped.stderr).toBe(1)
  expect(stopped.stderr).toContain('the cut step\'s runs are not in the journal')
  expect(evRaw(cwd)).toBe(before)
  // No proposer reply at all: a question to it would get 'done' and be no edit.
  writeFileSync(env.LHB_FAKE_BACKEND, JSON.stringify([a, d]))
  const r = cli(['evolve', h, '--tasks', repo, ...NIGHT, '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(evRaw(cwd).startsWith(before)).toBe(true)
  expect(runOrder(r.stderr).filter(x => /^h\.(cur|r1)/.test(x))).toEqual(['h.cur 3 job-train-0', 'h.r1c1 3 job-train-0', 'h.cur 3 job-gate-0', 'h.r1c1 3 job-gate-0'])
  expect(journal(cwd).filter(l => l.type === 'sweep').map(l => l.sweep)).toEqual([1, 2, 3])
  expect(journal(cwd).filter(l => l.type === 'testsweep').map(l => l.sweep)).toEqual([1, 2, 3])
  expect(types(cwd).at(-1)).toBe('final')
  expect(journal(cwd).find(l => l.type === 'candidate' && l.index === 1)).toMatchObject({ accepted: true, version: 1 })
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: the model changing node_modules in a sweep stops it; the finished sweeps stay', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true }); writeFileSync(join(repo, 'node_modules', 'x', 'index.js'), '1')
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n'); await gitCommit(repo, 'ig')
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const h = evHarness(cwd)
  expect(cli(['evolve', h, '--tasks', repo, '--mode', 'night', '--yes'], env, cwd).status).toBe(0)
  const lines = journal(cwd)
  rmSync(join(cwd, 'harnesses', 'h.v1.json'))
  writeJournal(cwd, lines.slice(0, lines.findIndex(l => l.type === 'sweep') + 1))
  const before = evRaw(cwd)
  writeFileSync(env.LHB_FAKE_BACKEND, JSON.stringify([bashCall('rm node_modules/x/index.js'), { content: 'done' }]))
  const r = cli(['evolve', h, '--tasks', repo, '--mode', 'night', '--yes'], env, cwd)
  expect(r.status).toBe(1)
  expect(r.stderr).toContain(`the model changed the installed packages in ${join(realpathSync(repo), 'node_modules')}; stopping; a resume refuses other packages: restore them, then delete ${join('harnesses', 'h.evolve.jsonl')} and move away ${join('harnesses', 'h.v*.json')} to start over`)
  expect(evRaw(cwd)).toBe(before)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: a resume on other packages refuses and says what to do; --report and a finished evolve still print', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const pkg = join(repo, 'node_modules', 'x', 'index.js')
  mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true }); writeFileSync(pkg, '1')
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n'); await gitCommit(repo, 'ig')
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-'), h = evHarness(cwd)
  const run = () => cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(run().status).toBe(0)
  const lines = journal(cwd)
  expect(lines[0].modules).toMatch(/^[0-9a-f]{64}$/)
  writeFileSync(pkg, '22')
  expect(run().status).toBe(0) // finished: the same report, nothing runs
  expect(cli(['evolve', h, '--tasks', repo, '--report'], env, cwd).status).toBe(0)
  rmSync(join(cwd, 'harnesses', 'h.v1.json'))
  writeJournal(cwd, lines.slice(0, lines.findIndex(l => l.type === 'sweep') + 1))
  const before = evRaw(cwd), r = run()
  expect(r.status).toBe(2)
  expect(r.stderr).toContain(`the installed packages in ${join(realpathSync(repo), 'node_modules')} changed since this evolve started`)
  expect(r.stderr).toContain(`delete ${join('harnesses', 'h.evolve.jsonl')} and move away ${join('harnesses', 'h.v*.json')} to start over`)
  expect(evRaw(cwd)).toBe(before)
}, 120_000)

test('evolve: a repo with setup installs again, so a resume is exempt and the stop says to run it again; the cut money stays', async () => {
  const repo = await gitRepo({ 'lhb-tasks.json': JSON.stringify({ tasks: evTasks(ONE_EACH), setup: 'mkdir -p node_modules/x && echo 1 > node_modules/x/index.js' }) })
  const u = { usage: { promptTokens: 100, completionTokens: 10 } }
  const env = await tasksEnv([{ ...bashCall('rm node_modules/x/index.js'), ...u }, ...evFake()])
  const cwd = await tmp('lhb-cwd-'), h = evHarness(cwd)
  priced(h)
  const run = () => cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes', '--max-usd', '5'], env, cwd)
  const r = run()
  expect(r.status, r.stderr).toBe(1)
  expect(r.stderr).toContain('the model changed the installed packages in')
  expect(r.stderr).toContain('run the same command to resume: setup installs them again')
  expect(journal(cwd)[0]).not.toHaveProperty('modules')
  expect(types(cwd)).toEqual(['start', 'cut'])
  writeFileSync(env.LHB_FAKE_BACKEND, JSON.stringify(evFake()))
  const go = run()
  expect(go.status, go.stderr).toBe(0)
}, 120_000)

test('evolve: a stop during the test sweeps keeps the finished one; on resume only the next runs, nothing re-rolled', async () => {
  const { repo, env, cwd, h } = await evFirst(['--mode', 'night'])
  const lines = journal(cwd)
  writeJournal(cwd, lines.slice(0, lines.findIndex(l => l.type === 'testsweep') + 1))
  const before = evRaw(cwd)
  const [, a, d] = evFake()
  writeFileSync(env.LHB_FAKE_BACKEND, JSON.stringify([a, d]))
  const r = cli(['evolve', h, '--tasks', repo, '--mode', 'night', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(evRaw(cwd).startsWith(before)).toBe(true)
  expect(runOrder(r.stderr)).toEqual(['h.orig 2 job-test-0', 'h.v1 2 job-test-0', 'h.orig 3 job-test-0', 'h.v1 3 job-test-0'])
  expect(types(cwd).slice(-4)).toEqual(['testsweep', 'testsweep', 'testsweep', 'final'])
  const rep = cli(['evolve', h, '--tasks', repo, '--report'], env, cwd)
  expect(rep.status, rep.stderr).toBe(0)
  expect(rep.stdout).toContain('PASS 0/3')
  // Three before the cut, two after: the first run's third was rolled again.
  expect(rep.stdout).toMatch(/^test sweeps started: 5 of 3$/m)
  expect(clonesIn(env)).toEqual([])
}, 120_000)

test('evolve: a proposal refused before the runs takes no sweep slot; both refused, no sweep at all and no test sweep', async () => {
  const { cwd } = await evFirst()
  expect(journal(cwd).find(l => l.type === 'sweep').cands.map((c: any) => c.index)).toEqual([1])
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv(evFake({ value: 'see https://x.io' }))
  const cwd2 = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd2), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd2)
  expect(r.status, r.stderr).toBe(0)
  expect(types(cwd2)).toEqual(['start', 'probe', 'candidate', 'candidate', 'final'])
}, 120_000)

test('bench --tasks --yes prints the commands before saving consent', async () => {
  const repo = await tasksRepo(TWO)
  const env = await tasksEnv([{ content: 'done' }, { content: 'done' }])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['bench', '--tasks', repo, '--n', '1', '--yes', '--out', join(cwd, 'b.json'), harness('bare')], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  for (const s of ['make done.txt', "check — in each run's clone, after the run"]) expect(r.stderr).toContain(s)
}, 60_000)

// --- evolve stops on a refused key, no credits, a lasting rate limit: exit 1, no journal line for the step it cut.
const failed = (cwd: string) => journal(cwd).flatMap(allRuns).filter(x => x.reason === 'backend_error')

for (const status of [401, 402, 403])
  test(`evolve: a run that gets ${status} stops with no line for its set; run again, it completes with no FAIL from it`, async () => {
    const repo = await tasksRepo(evTasks(ONE_EACH))
    const env = await tasksEnv([{ when: 'make the file', throw: { status } }, ...evFake()])
    const cwd = await tmp('lhb-cwd-')
    const h = evHarness(cwd)
    const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
    expect(r.status, r.stderr).toBe(1)
    expect(r.stderr).toContain(String(status))
    expect(r.stderr).toContain('resume')
    expect(types(cwd)).toEqual(['start'])
    expect(clonesIn(env)).toEqual([])
    writeFileSync(env.LHB_FAKE_BACKEND, JSON.stringify(evFake()))
    const again = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
    expect(again.status, again.stderr).toBe(0)
    expect(types(cwd).at(-1)).toBe('final')
    expect(failed(cwd)).toEqual([])
  }, 120_000)

test('evolve: a stop during a candidate\'s runs leaves its proposal; run again, the same edit is measured without asking the proposer', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const [p, a, d] = evFake()
  const env = await tasksEnv([{ when: 'ALWAYS make done.txt', throw: { status: 401 } }, p, a, d])
  const cwd = await tmp('lhb-cwd-')
  const h = evHarness(cwd)
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(1)
  // Candidate 2 repeats it, refused before the runs; the sweep it stopped in left no line.
  expect(types(cwd)).toEqual(['start', 'probe', 'proposal', 'candidate'])
  const prop = journal(cwd).find(l => l.type === 'proposal')
  expect(prop).toMatchObject({ round: 1, index: 1, edit: { field: 'systemPrompt', value: ALWAYS } })
  // No proposer reply at all: a question to it would get 'done' and be no edit.
  writeFileSync(env.LHB_FAKE_BACKEND, JSON.stringify([a, d]))
  const again = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(again.status, again.stderr).toBe(0)
  const c1 = journal(cwd).find(l => l.type === 'candidate' && l.index === 1)
  expect(c1.edit).toEqual(prop.edit)
  expect(c1.input).toBe(prop.input)
  expect(journal(cwd).find(l => l.type === 'sweep').cands[0].runs).toHaveLength(2)
  expect(types(cwd)).toEqual(['start', 'probe', 'proposal', 'candidate', 'sweep', 'candidate', 'testsweep', 'final'])
}, 120_000)

test('evolve: a proposal cut in round 2 refuses --rounds 1, and --rounds 2 resumes from the journal', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  // Only round 2's proposal carries TWICE: the stop falls on its candidate's runs in the sweep.
  const [p, a, d] = evFake()
  const prop = (value: string) => ({ when: 'You improve the harness', content: JSON.stringify({ field: 'systemPrompt', value }), usage: p!.usage })
  // Round 1: the kept edit, then candidate 2 asked twice on the closed field. Round 2: the marked edit; its candidate 2 takes what is left.
  const env = await tasksEnv([prop(ALWAYS), prop(`${ALWAYS} X`), prop(`${ALWAYS} X`), prop(`${ALWAYS} TWICE`), { when: 'TWICE', throw: { status: 401 } }, { ...prop(`${ALWAYS} TWICE`), keep: true }, a, d])
  const cwd = await tmp('lhb-cwd-'), h = evHarness(cwd)
  expect(cli(['evolve', h, '--tasks', repo, '--rounds', '2', '--yes'], env, cwd).status).toBe(1)
  expect(journal(cwd).some(l => l.type === 'proposal' && l.round === 2)).toBe(true)
  const before = evRaw(cwd)
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain('this journal ran --rounds 2; run the same command with it')
  expect(evRaw(cwd)).toBe(before)
  writeFileSync(env.LHB_FAKE_BACKEND, JSON.stringify([a, d]))
  const again = cli(['evolve', h, '--tasks', repo, '--rounds', '2', '--yes'], env, cwd)
  expect(again.status, again.stderr).toBe(0)
  expect(evRaw(cwd).startsWith(before)).toBe(true)
  expect(types(cwd).at(-1)).toBe('final')
}, 120_000)

test('evolve: a hand-written proposal past the pinned rounds refuses, cut in that round', async () => {
  const { repo, env, cwd, h } = await evFirst()
  const jf = join(cwd, 'harnesses', 'h.evolve.jsonl')
  writeFileSync(jf, evRaw(cwd) + JSON.stringify({ v: 2, type: 'proposal', round: 2, index: 1, input: '{}', edit: { field: 'loop.maxRepeats', value: 3 } }) + '\n')
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain("ends on round 2's candidate 1, cut in that round, past the 1 of this evolve")
}, 120_000)

test('evolve: a proposer that gets 429 four times stops with no candidate line', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv([{ when: 'You improve the harness', keep: true, throw: { status: 429 } }, ...evFake().slice(1)])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], { ...env, LHB_RETRY_MS: '10' }, cwd)
  expect(r.status, r.stderr).toBe(1)
  expect(r.stderr).toContain('429')
  expect(r.stderr).toContain('proposer')
  expect(r.stderr).toContain('resume')
  expect(types(cwd)).toEqual(['start', 'probe'])
}, 120_000)

for (const [who, when] of [['harness', 'make the file'], ['proposer', 'You improve the harness']])
  test(`evolve: a ${who} 429 after deltas streamed stops at once and says so, not "after 3 retries"`, async () => {
    const repo = await tasksRepo(evTasks(ONE_EACH))
    const env = await tasksEnv([{ when, deltas: [{ content: 'half' }], throw: { status: 429 } }, ...evFake()])
    const cwd = await tmp('lhb-cwd-')
    const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], { ...env, LHB_RETRY_MS: '10' }, cwd)
    expect(r.status, r.stderr).toBe(1)
    expect(r.stderr).toContain(who)
    expect(r.stderr).toContain('429 mid-reply, not retried')
    expect(r.stderr).not.toContain('after 3 retries')
  }, 120_000)

test('evolve: a proposer 429 that clears on retry goes on as if nothing happened', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv([{ when: 'You improve the harness', throw: { status: 429 } }, ...evFake()])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], { ...env, LHB_RETRY_MS: '10' }, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(journal(cwd).filter(l => l.type === 'candidate').map(c => c.index)).toEqual([2, 1])
}, 120_000)

test('evolve: a moderated 403 is a FAIL and the evolve goes on', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv([{ when: 'make the file', throw: { status: 403, moderated: true } }, ...evFake()])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(failed(cwd)).toHaveLength(1)
  expect(types(cwd).at(-1)).toBe('final')
}, 120_000)

test('evolve: "429" in a prompt or a final answer is no stop', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH).map(t => ({ ...t, prompt: 'make the file; POST /chat/completions: 429' })))
  const [p, a, d] = evFake()
  const env = await tasksEnv([p, a, { ...d, content: 'POST /chat/completions: 429' }])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(types(cwd).at(-1)).toBe('final')
}, 120_000)

test('bench --tasks: a 401 run is a FAIL backend_error with stop 401, its check not run, and the bench goes on', async () => {
  const marker = join(await tmp('lhb-mark-'), 'checked')
  const repo = await tasksRepo([{ name: 'a', prompt: 'p', check: `touch "${marker}"` }, { name: 'b', prompt: 'p', check: 'true' }])
  const env = await tasksEnv([{ throw: { status: 401 } }, { content: 'done' }])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['bench', '--tasks', repo, '--n', '1', '--yes', '--out', join(cwd, 'b.json'), harness('bare')], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  const runs = JSON.parse(await readFile(join(cwd, 'b.json'), 'utf8')).harnesses[0].runs
  expect(runs[0]).toMatchObject({ task: 'a', verdict: 'FAIL', reason: 'backend_error', stop: 401 })
  expect(existsSync(marker)).toBe(false)
  expect(runs[1]).toMatchObject({ task: 'b', verdict: 'PASS' })
  expect(runs[1]).not.toHaveProperty('stop')
}, 60_000)

test('evolve: a moderated 403 on the proposer stays a die, not a stop', async () => {
  const repo = await tasksRepo(evTasks(ONE_EACH))
  const env = await tasksEnv([{ when: 'You improve the harness', throw: { status: 403, moderated: true, message: 'flagged' } }, ...evFake()])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status).toBe(2)
  expect(r.stderr).toContain('proposer failed: flagged')
  expect(types(cwd)).toEqual(['start', 'probe'])
}, 120_000)

test('evolve: short repo task names do not bind the words of an accepted paragraph; --report prints it', async () => {
  // ALWAYS holds "make" and "you": as task names under 6 chars they are no binding words in a repo.
  const repo = await tasksRepo([['make', 'train'], ['you', 'gate'], ['zq', 'test']].map(([name, set]) => ({ name, prompt: 'make the file', check: 'test -f done.txt', set })))
  const env = await tasksEnv(evFake())
  const cwd = await tmp('lhb-cwd-')
  const h = evHarness(cwd)
  const r = cli(['evolve', h, '--tasks', repo, '--rounds', '1', '--yes'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(journal(cwd).find(l => l.type === 'candidate' && l.index === 1)).toMatchObject({ accepted: true })
  const rep = cli(['evolve', h, '--tasks', repo, '--report'], env, cwd)
  expect(rep.status, rep.stderr).toBe(0)
  expect(rep.stdout).toBe(r.stdout)
}, 120_000)

// --- evolve --task polyglot: the Exercism set as practice ground. One real evolve (6 checks); the rest stops before any run.
const PROOF_PARA = 'ALWAYS finish the solution before you answer.'
const polyFake = () => [
  { when: 'You improve the harness', keep: true, content: JSON.stringify({ field: 'systemPrompt', value: PROOF_PARA }), usage: { promptTokens: 50, completionTokens: 5 } },
  { when: PROOF_PARA, keep: true, ...bashCall(`for f in *.test.js; do n="\${f%.test.js}"; cp "${join(ROOT, 'polyglot-proofs')}/$n.js" "$n.js"; done`), usage: { promptTokens: 100, completionTokens: 10 } },
  { keep: true, content: 'done', usage: { promptTokens: 100, completionTokens: 10 } },
]
const polyArgs = (h: string, size = '3') => ['evolve', h, '--task', 'polyglot', '--size', size]

test('evolve --task polyglot --size 3 --rounds 1: end to end, the report again, a changed set, nothing left in tmp', async () => {
  const env = await tasksEnv(polyFake())
  const cwd = await tmp('lhb-cwd-')
  const h = evHarness(cwd)
  const r = cli([...polyArgs(h), '--rounds', '1'], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  const lines = journal(cwd)
  const ex = loadPolyglot().exercises.slice(0, 3)
  expect(lines[0]).toMatchObject({ type: 'start', declarable: false, sets: { train: [ex[0].name], gate: [ex[1].name], test: [ex[2].name] } })
  expect(lines[0].sha).toMatch(/^polyglot:[0-9a-f]{64}:3$/)
  expect(lines.filter(l => l.type === 'candidate').map(l => [l.accepted, l.reason])).toEqual([[false, 'field exhausted'], [true, 'accepted']])
  expect(r.stdout).toContain('\u041e\u0420\u0406\u0404\u041d\u0422\u0418\u0420, \u041d\u0415 \u0414\u041e\u041a\u0410\u0417')
  expect(r.stdout).toContain('--mode night or days declares a winner')
  expect(r.stdout).toContain('more PASS')
  expect(r.stdout).toContain(`bench ${join('harnesses', 'h.v1.json')} --task polyglot --size 3`)
  // What the proposer was sent: no exercise name, test name or file of the set.
  const inputs = lines.filter(l => l.type === 'candidate' || l.type === 'proposal').map(l => l.input as string)
  expect(inputs.length).toBeGreaterThan(0)
  for (const i of inputs) for (const s of [...ex.flatMap(e => [e.name, ...e.tests]), 'examples-polyglot', '.js', 'INSTRUCTIONS']) expect(i).not.toContain(s)
  for (const f of lines.flatMap(allRuns).filter(x => x.verdict === 'FAIL')) expect(f.sig).toMatch(/^[^|]+\|test\|/)
  expect(readdirSync(env.TMPDIR).filter(f => f.startsWith('lhb-polyglot-'))).toEqual([])
  // --report prints the same report, with nothing run, the size read from the start line.
  const rep = cli(['evolve', h, '--task', 'polyglot', '--report'], env, cwd)
  expect(rep.status, rep.stderr).toBe(0)
  expect(rep.stdout).toBe(r.stdout)
  // The set changed since (another fingerprint): a resume is refused, the report still prints.
  const jf = join(cwd, 'harnesses', 'h.evolve.jsonl'), text = readFileSync(jf, 'utf8')
  writeFileSync(jf, text.replace(lines[0].sha, `polyglot:${'0'.repeat(64)}:3`))
  const again = cli([...polyArgs(h), '--rounds', '1', '--yes'], env, cwd)
  expect(again.status).not.toBe(0)
  expect(again.stderr).toContain('the exercise set or --size changed since this evolve started; this evolve has finished: see its results with --report')
  expect(cli([...polyArgs(h), '--report'], env, cwd).stdout).toBe(r.stdout)
  // An exercise the set no longer has: the report reads its name from the journal.
  writeFileSync(jf, text.replaceAll(`"${ex[0].name}"`, '"gone-exercise"'))
  const gone = cli([...polyArgs(h), '--report'], env, cwd)
  expect(gone.status, gone.stderr).toBe(0)
  expect(gone.stdout).toContain('== Conclusion')
}, 180_000)

test('evolve --task polyglot --mode night starts declarable; a proposer on the harness\'s host is said, not asked', async () => {
  const env = await tasksEnv([{ throw: { status: 401 } }])
  const cwd = await tmp('lhb-cwd-')
  // A refused key stops it after the start line, on its first run.
  const r = cli(['evolve', evHarness(cwd), '--task', 'polyglot', '--mode', 'night', '--base-url', 'http://127.0.0.1:1'], env, cwd)
  expect(r.status).toBe(1)
  expect(journal(cwd)[0]).toMatchObject({ type: 'start', declarable: true })
  expect(r.stderr).toContain('proposer: 127.0.0.1:1, the harness\'s own server')
  expect(r.stderr).not.toContain('pass --yes')
}, 60_000)

test('evolve --task polyglot --mode night: size 47, 394 runs before any run; hours: size 24, not declarable', async () => {
  const env = await tasksEnv([{ throw: { status: 401 } }])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['evolve', evHarness(cwd), '--task', 'polyglot', '--mode', 'night', '--base-url', 'http://127.0.0.1:1'], env, cwd)
  expect(r.status).toBe(1)
  expect(r.stderr).toContain('mode night: up to 394 runs: 16 probe, 288 sweeps, 90 test')
  expect(journal(cwd)[0]).toMatchObject({ type: 'start', mode: 'night', repeats: 3, rounds: 1, declarable: true })
  expect(journal(cwd)[0].sha).toMatch(/:47$/)
  const cwd2 = await tmp('lhb-cwd-')
  const h = cli(['evolve', evHarness(cwd2), '--task', 'polyglot', '--mode', 'hours', '--base-url', 'http://127.0.0.1:1'], env, cwd2)
  expect(h.stderr).toContain('mode hours: up to 72 runs: 8 probe, 48 sweeps, 16 test')
  expect(journal(cwd2)[0]).toMatchObject({ mode: 'hours', declarable: false })
  expect(journal(cwd2)[0].sha).toMatch(/:24$/)
}, 60_000)

test('evolve --task polyglot: a proposer on another host is asked; --yes accepts it once', async () => {
  const { LHB_FAKE_BACKEND: _, ...env } = await tasksEnv([])
  const cwd = await tmp('lhb-cwd-')
  const h = evHarness(cwd), p = join(cwd, 'p.json')
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(h, 'utf8')), name: 'p', backend: { ...JSON.parse(readFileSync(h, 'utf8')).backend, baseUrl: 'http://127.0.0.1:2' } }))
  const args = [...polyArgs(h), '--proposer', p, '--base-url', 'http://127.0.0.1:1']
  const no = cli(args, env, cwd)
  expect(no.status).toBe(2)
  for (const s of ['proposer: 127.0.0.1:2', 'fields: systemPrompt', 'how the runs failed', 'pass --yes to send these to this proposer']) expect(no.stderr).toContain(s)
  expect(no.stderr).toMatch(/^run limit: mode \w+, up to \d+ runs$/m)
  expect(no.stderr).not.toContain('accept these commands')
  expect(existsSync(join(cwd, 'harnesses', 'h.evolve.jsonl'))).toBe(false)
  const yes = cli([...args, '--yes'], env, cwd)
  expect(yes.stderr).toContain('proposer: 127.0.0.1:2')
  expect(yes.stderr).toContain('preflight: http://127.0.0.1:1')
  expect(existsSync(join(cwd, 'harnesses', 'h.evolve.jsonl'))).toBe(false)
  const later = cli(args, env, cwd)
  expect(later.stderr).not.toContain('pass --yes')
}, 60_000)

