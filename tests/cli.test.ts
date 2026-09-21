import { test, expect } from 'vitest'
import { spawn, spawnSync, execSync } from 'node:child_process'
import { writeFile, readFile, readdir, stat, cp } from 'node:fs/promises'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tmp } from './helpers.js'
import { RunStore } from '../src/server/runs'

const ROOT = process.cwd()
const harness = (name: string) => join(ROOT, 'harnesses', `${name}.json`)
// Fresh cwd per spawn: the CLI writes runs/ into cwd, which must not be the repo. tsx by absolute path: npx from a tmp cwd does not resolve it.
const cli = (args: string[], env: Record<string, string> = {}, cwd = mkdtempSync(join(tmpdir(), 'lhb-cwd-'))) =>
  Object.assign(spawnSync(join(ROOT, 'node_modules', '.bin', 'tsx'), [join(ROOT, 'src', 'cli.ts'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } }), { cwd })

test('run --json prints jsonl and exits 0 on final', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json')
  // a large final response makes truncation observable if the process exits before stdout drains
  await writeFile(fake, JSON.stringify([{ toolCalls: [{ name: 'bash', args: { command: 'echo hi' } }] }, { content: 'x'.repeat(200_000) }]))
  const r = cli(['run', harness('bare'), '--workdir', wd, '--yes', '--json', 'say hi'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  const lines = r.stdout.trim().split('\n').map(l => JSON.parse(l))
  const last = lines.at(-1)
  expect(last).toMatchObject({ type: 'done', reason: 'final' })
  expect(last.text).toHaveLength(200_000)
  expect(r.stderr).toContain('tool_call')
  // the trace: same events as stdout, behind a meta line, in cwd/runs, no .part left behind
  const files = await readdir(join(r.cwd, 'runs'))
  expect(files).toHaveLength(1); expect(files[0]).toMatch(/^[0-9a-f]{8}\.jsonl$/)
  expect(r.stderr).toContain(`trace runs/${files[0]}`)
  const [meta, ...events] = (await readFile(join(r.cwd, 'runs', files[0]), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
  expect(meta.meta).toMatchObject({ id: files[0].slice(0, 8), harness: 'bare', task: 'say hi', workdir: wd })
  expect(typeof meta.meta.started).toBe('number'); expect('bench' in meta.meta).toBe(false)
  expect(events).toEqual(lines)
}, 30_000)

test('run exits 1 on parse_failed', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json')
  await writeFile(fake, JSON.stringify([{ content: '' }, { content: '' }]))
  const r = cli(['run', harness('bare'), '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(1)
}, 30_000)

test('demo prints PASS/FAIL per harness', async () => {
  const fake = join(await tmp('lhb-cli-'), 'fake.json')
  // bare: model answers without doing anything -> check.sh fails. tuned: fixes the bug via edit_file.
  await writeFile(fake, JSON.stringify([
    { content: 'Done.' },
    { content: '{"calls":[{"name":"edit_file","args":{"path":"src/slugify.js","old":"replace(/[^a-z0-9]+/g, \'-\')","new":"replace(/[^a-z0-9]+/g, \'-\').replace(/^-+|-+$/g, \'\')"}}],"final":null}' },
    { content: '{"calls":[],"final":"Fixed."}' },
    { content: '<tool_call>\n{"name":"edit_file","arguments":{"path":"src/slugify.js","old":"replace(/[^a-z0-9]+/g, \'-\')","new":"replace(/[^a-z0-9]+/g, \'-\').replace(/^-+|-+$/g, \'\')"}}\n</tool_call>' },
    { content: 'Fixed.' },
  ]))
  const r = cli(['demo'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  expect(r.stdout).toMatch(/bare\s+FAIL/)
  expect(r.stdout).toMatch(/tuned\s+PASS/)
  expect(r.stdout).toMatch(/tuned-hermes\s+PASS/)
}, 60_000)

test('demo --json keeps stdout pure JSONL and prints the summary on stderr', async () => {
  const fake = join(await tmp('lhb-cli-'), 'fake.json')
  await writeFile(fake, JSON.stringify([
    { content: 'Done.' },
    { content: '{"calls":[{"name":"edit_file","args":{"path":"src/slugify.js","old":"replace(/[^a-z0-9]+/g, \'-\')","new":"replace(/[^a-z0-9]+/g, \'-\').replace(/^-+|-+$/g, \'\')"}}],"final":null}' },
    { content: '{"calls":[],"final":"Fixed."}' },
    { content: '<tool_call>\n{"name":"edit_file","arguments":{"path":"src/slugify.js","old":"replace(/[^a-z0-9]+/g, \'-\')","new":"replace(/[^a-z0-9]+/g, \'-\').replace(/^-+|-+$/g, \'\')"}}\n</tool_call>' },
    { content: 'Fixed.' },
  ]))
  const r = cli(['demo', '--json'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  const lines = r.stdout.trim().split('\n')
  for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
  expect(r.stdout).not.toMatch(/PASS|FAIL/)
  expect(r.stderr).toMatch(/bare\s+FAIL/)
  expect(r.stderr).toMatch(/tuned\s+PASS/)
  expect(r.stderr).toMatch(/tuned-hermes\s+PASS/)
}, 60_000)

test('run flags a final answer with zero tool calls', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json')
  await writeFile(fake, JSON.stringify([{ content: 'Let me look at that first.' }]))
  const r = cli(['run', harness('tuned-hermes'), '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  expect(r.stderr).toMatch(/! final after 0 tool calls/)
}, 30_000)

test('run dies with a clear message when the harness has no backend object and an override is given', async () => {
  const wd = await tmp('lhb-cli-')
  const bad = join(wd, 'bad.json')
  await writeFile(bad, JSON.stringify({ name: 'bad' }))
  const r = cli(['run', bad, '--workdir', wd, '--yes', '--model', 'x', 'task'])
  expect(r.status).toBe(2)
  expect(r.stderr).toMatch(/invalid harness .*backend must be an object/s)
}, 30_000)

const TUNED_EDIT = '{"calls":[{"name":"edit_file","args":{"path":"src/slugify.js","old":"replace(/[^a-z0-9]+/g, \'-\')","new":"replace(/[^a-z0-9]+/g, \'-\').replace(/^-+|-+$/g, \'\')"}}],"final":null}'
const TUNED_FINAL = '{"calls":[],"final":"Fixed."}'
const HERMES_EDIT = '<tool_call>\n{"name":"edit_file","arguments":{"path":"src/slugify.js","old":"replace(/[^a-z0-9]+/g, \'-\')","new":"replace(/[^a-z0-9]+/g, \'-\').replace(/^-+|-+$/g, \'\')"}}\n</tool_call>'

test('bench --n 2 on one harness: table, JSON with per-run reason/parseErrors/workdir', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json'); const out = join(wd, 'b.json')
  // run 1: edit → final. run 2: garbage (parse_error, retried) → edit → final.
  await writeFile(fake, JSON.stringify([{ content: TUNED_EDIT }, { content: TUNED_FINAL }, { content: 'not json' }, { content: TUNED_EDIT }, { content: TUNED_FINAL }]))
  const r = cli(['bench', '--n', '2', '--out', out, harness('tuned')], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  expect(r.stdout).toMatch(/^tuned\s+2\/2\s+final×2\s/m)
  expect(r.stderr).toMatch(/--- round 2\/2/)
  const j = JSON.parse(await readFile(out, 'utf8'))
  expect(j).toMatchObject({ version: 1, n: 2, timeoutS: 1800, complete: true })
  // the JSON is written via a tmp file + rename, so a Ctrl-C mid-write can never truncate it; no tmp is left behind
  expect((await readdir(wd)).filter(f => f.endsWith('.tmp'))).toEqual([])
  const h = j.harnesses[0]
  expect(h.name).toBe('tuned'); expect(h.config.name).toBe('tuned'); expect(h.pass).toBe(2); expect(h.reasons).toEqual({ final: 2 })
  expect(h.runs.map((x: any) => [x.round, x.verdict, x.reason, x.parseErrors])).toEqual([[1, 'PASS', 'final', 0], [2, 'PASS', 'final', 1]])
  expect(typeof h.runs[1].lastError).toBe('string'); expect(h.runs[1].lastError.length).toBeGreaterThan(0)
  expect(h.runs[0].lastError).toBeUndefined()
  for (const x of h.runs) { expect(x.ms).toBeGreaterThanOrEqual(0); expect((await stat(x.workdir)).isDirectory()).toBe(true) }
  // each run has a trace in cwd/runs that the UI's store reads like its own, and the meta points back at the bench
  expect(r.stderr).toMatch(/trace=[0-9a-f]{8}/)
  for (const x of h.runs) {
    expect(x.trace).toMatch(/^[0-9a-f]{8}$/)
    const first = JSON.parse((await readFile(join(r.cwd, 'runs', `${x.trace}.jsonl`), 'utf8')).split('\n')[0])
    expect(first.meta.bench).toEqual({ file: 'b.json', round: x.round })
  }
  const listed = await new RunStore(join(r.cwd, 'runs')).list()
  expect(listed.map(s => [s.id, s.harness, s.reason]).sort()).toEqual(h.runs.map((x: any) => [x.trace, 'tuned', 'final']).sort())
}, 60_000)

test('bench without files uses ./harnesses in demo order, round-robin', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json'); const out = join(wd, 'b.json')
  await cp(join(ROOT, 'harnesses'), join(wd, 'harnesses'), { recursive: true })
  await writeFile(fake, JSON.stringify([{ content: 'Done.' }, { content: TUNED_EDIT }, { content: TUNED_FINAL }, { content: HERMES_EDIT }, { content: 'Fixed.' }]))
  const r = cli(['bench', '--n', '1', '--out', out], { LHB_FAKE_BACKEND: fake }, wd)
  expect(r.status).toBe(0)
  expect(r.stdout).toMatch(/^bare\s+0\/1\s/m)
  expect(r.stdout).toMatch(/^tuned\s+1\/1\s/m)
  expect(r.stdout).toMatch(/^tuned-hermes\s+1\/1\s/m)
  expect(r.stderr).toMatch(/--- round 1\/1/)
  expect(r.stderr).toContain(join(wd, 'harnesses', 'bare.json'))
  const j = JSON.parse(await readFile(out, 'utf8'))
  expect(j.harnesses.map((h: any) => h.name)).toEqual(['bare', 'tuned', 'tuned-hermes'])
  expect(j.harnesses.flatMap((h: any) => h.runs.map((x: any) => x.reason))).toEqual(['final', 'final', 'final'])
}, 90_000)

test('bench rejects non-positive-integer --n and --timeout with usage', () => {
  for (const args of [['bench', '--n', '0'], ['bench', '--n', '2.5'], ['bench', '--n', '1', '--timeout', 'x']]) {
    const r = cli(args)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/usage/)
  }
}, 30_000)

test('Ctrl-C during run keeps the trace instead of an invisible .part', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json')
  // no --yes: the run parks on the approval prompt, so the SIGINT lands mid-run
  await writeFile(fake, JSON.stringify([{ toolCalls: [{ name: 'bash', args: { command: 'echo hi' } }] }]))
  const cwd = mkdtempSync(join(tmpdir(), 'lhb-cwd-'))
  const p = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'), [join(ROOT, 'src', 'cli.ts'), 'run', harness('bare'), '--workdir', wd, 'x'],
    { cwd, env: { ...process.env, LHB_FAKE_BACKEND: fake } })
  await new Promise<void>(done => p.stderr.on('data', (b: Buffer) => { if (b.toString().includes('run bash:')) done() }))
  const code = await new Promise(done => { p.on('exit', done); p.kill('SIGINT') })
  expect(code).toBe(130)
  const files = await readdir(join(cwd, 'runs'))
  expect(files).toEqual([expect.stringMatching(/^[0-9a-f]{8}\.jsonl$/)])
}, 30_000)

test('run dies with a clear message, not a stack, when the harness file is missing or unreadable', async () => {
  const wd = await tmp('lhb-cli-')
  for (const file of [join(wd, 'nope.json'), wd]) {
    const r = cli(['run', file, '--workdir', wd, '--yes', 'task'])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/cannot read harness/)
    expect(r.stderr).not.toMatch(/at .*cli\.ts/)
  }
}, 30_000)

test('run starts an mcp server and reports its counts on stderr', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json')
  await writeFile(fake, JSON.stringify([{ content: 'fin' }]))
  const mcpFixture = join(ROOT, 'tests', 'fixtures', 'mcp-server.mjs')
  const harnessFile = join(wd, 'mcp-harness.json')
  await writeFile(harnessFile, JSON.stringify({
    name: 'mcp-test',
    backend: { kind: 'openai', baseUrl: 'http://x/v1', model: 'm', temperature: 0 },
    systemPrompt: 'sys',
    tools: { enabled: [], approveBash: false },
    toolCalls: { mode: 'native', enforceSchema: false, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' },
    context: { maxToolOutputChars: 1000, budgetTokens: 0 },
    loop: { maxTurns: 5 },
    mcpServers: { test: { command: process.execPath, args: [mcpFixture], tools: ['echo'] } },
  }))
  const r = cli(['run', harnessFile, '--workdir', wd, '--yes', 'do'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  // server name, offered count, kept-tools count, description chars, schema chars
  expect(r.stderr).toMatch(/mcp test: 9 offered, 1 tools, 15 desc \+ 77 schema chars/)
}, 30_000)

test('run without --yes prompts "start mcp server", not "run bash", for an mcp approval', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json')
  await writeFile(fake, JSON.stringify([])) // denial ends the run before any LLM request
  const mcpFixture = join(ROOT, 'tests', 'fixtures', 'mcp-server.mjs')
  const harnessFile = join(wd, 'mcp-harness.json')
  await writeFile(harnessFile, JSON.stringify({
    name: 'mcp-test',
    backend: { kind: 'openai', baseUrl: 'http://x/v1', model: 'm', temperature: 0 },
    systemPrompt: 'sys',
    tools: { enabled: [], approveBash: false },
    toolCalls: { mode: 'native', enforceSchema: false, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' },
    context: { maxToolOutputChars: 1000, budgetTokens: 0 },
    loop: { maxTurns: 5 },
    mcpServers: { test: { command: process.execPath, args: [mcpFixture], tools: ['echo'] } },
  }))
  // spawnSync's `input` closes stdin (EOF) right after writing, which races readline's
  // auto-close-on-end and can close the interface before .question() is ever called. A
  // live spawn that writes to stdin only once the prompt is on screen avoids that race —
  // same pattern as the SIGINT test above.
  const cwd = mkdtempSync(join(tmpdir(), 'lhb-cwd-'))
  const p = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'), [join(ROOT, 'src', 'cli.ts'), 'run', harnessFile, '--workdir', wd, 'do'],
    { cwd, env: { ...process.env, LHB_FAKE_BACKEND: fake } })
  let stderr = ''
  p.stderr.on('data', (b: Buffer) => { stderr += b.toString() })
  await new Promise<void>(done => p.stderr.on('data', (b: Buffer) => { if (b.toString().includes('[y/N]')) done() }))
  p.stdin.write('n\n')
  const code = await new Promise(done => p.on('exit', done))
  expect(stderr).toContain(`start mcp server "test": ${process.execPath} ${mcpFixture}`)
  expect(stderr).not.toContain('run bash:')
  expect(code).toBe(1) // denied -> mcp_error, not final
}, 30_000)

// Spec regression test 12: Ctrl-C during bench with a live mcp server must not corrupt the PASS
// table or leak the server. The mcp tool call ('stall') never answers, so the round hangs with a
// real mcp child alive until we interrupt it — the same marker + pgrep technique as the grandchild
// test in tests/mcp.test.ts, so this test does not see fixtures other test files start in parallel.
test('Ctrl-C during bench with a live mcp server leaves the PASS table intact and no process behind', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json'); const out = join(wd, 'b.json')
  await writeFile(fake, JSON.stringify([{ toolCalls: [{ name: 'stall', args: {} }] }]))
  const mcpFixture = join(ROOT, 'tests', 'fixtures', 'mcp-server.mjs')
  const marker = `lhb-bench-mcp-${process.pid}-${Date.now()}`
  const harnessFile = join(wd, 'mcp-harness.json')
  await writeFile(harnessFile, JSON.stringify({
    name: 'mcp-bench',
    backend: { kind: 'openai', baseUrl: 'http://x/v1', model: 'm', temperature: 0 },
    systemPrompt: 'sys',
    tools: { enabled: [], approveBash: false },
    toolCalls: { mode: 'native', enforceSchema: false, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' },
    context: { maxToolOutputChars: 1000, budgetTokens: 0 },
    loop: { maxTurns: 5 },
    mcpServers: { test: { command: process.execPath, args: [mcpFixture, `--marker=${marker}`], tools: ['stall'] } },
  }))
  const count = () => Number(execSync(`pgrep -f ${marker} | wc -l`).toString().trim())
  const cwd = mkdtempSync(join(tmpdir(), 'lhb-cwd-'))
  // Piped stdout (not inherited) so the async-flush path in bench's finish() is the one under test.
  const p = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'),
    [join(ROOT, 'src', 'cli.ts'), 'bench', '--n', '1', '--out', out, harnessFile],
    { cwd, env: { ...process.env, LHB_FAKE_BACKEND: fake }, stdio: ['ignore', 'pipe', 'pipe'] })
  // If an assertion below throws, or the stderr wait never resolves and vitest's timeout fires,
  // this must still not leak: kill the spawned tsx process, and the marked mcp child directly
  // (SIGKILLing tsx orphans it rather than reaping it, since it's a detached process group).
  try {
    let stdout = ''
    p.stdout.on('data', (b: Buffer) => { stdout += b.toString() })
    // benchOnce writes "<workdir> ... " to stderr once the round has started; the mcp server is up
    // and the (never-answering) stall call is in flight shortly after.
    await new Promise<void>(done => p.stderr.on('data', (b: Buffer) => { if (b.toString().includes('... ')) done() }))
    const deadline1 = Date.now() + 2000
    while (count() === 0 && Date.now() < deadline1) await new Promise(r => setTimeout(r, 20))
    expect(count()).toBeGreaterThan(0)   // the server is really alive before we interrupt it
    const code = await new Promise(done => { p.on('exit', done); p.kill('SIGINT') })
    expect(code).toBe(130)
    expect(stdout).toMatch(/^harness\s+PASS/m)
    expect(stdout).toMatch(/^mcp-bench\s+0\/0/m)
    const deadline2 = Date.now() + 2000
    while (count() > 0 && Date.now() < deadline2) await new Promise(r => setTimeout(r, 50))
    expect(count()).toBe(0)
  } finally {
    try { p.kill('SIGKILL') } catch {}
    try { execSync(`pkill -9 -f ${marker}`) } catch {}
  }
}, 15_000)

// The two numbers README quotes for the mcp-off/mcp-on pair: what the server put in front of the
// model, and how many tool results came back as errors. Measured on a real server child, not a mock.
test('bench with an mcp server records toolChars/toolErrors and prints the tool columns', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json'); const out = join(wd, 'b.json')
  await writeFile(fake, JSON.stringify([{ toolCalls: [{ name: 'boom', args: {} }] }, { content: 'Done.' }]))
  const harnessFile = join(wd, 'mcp-harness.json')
  await writeFile(harnessFile, JSON.stringify({
    name: 'mcp-bench',
    backend: { kind: 'openai', baseUrl: 'http://x/v1', model: 'm', temperature: 0 },
    systemPrompt: 'sys',
    tools: { enabled: [], approveBash: false },
    toolCalls: { mode: 'native', enforceSchema: false, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' },
    context: { maxToolOutputChars: 1000, budgetTokens: 0 },
    loop: { maxTurns: 5 },
    mcpServers: { test: { command: process.execPath, args: [join(ROOT, 'tests', 'fixtures', 'mcp-server.mjs')], tools: ['boom'] } },
  }))
  const r = cli(['bench', '--n', '1', '--out', out, harnessFile], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  const [run] = JSON.parse(await readFile(out, 'utf8')).harnesses[0].runs
  expect(run.toolChars).toBeGreaterThan(0)
  expect(run.toolErrors).toBe(1)
  // benchOnce always records editMiss (unlike guardBlocks, which is only set when the guard is on),
  // so its column prints here too even though this harness never turns the guard on.
  expect(r.stdout).toMatch(/^harness\s+PASS\s+reasons\s+med turns\s+med s\s+toolChars\s+med errs\s+editMiss$/m)
  expect(r.stdout).toMatch(new RegExp(`^mcp-bench\\s+0/1\\s+final×1\\s+\\d+\\s+\\d+\\s+${run.toolChars}\\s+1\\s+0$`, 'm'))
}, 60_000)

test('bench --task pool --size 2 --max-turns 7: a pool workdir, the verdict on it, and all three in the JSON', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json'); const out = join(wd, 'p.json')
  await writeFile(fake, JSON.stringify([{ content: '{"calls":[],"final":"nothing fixed"}' }]))
  const r = cli(['bench', '--n', '1', '--task', 'pool', '--size', '2', '--max-turns', '7', '--out', out, harness('tuned')], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  const j = JSON.parse(await readFile(out, 'utf8'))
  expect(j).toMatchObject({ taskName: 'pool', size: 2, node: process.version })
  expect(j.task).toContain('Do not edit the tests')
  expect(j.harnesses[0].config.loop.maxTurns).toBe(7) // the override is recorded, like --model
  const run = j.harnesses[0].runs[0]
  expect([run.verdict, run.reason]).toEqual(['FAIL', 'final']) // nothing was fixed
  expect((await readdir(join(run.workdir, 'src'))).sort()).toEqual(['clamp.js', 'words.js'])
}, 60_000)

test('bench without --task is the slug task, and says so', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json'); const out = join(wd, 's.json')
  await writeFile(fake, JSON.stringify([{ content: '{"calls":[],"final":"nothing fixed"}' }]))
  const r = cli(['bench', '--n', '1', '--out', out, harness('tuned')], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  const j = JSON.parse(await readFile(out, 'utf8'))
  expect(j.taskName).toBe('slug'); expect('size' in j).toBe(false)
  expect(j.harnesses[0].config.loop.maxTurns).toBe(15)
  expect(await readdir(join(j.harnesses[0].runs[0].workdir, 'data'))).toEqual(['app.log'])
}, 60_000)

test('bench rejects a task/size/max-turns combination that means nothing, with usage', () => {
  for (const extra of [['--task', 'nope'], ['--size', '3'], ['--task', 'slug', '--size', '3'], ['--task', 'pool'],
    ['--task', 'pool', '--size', '0'], ['--task', 'pool', '--size', '11'], ['--task', 'pool', '--size', '2.5'], ['--max-turns', '0']]) {
    const r = cli(['bench', '--n', '1', ...extra])
    expect([extra.join(' '), r.status]).toEqual([extra.join(' '), 2])
    expect(r.stderr).toMatch(/usage/)
  }
}, 60_000)

test('replay sends the recorded request of one turn --n times and counts the distinct replies against the recorded one', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lhb-cwd-'))
  const raw = (content: string) => ({ choices: [{ message: { content } }] })
  execSync('mkdir runs', { cwd })
  await writeFile(join(cwd, 'runs', 'abc12345.jsonl'), [
    { meta: { id: 'abc12345' } },
    { seq: 0, turn: 1, type: 'llm_request', payload: { model: 'm', messages: [], temperature: 0.2, stream: true } },
    { seq: 1, turn: 1, type: 'llm_response', raw: raw('A'), content: 'A', latencyMs: 1 },
  ].map(l => JSON.stringify(l)).join('\n') + '\n')
  const fake = join(cwd, 'fake.json')
  await writeFile(fake, JSON.stringify([{ raw: raw('A'), usage: { promptTokens: 7, completionTokens: 1 } }, { raw: raw('B') }, { raw: raw('A') }]))
  const args = ['replay', 'abc12345', '--turn', '1', '--n', '3', '--base-url', 'http://x/v1', '--kind', 'openai']
  const r = cli([...args, '--temperature', '1', '--json'], { LHB_FAKE_BACKEND: fake }, cwd)
  expect(r.status).toBe(0)
  const out = JSON.parse(r.stdout)
  expect(out.payload.temperature).toBe(1)
  expect(out.replies).toEqual([
    { count: 2, sameAsRecorded: true, promptTokens: 7, truncated: false, reply: 'A' },
    { count: 1, sameAsRecorded: false, truncated: false, reply: 'B' },
  ])
  const human = cli(args, { LHB_FAKE_BACKEND: fake }, cwd)
  expect(human.stdout).toContain('3 samples, 2 distinct')
  expect(human.stdout).toContain('2x same as recorded, 7 prompt tok')
  // a turn the run does not have, a missing trace and a missing --kind are one-line errors, not stacks
  for (const bad of [[...args.slice(0, 2), '--turn', '9', ...args.slice(4)], ['replay', 'nope', ...args.slice(2)], args.slice(0, -2)]) {
    const e = cli(bad, { LHB_FAKE_BACKEND: fake }, cwd)
    expect(e.status).toBe(2); expect(e.stderr).not.toContain('    at ')
  }
}, 60_000)

test('run --answer-schema sends the schema with the request, and exits 0 only on a final answer that is JSON', async () => {
  const wd = await tmp('lhb-cli-')
  const schema = { type: 'object', properties: { '1': { type: 'string' } }, required: ['1'] }
  await writeFile(join(wd, 'schema.json'), JSON.stringify(schema))
  const fake = join(wd, 'fake.json')
  await writeFile(fake, JSON.stringify([{ content: '{"1":"KEEP"}' }]))
  const ok = cli(['run', harness('curator-judge'), '--workdir', wd, '--json', '--answer-schema', join(wd, 'schema.json'), 'judge'], { LHB_FAKE_BACKEND: fake })
  expect(ok.status).toBe(0)
  const events = ok.stdout.trim().split('\n').map(l => JSON.parse(l))
  expect(events.find(e => e.type === 'llm_request').payload.responseSchema).toEqual(schema)
  expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'final', text: '{"1":"KEEP"}' })
  // a server that ignored the schema: the same JSON comes back inside a fence, and that is not the answer asked for
  await writeFile(fake, JSON.stringify([{ content: '```json\n{"1":"KEEP"}\n```' }]))
  const fenced = cli(['run', harness('curator-judge'), '--workdir', wd, '--answer-schema', join(wd, 'schema.json'), 'judge'], { LHB_FAKE_BACKEND: fake })
  expect(fenced.status).toBe(1)
  expect(fenced.stderr).toMatch(/final answer is not JSON/)
}, 30_000)

test('run --answer-schema dies before any request on a harness that would not send it, or a file that is not a JSON object', async () => {
  const wd = await tmp('lhb-cli-')
  await writeFile(join(wd, 'schema.json'), '{"type":"object"}')
  await writeFile(join(wd, 'array.json'), '[]')
  await writeFile(join(wd, 'broken.json'), '{')
  const fake = join(wd, 'fake.json')
  await writeFile(fake, JSON.stringify([{ content: '{}' }]))
  const cases: [string, string, RegExp][] = [
    ['bare', 'schema.json', /--answer-schema needs a harness that sends it/],
    ['curator-judge', 'array.json', /must hold a JSON object/],
    ['curator-judge', 'broken.json', /cannot read answer schema/],
    ['curator-judge', 'nope.json', /cannot read answer schema/],
  ]
  for (const [h, file, message] of cases) {
    const r = cli(['run', harness(h), '--workdir', wd, '--yes', '--answer-schema', join(wd, file), 'judge'], { LHB_FAKE_BACKEND: fake })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(message)
    expect(r.stderr).not.toMatch(/at .*cli\.ts/)
    expect(existsSync(join(r.cwd, 'runs'))).toBe(false)
  }
}, 60_000)
