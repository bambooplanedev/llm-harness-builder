import { test, expect } from 'vitest'
import { spawnSync, execSync } from 'node:child_process'
import { writeFile, readFile, readdir, stat, cp } from 'node:fs/promises'
import { chmodSync, existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { harnessFile as harness, ROOT, listen, cli, cliAsync, tmp, tmpSync, fakeFile, spawnCli, spawnCliSync, tasksRepo, tasksEnv, clonesIn, bashCall, TWO, gitRepo, gitCommit } from './helpers.js'
import { fakeOpenAI, toolTurn, textTurn } from './fake-openai.js'
import { fakeAnthropic, toolReply, textReply } from './fake-anthropic.js'
import { RunStore } from '../src/server/runs'
import { loadPolyglot } from '../src/core/polyglot.js'
import { notesKey, readNotes } from '../src/core/notes.js'

const TUNED_EDIT = '{"calls":[{"name":"edit_file","args":{"path":"src/slugify.js","old":"replace(/[^a-z0-9]+/g, \'-\')","new":"replace(/[^a-z0-9]+/g, \'-\').replace(/^-+|-+$/g, \'\')"}}],"final":null}'
const TUNED_FINAL = '{"calls":[],"final":"Fixed."}'
const HERMES_EDIT = '<tool_call>\n{"name":"edit_file","arguments":{"path":"src/slugify.js","old":"replace(/[^a-z0-9]+/g, \'-\')","new":"replace(/[^a-z0-9]+/g, \'-\').replace(/^-+|-+$/g, \'\')"}}\n</tool_call>'

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
  const fake = fakeFile(wd, [{ content: '' }, { content: '' }])
  const r = cli(['run', harness('bare'), '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(1)
}, 30_000)

test('demo prints PASS/FAIL per harness', async () => {
  const fake = join(await tmp('lhb-cli-'), 'fake.json')
  // bare: model answers without doing anything -> check.sh fails. tuned: fixes the bug via edit_file.
  await writeFile(fake, JSON.stringify([
    { content: 'Done.' },
    { content: TUNED_EDIT },
    { content: TUNED_FINAL },
    { content: HERMES_EDIT },
    { content: 'Fixed.' },
  ]))
  const r = cli(['demo'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  expect(r.stdout).toMatch(/bare\s+FAIL/)
  expect(r.stdout).toMatch(/tuned-nothink\s+PASS/)
  expect(r.stdout).toMatch(/tuned-hermes\s+PASS/)
  expect(r.stderr).toContain("demo approves everything without asking: the model's commands and the harness files' mcpServers and loop.untilBash, in fresh temp workdirs")
  expect(r.stdout).not.toContain('approves everything')
}, 60_000)

test('demo runs tuned-nothink, or tuned on a hosted API where backend.think is refused', async () => {
  const fake = fakeFile(await tmp('lhb-cli-'), Array(8).fill({ content: 'Done.' }))
  const local = cli(['demo'], { LHB_FAKE_BACKEND: fake })
  expect(local.stderr).toContain('=== tuned-nothink')
  const hosted = cli(['demo', '--kind', 'openai', '--base-url', 'https://api.example.com/v1', '--api-key-env', 'X_API_KEY'], { LHB_FAKE_BACKEND: fake, X_API_KEY: 'k' })
  expect(hosted.stderr).not.toContain('invalid harness')
  expect(hosted.stderr).toMatch(/=== tuned \(/)
  expect(hosted.stderr).not.toContain('=== tuned-nothink')
}, 60_000)

test('demo --json keeps stdout pure JSONL and prints the summary on stderr', async () => {
  const fake = fakeFile(await tmp('lhb-cli-'), [
    { content: 'Done.' },
    { content: TUNED_EDIT },
    { content: TUNED_FINAL },
    { content: HERMES_EDIT },
    { content: 'Fixed.' },
  ])
  const r = cli(['demo', '--json'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  const lines = r.stdout.trim().split('\n')
  for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
  expect(r.stdout).not.toMatch(/PASS|FAIL/)
  expect(r.stderr).toMatch(/bare\s+FAIL/)
  expect(r.stderr).toMatch(/tuned-nothink\s+PASS/)
  expect(r.stderr).toMatch(/tuned-hermes\s+PASS/)
  expect(r.stderr).toContain('demo approves everything without asking')
  for (const l of r.stdout.trim().split('\n')) expect(() => JSON.parse(l)).not.toThrow()
}, 60_000)

test('run flags a final answer with zero tool calls', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = fakeFile(wd, [{ content: 'Let me look at that first.' }])
  const r = cli(['run', harness('tuned-hermes'), '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  expect(r.stderr).toMatch(/! final after 0 tool calls/)
}, 30_000)

test('the tool_call line shows control and format characters of the arguments escaped, so a command cannot redraw the terminal', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = fakeFile(wd, [
    { toolCalls: [{ name: 'bash', args: { command: 'true \u009b1G \u202e \u007f' } }] },
    { toolCalls: [{ name: 'bash', args: { command: 'true ' + '\u009b'.repeat(100) } }] }, // 114 characters raw, 614 escaped
    { content: 'fin' },
  ])
  const r = cli(['run', harness('bare'), '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  expect(r.stderr).toContain('[t1] tool_call bash {"command":"true \\u009b1G \\u202e \\u007f"}')
  // escaped first, then cut at 200: the cut keeps the line's length, it does not let the escapes through
  const long = r.stderr.split('\n').find(l => l.startsWith('[t2] tool_call bash '))!.slice('[t2] tool_call bash '.length)
  expect(long).toBe(('{"command":"true ' + '\\u009b'.repeat(100) + '"}').slice(0, 200))
  expect(r.stderr).not.toMatch(/[\u007f-\u009f\u202e]/)
}, 30_000)

// stderr holds no control character but the newline and the tab: none of them is left for a terminal to act on
const NO_RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e\u2028\u2029\u200b-\u200f\ufeff]/

test('what the model says and what a tool returned reach stderr with control characters escaped, so a run cannot rewrite the terminal', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json')
  await writeFile(join(wd, 'evil.txt'), 'seen\u001b[2K\u009b1G\nsecond\tline')
  await writeFile(fake, JSON.stringify([
    { content: 'looking\u001b[2K', toolCalls: [{ name: 'read_file', args: { path: 'evil.txt' } }, { name: 'rea\u001b[2Kd', args: {} }] },
    { content: 'all done\u001b[2K\u202e\nsecond line\twith a tab\r' },
  ]))
  const r = cli(['run', harness('bare'), '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  // the model's words next to a call: one line, escaped
  expect(r.stderr).toContain('\n    looking\\u001b[2K\n')
  // the name of a call, and the result under that name
  expect(r.stderr).toContain('tool_call rea\\u001b[2Kd {}\n')
  expect(r.stderr).toContain('tool_result rea\\u001b[2Kd (error): unknown tool rea\\u001b[2Kd; available: ')
  // what a tool returned: one line, the newline flattened to a space, the escapes shown (a tab is one too)
  expect(r.stderr).toContain('tool_result read_file: seen\\u001b[2K\\u009b1G second\\u0009line\n')
  // the final text keeps its lines and its tab; the carriage return and the rest are escaped
  expect(r.stderr).toContain('done: final after 2 turns, 2 tool calls\nall done\\u001b[2K\\u202e\nsecond line\twith a tab\\u000d\ntrace runs/')
  expect(r.stderr).not.toMatch(NO_RAW_CONTROL)
}, 30_000)

test('the output and the command of a failed loop.untilBash check reach stderr escaped', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json'), file = join(wd, 'until.json')
  const plain = JSON.parse(await readFile(harness('bare'), 'utf8'))
  // the command prints a clear-line and fails; a comment after it holds a raw escape of its own, which the shell ignores
  await writeFile(file, JSON.stringify({ ...plain, loop: { maxTurns: 1, untilBash: "printf 'bad\\033[2K\\n'; exit 1 # \u001b[8m" } }))
  await writeFile(fake, JSON.stringify([{ content: 'done' }]))
  const r = cli(['run', file, '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(1)
  expect(r.stderr).toContain("final_check failed: printf 'bad\\033[2K\\n'; exit 1 # \\u001b[8m\n    bad\\u001b[2K  [exit 1]\n")
  expect(r.stderr).not.toMatch(NO_RAW_CONTROL)
}, 30_000)

test('a backend error shows its message on one line and its body with the lines kept, both escaped: a server cannot rewrite the terminal either', async () => {
  const wd = await tmp('lhb-cli-'), cwd = tmpSync('lhb-cwd-')
  const up = http.createServer((req, res) => { req.resume(); res.statusCode = 500; res.end('oops\u001b[2K\u202e\nsecond line\ttab\u009b1G') })
  await listen(up)
  try {
    const url = `http://127.0.0.1:${(up.address() as AddressInfo).port}/v1`
    // spawn, not spawnSync: this process has to answer while the CLI runs
    const p = spawnCli(['run', harness('bare'), '--workdir', wd, '--yes', '--kind', 'openai', '--base-url', url, 'x'], { cwd })
    let stderr = ''
    p.stderr.on('data', (b: Buffer) => { stderr += b })
    const status = await new Promise<number | null>(done => p.on('close', done))
    expect(status).toBe(1)
    expect(stderr).toContain('error: POST /chat/completions: 500\noops\\u001b[2K\\u202e\nsecond line\ttab\\u009b1G\n')
    expect(stderr).not.toMatch(NO_RAW_CONTROL)
  } finally { up.closeAllConnections(); up.close() }
}, 30_000)

test('run dies with a clear message when the harness has no backend object and an override is given', async () => {
  const wd = await tmp('lhb-cli-')
  const bad = join(wd, 'bad.json')
  await writeFile(bad, JSON.stringify({ name: 'bad' }))
  const r = cli(['run', bad, '--workdir', wd, '--yes', '--model', 'x', 'task'])
  expect(r.status).toBe(2)
  expect(r.stderr).toMatch(/invalid harness .*backend must be an object/s)
}, 30_000)


test('bench --n 2 on one harness: table, JSON with per-run reason/parseErrors/workdir', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json'); const out = join(wd, 'b.json')
  // run 1: edit → final. run 2: garbage (parse_error, retried) → edit → final.
  await writeFile(fake, JSON.stringify([{ content: TUNED_EDIT, usage: { promptTokens: 100, completionTokens: 10, reasoningTokens: 7 } }, { content: TUNED_FINAL, usage: { promptTokens: 150, completionTokens: 5 } }, { content: 'not json' }, { content: TUNED_EDIT }, { content: TUNED_FINAL }]))
  const r = cli(['bench', '--n', '2', '--wide', '--out', out, harness('tuned')], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  expect(r.stdout).toMatch(/^tuned\s+2\/2\s+0\.34–1\.00\s+final×2\s/m)
  expect(r.stderr).toMatch(/--- round 2\/2/)
  expect(r.stdout).toMatch(/turns\/ok.*reason tok/)
  const j = JSON.parse(await readFile(out, 'utf8'))
  expect(j).toMatchObject({ version: 1, n: 2, timeoutS: 1800, complete: true })
  // the JSON is written via a tmp file + rename, so a Ctrl-C mid-write can never truncate it; no tmp is left behind
  expect((await readdir(wd)).filter(f => f.endsWith('.tmp'))).toEqual([])
  const h = j.harnesses[0]
  expect(h.name).toBe('tuned'); expect(h.config.name).toBe('tuned'); expect(h.pass).toBe(2); expect(h.reasons).toEqual({ final: 2 })
  expect(h.runs.map((x: any) => [x.round, x.verdict, x.reason, x.parseErrors])).toEqual([[1, 'PASS', 'final', 0], [2, 'PASS', 'final', 1]])
  expect(typeof h.runs[1].lastError).toBe('string'); expect(h.runs[1].lastError.length).toBeGreaterThan(0)
  expect(h.runs[0].lastError).toBeUndefined()
  // the biggest prompt + reply of the run; a run whose server reported no usage has none
  expect(h.runs.map((x: any) => x.peakTokens)).toEqual([155, undefined])
  // tool use: calls by name, lines the model saw, reasoning tokens only where a reply reported them
  expect(h.runs.map((x: any) => x.toolCounts)).toEqual([{ edit_file: 1 }, { edit_file: 1 }])
  expect(h.runs.map((x: any) => x.reasoningTokens)).toEqual([7, undefined])
  expect(h.runs.every((x: any) => x.outputLines >= 1)).toBe(true)
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
  expect(r.stdout).toMatch(/^tuned-nothink\s+1\/1\s/m)
  expect(r.stdout).toMatch(/^tuned-hermes\s+1\/1\s/m)
  expect(r.stderr).toMatch(/--- round 1\/1/)
  expect(r.stderr).toContain(join(wd, 'harnesses', 'bare.json'))
  const j = JSON.parse(await readFile(out, 'utf8'))
  expect(j.harnesses.map((h: any) => h.name)).toEqual(['bare', 'tuned-nothink', 'tuned-hermes'])
  expect(j.harnesses.flatMap((h: any) => h.runs.map((x: any) => x.reason))).toEqual(['final', 'final', 'final'])
  expect(r.stderr).toContain("bench approves everything without asking: the model's commands and the harness files' mcpServers and loop.untilBash, in fresh temp workdirs")
  expect(r.stdout).not.toContain('approves everything')
}, 90_000)

test('bench without files falls back to the package per harness file', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json'); const out = join(wd, 'b.json')
  for (const n of ['bare', 'tuned-hermes']) await cp(harness(n), join(wd, 'harnesses', `${n}.json`))
  await writeFile(fake, JSON.stringify(Array(8).fill({ content: 'Done.' })))
  const r = cli(['bench', '--n', '1', '--out', out], { LHB_FAKE_BACKEND: fake }, wd)
  expect(r.status).toBe(0)
  expect(r.stderr).not.toContain('ENOENT')
  expect(JSON.parse(await readFile(out, 'utf8')).harnesses.map((h: any) => h.name)).toEqual(['bare', 'tuned-nothink', 'tuned-hermes'])
}, 90_000)

test('serve adds the shipped harnesses that are missing and keeps an edited copy', async () => {
  const wd = await tmp('lhb-cli-')
  mkdirSync(join(wd, 'harnesses'))
  const edited = JSON.stringify({ ...JSON.parse(await readFile(harness('bare'), 'utf8')), description: 'mine' })
  await writeFile(join(wd, 'harnesses', 'bare.json'), edited)
  const p = spawnCli(['serve', '--port', '0', '--no-open'], { cwd: wd, stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    await new Promise<void>(res => p.stderr!.on('data', d => String(d).includes('serving on') && res()))
    expect(readdirSync(join(wd, 'harnesses')).sort()).toEqual(readdirSync(join(ROOT, 'harnesses')).sort())
    expect(await readFile(join(wd, 'harnesses', 'bare.json'), 'utf8')).toBe(edited)
  } finally { p.kill() }
}, 30_000)

test('bench against a server that does not answer stops before the first run, with no JSON written', async () => {
  const wd = await tmp('lhb-cli-'); const out = join(wd, 'b.json')
  const r = cli(['bench', '--n', '1', '--out', out, '--kind', 'openai', '--base-url', 'http://127.0.0.1:1/v1', harness('tuned')])
  expect(r.status).toBe(2)
  expect(r.stderr).toMatch(/^preflight: http:\/\/127\.0\.0\.1:1\/v1 \(openai\) does not answer: /m)
  expect(r.stderr).not.toMatch(/--- round/)
  expect(existsSync(out)).toBe(false)
}, 30_000)

test('demo against a server that does not answer stops before any run, exit 1, no trace', () => {
  const r = cli(['demo', '--kind', 'openai', '--base-url', 'http://127.0.0.1:1/v1'])
  expect(r.status).toBe(1)
  expect(r.stderr).toMatch(/^preflight: http:\/\/127\.0\.0\.1:1\/v1 \(openai\) does not answer: /m)
  expect(r.stderr).not.toContain('=== bare')
  expect(!existsSync(join(r.cwd, 'runs')) || readdirSync(join(r.cwd, 'runs')).length === 0).toBe(true)
}, 30_000)

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
  // --yes and a slow command: the SIGINT lands while bash runs, mid-run
  await writeFile(fake, JSON.stringify([{ toolCalls: [{ name: 'bash', args: { command: 'sleep 5' } }] }]))
  const cwd = tmpSync('lhb-cwd-')
  const p = spawnCli(['run', harness('bare'), '--workdir', wd, '--yes', 'x'],
    { cwd, env: { ...process.env, LHB_FAKE_BACKEND: fake } })
  await new Promise<void>(done => p.stderr.on('data', (b: Buffer) => { if (b.toString().includes('tool_call bash')) done() }))
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
  const fake = fakeFile(wd, [{ content: 'fin' }])
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
  expect(r.stderr).toMatch(/mcp test: 10 offered, 1 tools, 15 desc \+ 77 schema chars/)
}, 30_000)

// Spec regression test 12: Ctrl-C during bench with a live mcp server must not corrupt the PASS
// table or leak the server. The mcp tool call ('stall') never answers, so the round hangs with a
// real mcp child alive until we interrupt it — the same marker + pgrep technique as the grandchild
// test in tests/mcp.test.ts, so this test does not see fixtures other test files start in parallel.
test('Ctrl-C during bench with a live mcp server leaves the PASS table intact and no process behind', async () => {
  const wd = await tmp('lhb-cli-')
  const out = join(wd, 'b.json')
  const fake = fakeFile(wd, [{ toolCalls: [{ name: 'stall', args: {} }] }])
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
  // No shell: a `sh -c` around pgrep carries the marker in its own command line, and Linux's pgrep,
  // unlike macOS's, does not leave its ancestors out — it would count that shell.
  const count = () => spawnSync('pgrep', ['-f', marker]).stdout.toString().split('\n').filter(Boolean).length
  const cwd = tmpSync('lhb-cwd-')
  // Piped stdout (not inherited) so the async-flush path in bench's finish() is the one under test.
  const p = spawnCli(['bench', '--n', '1', '--out', out, harnessFile],
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
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ complete: false, stopped: true })
    const deadline2 = Date.now() + 2000
    while (count() > 0 && Date.now() < deadline2) await new Promise(r => setTimeout(r, 50))
    expect(count()).toBe(0)
  } finally {
    try { p.kill('SIGKILL') } catch {}
    try { execSync(`pkill -9 -f ${marker}`) } catch {}
  }
}, 15_000)

// Stop bench on the page is this SIGINT: a command the model started must not outlive the bench.
test('SIGINT to bench takes a long command the model started with it', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json'); const out = join(wd, 'b.json')
  // A duration no other process has: pgrep finds this sleep and nothing else (on Linux the shell around it too).
  const secs = `300.${process.pid}${Date.now() % 100000}`
  await writeFile(fake, JSON.stringify([{ toolCalls: [{ name: 'bash', args: { command: `sleep ${secs}` } }] }]))
  const harnessFile = join(wd, 'sleepy.json')
  await writeFile(harnessFile, JSON.stringify({
    name: 'sleepy', backend: { kind: 'openai', baseUrl: 'http://x/v1', model: 'm', temperature: 0 }, systemPrompt: 'sys',
    tools: { enabled: ['bash'], approveBash: true, bashTimeoutS: 600 },
    toolCalls: { mode: 'native', enforceSchema: false, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' },
    context: { maxToolOutputChars: 1000, budgetTokens: 0 }, loop: { maxTurns: 5 },
  }))
  const count = () => spawnSync('pgrep', ['-f', `sleep ${secs}`]).stdout.toString().split('\n').filter(Boolean).length
  const p = spawnCli(['bench', '--n', '1', '--out', out, harnessFile],
    { cwd: tmpSync('lhb-cwd-'), env: { ...process.env, LHB_FAKE_BACKEND: fake }, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    p.stdout.resume(); p.stderr.resume()
    const deadline1 = Date.now() + 10_000
    while (count() === 0 && Date.now() < deadline1) await new Promise(r => setTimeout(r, 50))
    expect(count()).toBeGreaterThan(0)
    expect(await new Promise(done => { p.on('exit', done); p.kill('SIGINT') })).toBe(130)
    const deadline2 = Date.now() + 2000
    while (count() > 0 && Date.now() < deadline2) await new Promise(r => setTimeout(r, 50))
    expect(count()).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ complete: false, stopped: true })
  } finally {
    try { p.kill('SIGKILL') } catch {}
    try { execSync(`pkill -9 -f 'sleep ${secs}'`) } catch {}
  }
}, 20_000)

// The two numbers README quotes for the mcp-off/mcp-on pair: what the server put in front of the
// model, and how many tool results came back as errors. Measured on a real server child, not a mock.
test('bench with an mcp server records toolChars/toolErrors and prints the tool columns', async () => {
  const wd = await tmp('lhb-cli-')
  const out = join(wd, 'b.json')
  const fake = fakeFile(wd, [{ toolCalls: [{ name: 'boom', args: {} }] }, { content: 'Done.' }])
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
  expect(r.stdout).toMatch(/^harness\s+PASS\s+95% CI\s+reasons\s+med turns\s+med s\s+toolChars\s+med errs\s+editMiss$/m)
  expect(r.stdout).toMatch(new RegExp(`^mcp-bench\\s+0/1\\s+0\\.00–0\\.79\\s+final×1\\s+\\d+\\s+\\d+\\s+${run.toolChars}\\s+1\\s+0$`, 'm'))
}, 60_000)

test('bench --task pool --size 2 --max-turns 7: a pool workdir, the verdict on it, and all three in the JSON', async () => {
  const wd = await tmp('lhb-cli-')
  const out = join(wd, 'p.json')
  const fake = fakeFile(wd, [{ content: '{"calls":[],"final":"nothing fixed"}' }])
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

test('bench --task polyglot --size 2: the first two exercises, each run with its test counts, an empty queue included (backend_error)', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json'); const out = join(wd, 'g.json')
  await writeFile(fake, JSON.stringify([])) // every run ends in reason 'error'; the check still runs
  const r = cli(['bench', '--n', '1', '--task', 'polyglot', '--size', '2', '--out', out, harness('tuned'), harness('bare')], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  const j = JSON.parse(await readFile(out, 'utf8'))
  const { exercises } = loadPolyglot()
  expect(j).toMatchObject({ taskName: 'polyglot', size: 2, taskCount: 2, complete: true, task: 'polyglot: the first 2 of 47 Exercism JavaScript exercises' })
  for (const h of j.harnesses) {
    expect(h.runs.map((x: { task: string }) => x.task)).toEqual(exercises.slice(0, 2).map(e => e.name))
    h.runs.forEach((x: { tests: unknown; reason: string }, i: number) => {
      expect(x.reason).toBe('backend_error')
      expect(x.tests).toEqual({ passed: 0, total: exercises[i].tests.length })
    })
    expect(h.tests).toEqual({ passed: 0, total: exercises[0].tests.length + exercises[1].tests.length })
  }
  expect(r.stdout).toMatch(/^harness\s+PASS.*\btests$/m)
  // size 2 × n 1 = 2 real runs per harness, each line names its exercise
  expect(r.stderr).toMatch(/^bench: 2 harnesses × 2 runs,/m)
  for (const e of exercises.slice(0, 2)) expect(r.stderr).toContain(`tuned #1 ${e.name} `)
}, 120_000)

test('bench --task polyglot: a model that writes the proof gets PASS and all its tests green, in the run, the harness and the table', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json'); const out = join(wd, 'w.json')
  const first = loadPolyglot().exercises[0]
  const proof = await readFile(join(ROOT, 'polyglot-proofs', `${first.name}.js`), 'utf8')
  await writeFile(fake, JSON.stringify([{ content: JSON.stringify({ calls: [{ name: 'write_file', args: { path: `${first.name}.js`, content: proof } }], final: null }) }, { content: '{"calls":[],"final":"done"}' }]))
  const r = cli(['bench', '--n', '1', '--task', 'polyglot', '--size', '1', '--out', out, harness('tuned')], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  const j = JSON.parse(await readFile(out, 'utf8'))
  const run = j.harnesses[0].runs[0], total = first.tests.length
  expect(total).toBeGreaterThan(0)
  expect([run.verdict, run.reason, run.tests]).toEqual(['PASS', 'final', { passed: total, total }])
  expect(j.harnesses[0].tests).toEqual({ passed: total, total })
  expect(r.stdout).toMatch(new RegExp(`^tuned\\s.*${total}/${total}$`, 'm'))
}, 120_000)

test.skipIf(process.getuid?.() === 0)('bench --task polyglot: a run that throws before its check still carries tests {passed: 0, total}', async () => {
  const wd = await tmp('lhb-cli-')
  const out = join(wd, 't.json')
  const fake = fakeFile(wd, [])
  // prepare makes its workdir in the temp dir: one that cannot be written to makes prepare throw (tsx keeps its own cache dir in it, made first).
  const ro = join(wd, 'ro'); mkdirSync(join(ro, `tsx-${process.getuid?.()}`), { recursive: true }); chmodSync(ro, 0o500)
  const r = cli(['bench', '--n', '1', '--task', 'polyglot', '--size', '1', '--out', out, harness('tuned')], { LHB_FAKE_BACKEND: fake, TMPDIR: ro })
  chmodSync(ro, 0o700)
  expect(r.status).toBe(0)
  const j = JSON.parse(await readFile(out, 'utf8'))
  const run = j.harnesses[0].runs[0]
  expect([run.verdict, run.reason, run.turns]).toEqual(['FAIL', 'error', 0])
  expect(run.tests).toEqual({ passed: 0, total: loadPolyglot().exercises[0].tests.length })
}, 120_000)

test('bench without --task is the slug task, and says so', async () => {
  const wd = await tmp('lhb-cli-')
  const out = join(wd, 's.json')
  const fake = fakeFile(wd, [{ content: '{"calls":[],"final":"nothing fixed"}' }])
  const r = cli(['bench', '--n', '1', '--out', out, harness('tuned')], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  const j = JSON.parse(await readFile(out, 'utf8'))
  expect(j.taskName).toBe('slug'); expect('size' in j).toBe(false)
  expect(j.harnesses[0].config.loop.maxTurns).toBe(15)
  expect(await readdir(join(j.harnesses[0].runs[0].workdir, 'data'))).toEqual(['app.log'])
}, 60_000)

// The check runs what the model wrote, with the environment its bash had: the base set and the names in tools.bashEnv.
// The model has write_file, so it can replace check.sh; here it does, and the script reports what it was given.
const reportEnv = (file: string) => ({ toolCalls: [{ name: 'write_file', args: { path: 'check.sh', content: `printf '[%s][%s]' "$LHB_CHECK_NAMED" "$LHB_CHECK_SECRET" > '${file}'\n` } }] })
const OURS = { LHB_CHECK_NAMED: 'named-value', LHB_CHECK_SECRET: 'synthetic-s3cr3t' }

test('bench: the check gets the base environment and the names in the harness\'s tools.bashEnv, nothing else of ours', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json'), out = join(wd, 'b.json'), seen = { named: join(wd, 'named.txt'), plain: join(wd, 'plain.txt') }
  const harnessFile = async (name: string, bashEnv?: string[]) => {
    const file = join(wd, `${name}.json`)
    await writeFile(file, JSON.stringify({
      name,
      backend: { kind: 'openai', baseUrl: 'http://x/v1', model: 'm', temperature: 0 },
      systemPrompt: 'sys',
      tools: { enabled: ['write_file'], approveBash: false, bashEnv },
      toolCalls: { mode: 'native', enforceSchema: false, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' },
      context: { maxToolOutputChars: 1000, budgetTokens: 0 },
      loop: { maxTurns: 5 },
    }))
    return file
  }
  await writeFile(fake, JSON.stringify([reportEnv(seen.named), { content: 'Done.' }, reportEnv(seen.plain), { content: 'Done.' }]))
  const r = cli(['bench', '--n', '1', '--out', out, await harnessFile('named', ['LHB_CHECK_NAMED']), await harnessFile('plain')], { LHB_FAKE_BACKEND: fake, ...OURS })
  expect(r.status).toBe(0)
  expect(await readFile(seen.named, 'utf8')).toBe('[named-value][]')
  expect(await readFile(seen.plain, 'utf8')).toBe('[][]')
  // bench names the variables per harness, before any run, and never a value
  expect(r.stderr).toContain('named: bash gets from your environment: LHB_CHECK_NAMED')
  expect(r.stderr).not.toContain('plain: bash gets')
  expect(r.stderr).not.toContain('named-value')
}, 60_000)

test('demo: the check runs with the base environment, not ours', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json'), seen = join(wd, 'seen.txt')
  // bare replaces check.sh; tuned and tuned-hermes answer at once
  await writeFile(fake, JSON.stringify([reportEnv(seen), { content: 'Done.' }, { content: TUNED_FINAL }, { content: 'Done.' }]))
  const r = cli(['demo'], { LHB_FAKE_BACKEND: fake, ...OURS })
  expect(r.status).toBe(0)
  expect(r.stdout).toMatch(/bare\s+PASS/)
  expect(await readFile(seen, 'utf8')).toBe('[][]')
}, 60_000)

test('a harness with tools.bashEnv says on stderr which names bash gets, never the values', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = fakeFile(wd, [{ content: 'fin' }])
  const plain = JSON.parse(await readFile(harness('bare'), 'utf8'))
  const file = join(wd, 'env.json')
  await writeFile(file, JSON.stringify({ ...plain, tools: { ...plain.tools, bashEnv: ['LHB_NOTE_SET', 'LHB_NOTE_UNSET'] } }))
  const r = cli(['run', file, '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake, LHB_NOTE_SET: 'v4lue' })
  expect(r.status).toBe(0)
  expect(r.stderr).toContain('bash gets from your environment: LHB_NOTE_SET, LHB_NOTE_UNSET (not set)')
  expect(r.stderr).not.toContain('v4lue')
  const without = cli(['run', harness('bare'), '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake })
  expect(without.stderr).not.toContain('bash gets from your environment')
}, 30_000)

test('bench rejects a task/size/max-turns combination that means nothing, with usage', () => {
  for (const extra of [['--task', 'nope'], ['--size', '3'], ['--task', 'slug', '--size', '3'], ['--task', 'pool'],
    ['--task', 'pool', '--size', '0'], ['--task', 'pool', '--size', '11'], ['--task', 'pool', '--size', '2.5'], ['--max-turns', '0']]) {
    const r = cli(['bench', '--n', '1', ...extra])
    expect([extra.join(' '), r.status]).toEqual([extra.join(' '), 2])
    expect(r.stderr).toMatch(/usage/)
  }
}, 60_000)

test('replay sends the recorded request of one turn --n times and counts the distinct replies against the recorded one', async () => {
  const cwd = tmpSync('lhb-cwd-')
  const raw = (content: string) => ({ choices: [{ message: { content } }] })
  execSync('mkdir runs', { cwd })
  await writeFile(join(cwd, 'runs', 'abc12345.jsonl'), [
    { meta: { id: 'abc12345' } },
    { seq: 0, turn: 1, type: 'llm_request', payload: { model: 'm', messages: [], temperature: 0.2, stream: true } },
    { seq: 1, turn: 1, type: 'llm_response', raw: raw('A'), content: 'A', latencyMs: 1 },
  ].map(l => JSON.stringify(l)).join('\n') + '\n')
  const fake = fakeFile(cwd, [{ raw: raw('A'), usage: { promptTokens: 7, completionTokens: 1 } }, { raw: raw('B') }, { raw: raw('A') }])
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
  const fake = fakeFile(wd, [{ content: '{"1":"KEEP"}' }])
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
  const fake = fakeFile(wd, [{ content: '{}' }])
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

test('proxy records until SIGINT or SIGTERM, then exits 0 with done appended', async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const up = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) })
    })
    await listen(up)
    const cwd = tmpSync('lhb-cwd-')
    const p = spawnCli(['proxy', '--upstream', `http://127.0.0.1:${(up.address() as { port: number }).port}`, '--port', '0', '--name', 'cli'], { cwd })
    let err = ''
    const port = await new Promise<number>(done => p.stderr.on('data', (b: Buffer) => { err += b; const m = /proxy on http:\/\/127\.0\.0\.1:(\d+)\/v1/.exec(err); if (m) done(Number(m[1])) }))
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hello' }] }) })
    expect(await r.text()).toContain('"hi"')
    const code = await new Promise(done => { p.on('exit', done); p.kill(signal) })
    up.close()
    expect(code).toBe(0)
    const files = await readdir(join(cwd, 'runs'))
    expect(files).toEqual([expect.stringMatching(/^[0-9a-f]{8}\.jsonl$/)])
    const lines = (await readFile(join(cwd, 'runs', files[0]), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
    expect(lines[0].meta).toMatchObject({ harness: 'cli', task: 'hello', workdir: '' })
    expect(lines.slice(1).map(l => l.type)).toEqual(['llm_request', 'llm_response', 'done'])
    expect(err).toContain(`run ${files[0].slice(0, 8)}: hello`)
    expect(err).toContain(`ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`)
  }
}, 60_000)

test('a second SIGINT while proxy is stopping force-exits 130, not the graceful 0', async () => {
  const up = http.createServer(req => { req.resume() }) // accepts, never answers: every request stays in flight until aborted
  await listen(up)
  const cwd = tmpSync('lhb-cwd-')
  const p = spawnCli(['proxy', '--upstream', `http://127.0.0.1:${(up.address() as { port: number }).port}`, '--port', '0', '--name', 'cli'], { cwd })
  let err = ''
  const port = await new Promise<number>(done => p.stderr.on('data', (b: Buffer) => { err += b; const m = /proxy on http:\/\/127\.0\.0\.1:(\d+)\/v1/.exec(err); if (m) done(Number(m[1])) }))
  // Many requests of the same session: on the first signal, aborting and recording every one of
  // them chains through one run's trace file, which keeps stop() busy long enough for a second
  // signal to land while `stopping` is still true.
  const body = JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hello' }] })
  const inflight = Array.from({ length: 80 }, () => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body }).catch(() => {}))
  await new Promise(r => setTimeout(r, 100)) // let every request reach the proxy and be forwarded to the (silent) upstream
  const code = await new Promise(done => {
    p.on('exit', done)
    p.kill('SIGINT')
    setTimeout(() => p.kill('SIGINT'), 5)
  })
  await Promise.allSettled(inflight)
  up.close()
  expect(code).toBe(130)
}, 30_000)

test('proxy wants the server root, not its /v1', () => {
  const r = cli(['proxy', '--upstream', 'http://127.0.0.1:8080/v1'])
  expect(r.status).toBe(2)
  expect(r.stderr).toMatch(/server root/); expect(r.stderr).toContain('http://127.0.0.1:8080')
}, 30_000)

test('replay reads a trace whose last line is half-written', async () => {
  const wd = await tmp('lhb-cli-')
  const trace = join(wd, 't.jsonl')
  const reply = { choices: [{ message: { content: 'hi' } }] }
  await writeFile(trace, [
    JSON.stringify({ meta: { id: 't', harness: 'p', task: 'x', workdir: '', started: 1 } }),
    JSON.stringify({ seq: 0, turn: 1, ts: 1, type: 'llm_request', payload: { model: 'm', messages: [] } }),
    JSON.stringify({ seq: 1, turn: 1, ts: 2, type: 'llm_response', raw: reply, content: 'hi', latencyMs: 1 }),
    '{"seq":2,"turn":2,"ts":',
  ].join('\n'))
  const fake = fakeFile(wd, [{ content: 'hi', raw: reply }])
  const r = cli(['replay', trace, '--turn', '1', '--base-url', 'http://x', '--kind', 'openai', '--n', '1'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0); expect(r.stdout).toMatch(/1x same as recorded/)
}, 30_000)

test('replay of a recorded Anthropic request is refused as not yet supported', async () => {
  const wd = await tmp('lhb-cli-')
  const trace = join(wd, 't.jsonl')
  await writeFile(trace, [
    JSON.stringify({ meta: { id: 't', harness: 'p', task: 'x', workdir: '', started: 1 } }),
    JSON.stringify({ seq: 0, turn: 1, ts: 1, type: 'llm_request', payload: { model: 'm', max_tokens: 5, system: 'S', messages: [{ role: 'user', content: 'U' }] } }),
  ].join('\n'))
  const r = cli(['replay', trace, '--turn', '1', '--base-url', 'http://x', '--kind', 'openai', '--n', '1'])
  expect(r.status).toBe(2); expect(r.stderr).toContain('not yet')
}, 30_000)

const ev = (o: object) => JSON.stringify(o)
/** A tiny trace: one failed and one good edit, a stub at turn 3 of the read from turn 1. */
function analyzeFixture(dir: string, id: string, done = true) {
  const lines = [
    ev({ meta: { id, harness: 'tuned-budget', task: 't', workdir: '/w', started: 1 } }),
    ev({ seq: 0, turn: 1, ts: 0, type: 'llm_request', payload: { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'do' }] } }),
    ev({ seq: 1, turn: 1, ts: 0, type: 'tool_call', call: { callId: 'c1', name: 'read_file', args: { path: 'a.txt' } } }),
    ev({ seq: 2, turn: 1, ts: 0, type: 'tool_result', callId: 'c1', name: 'read_file', output: 'AAAA' }),
    ev({ seq: 3, turn: 2, ts: 0, type: 'llm_request', payload: { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'do' }, { role: 'assistant', content: '' }, { role: 'tool', content: 'AAAA' }] } }),
    ev({ seq: 4, turn: 2, ts: 0, type: 'tool_call', call: { callId: 'c2', name: 'edit_file', args: { path: 'a.txt' } } }),
    ev({ seq: 5, turn: 2, ts: 0, type: 'tool_result', callId: 'c2', name: 'edit_file', output: 'edited a.txt' }),
    ev({ seq: 6, turn: 3, ts: 0, type: 'context_stats', estimatedTokens: 9, budgetTokens: 5, droppedChars: 4 }),
    ev({ seq: 7, turn: 3, ts: 0, type: 'llm_request', payload: { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'do' }, { role: 'assistant', content: '' }, { role: 'tool', content: '[dropped: 4 chars]' }, { role: 'assistant', content: '' }, { role: 'tool', content: 'edited a.txt' }] } }),
    ...(done ? [ev({ seq: 8, turn: 3, ts: 0, type: 'done', reason: 'final', turns: 3, toolCallCount: 2 })] : []),
  ]
  writeFileSync(join(dir, `${id}.jsonl${done ? '' : '.part'}`), lines.join('\n') + '\n')
}

test('analyze <run-id> prints one row: stub t3 ate the read, first edit t2', () => {
  const cwd = tmpSync('lhb-an-'); mkdirSync(join(cwd, 'runs')); analyzeFixture(join(cwd, 'runs'), 'abcd0001')
  const r = cli(['analyze', 'abcd0001'], {}, cwd)
  expect(r.status).toBe(0)
  const [head, row] = r.stdout.trim().split('\n')
  expect(head).toMatch(/^harness\s+run\s+verdict/)
  expect(row).toMatch(/^tuned-budget\s+abcd0001\s+final\s+3\s+t3\s+read_file a\.txt\s+t2\s+—\s+—\s+0 s$/)
})

test('analyze <bench.json> reads verdicts from the JSON and traces next to it; a run with no trace is a row', () => {
  const cwd = tmpSync('lhb-an-'); const runs = join(cwd, 'runs'); mkdirSync(runs); analyzeFixture(runs, 'abcd0002')
  const run = (trace?: string) => ({ round: 1, verdict: 'PASS', reason: 'final', turns: 3, toolCalls: 2, parseErrors: 0, ms: 1, workdir: '/w', ...(trace ? { trace } : {}) })
  writeFileSync(join(runs, 'bench-x.json'), JSON.stringify({ version: 1, date: '2026-10-10T00:00:00Z', task: 't', n: 2, timeoutS: 1, complete: true,
    harnesses: [{ name: 'tuned-budget', config: {}, pass: 2, reasons: {}, median: { turns: 3, toolCalls: 2, ms: 1 }, runs: [run('abcd0002'), run()] }] }))
  const r = cli(['analyze', 'runs/bench-x.json'], {}, cwd)
  expect(r.status).toBe(0)
  const rows = r.stdout.trim().split('\n').slice(1)
  expect(rows[0]).toMatch(/^tuned-budget\s+abcd0002\s+PASS final\s+3\s+t3/)
  expect(rows[1]).toContain('no trace')
})

test('analyze takes a killed run by its .part path; --json gives the full analysis', () => {
  const cwd = tmpSync('lhb-an-'); mkdirSync(join(cwd, 'runs')); analyzeFixture(join(cwd, 'runs'), 'abcd0003', false)
  const r = cli(['analyze', 'runs/abcd0003.jsonl.part', '--json'], {}, cwd)
  expect(r.status).toBe(0)
  const [row] = JSON.parse(r.stdout)
  expect(row).toMatchObject({ run: 'abcd0003', verdict: '—', analysis: { firstEdit: 2, stubs: [{ turn: 3, status: 'matched', items: [{ callId: 'c1', what: 'read_file a.txt' }] }] } })
  expect(row.analysis.done).toBeUndefined()
})

test('analyze with no argument or an unknown id exits 2 with a message', () => {
  expect(cli(['analyze']).status).toBe(2)
  const r = cli(['analyze', 'nope0000'])
  expect(r.status).toBe(2)
  expect(r.stderr).toMatch(/^cannot analyze nope0000:/)
})

// Final review, Important 3: `bench --out elsewhere/b.json` writes the JSON there but the traces to runs/.
test('analyze finds the traces of a bench JSON written with --out outside runs/', () => {
  const cwd = tmpSync('lhb-an-'); mkdirSync(join(cwd, 'runs')); mkdirSync(join(cwd, 'results')); analyzeFixture(join(cwd, 'runs'), 'abcd0004')
  const run = { round: 1, verdict: 'PASS', reason: 'final', turns: 3, toolCalls: 2, parseErrors: 0, ms: 1, workdir: '/w', trace: 'abcd0004' }
  writeFileSync(join(cwd, 'results', 'b.json'), JSON.stringify({ version: 1, date: '2026-10-10T00:00:00Z', task: 't', n: 1, timeoutS: 1, complete: true,
    harnesses: [{ name: 'h', config: {}, pass: 1, reasons: {}, median: { turns: 3, toolCalls: 2, ms: 1 }, runs: [run] }] }))
  const r = cli(['analyze', 'results/b.json'], {}, cwd)
  expect(r.status).toBe(0)
  expect(r.stdout).toMatch(/abcd0004\s+PASS final\s+3\s+t3/)
})

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const COMMAND_NAMES = ['serve', 'run', 'demo', 'bench', 'replay', 'analyze', 'proxy']

test('--help, -h and help print the overview on stdout and exit 0', () => {
  for (const f of ['--help', '-h', 'help']) {
    const r = cli([f])
    expect([f, r.status]).toEqual([f, 0])
    expect(r.stdout.split('\n')[0]).toBe(pkg.description)
    for (const n of COMMAND_NAMES) expect(r.stdout).toMatch(new RegExp(`^  ${n} `, 'm'))
  }
}, 60_000)

test('<command> --help, -h and help <command> print that command\'s help and do nothing else', () => {
  for (const n of COMMAND_NAMES) for (const args of [[n, '--help'], [n, '-h'], ['help', n]]) {
    const r = cli(args)
    expect([args, r.status]).toEqual([args, 0])
    expect(r.stdout.split('\n')[0]).toMatch(new RegExp(`^usage: llm-harness-builder ${n}\\b`))
    expect(existsSync(join(r.cwd, 'harnesses'))).toBe(false)
    expect(existsSync(join(r.cwd, 'runs'))).toBe(false)
  }
}, 120_000)

test('--help wins over the other arguments of a command', async () => {
  const wd = await tmp('lhb-cli-')
  for (const args of [['run', harness('bare'), '--workdir', wd, 'task', '--help'], ['bench', '--n', '0', '--help'], ['serve', '--help', '--port', '1']]) {
    const r = cli(args)
    expect([args, r.status]).toEqual([args, 0])
    expect(r.stdout).toMatch(/^usage: llm-harness-builder /)
    expect(existsSync(join(r.cwd, 'runs'))).toBe(false)
    expect(existsSync(join(r.cwd, 'harnesses'))).toBe(false)
  }
}, 60_000)

test('--version and -v print the package version', () => {
  for (const f of ['--version', '-v']) {
    const r = cli([f])
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(pkg.version)
  }
}, 30_000)

test('an unknown command, Object.prototype names included, is an error with the overview, not a stack', () => {
  for (const c of ['foo', 'toString', '__proto__', 'constructor']) {
    const r = cli([c])
    expect([c, r.status]).toEqual([c, 2])
    expect(r.stderr).toContain(`error: unknown command "${c}"`)
    expect(r.stderr).toContain(pkg.description)
    expect(r.stderr).not.toMatch(/^\s+at /m)
  }
  const h = cli(['help', 'foo'])
  expect(h.status).toBe(2)
  expect(h.stderr).toContain('error: unknown command "foo"')
}, 60_000)

test('argument errors name the option, show the usage, exit 2 and print no stack', () => {
  const cases: [string[], RegExp][] = [
    // every command goes through the same catch; each one is still tried
    ...COMMAND_NAMES.map((n): [string[], RegExp] => [[n, '--nope'], /^error: Unknown option '--nope'/m]),
    [['run'], /^error: run needs a harness file and a task$/m],
    [['serve', 'foo'], /^error: Unexpected argument 'foo'/m],
    [['demo', 'foo'], /^error: Unexpected argument 'foo'/m],
    [['serve', '--port', 'abc'], /^error: --port must be an integer from 0 to 65535$/m],
    [['serve', '--port', '70000'], /^error: --port must be an integer from 0 to 65535$/m],
    // Node's own message for a value that starts with a dash runs over three lines; it is still one line here
    [['serve', '--port', '-1'], /^error: Option '--port' argument is ambiguous\./m],
    [['bench', '--n', 'x'], /^error: --n must be a positive integer$/m],
    [['bench', '--timeout', '0'], /^error: --timeout must be a positive integer$/m],
    [['bench', '--task', 'nope'], /^error: --task must be one of slug\|pool\|pool2\|pool3\|sift\|triage\|judge\|polyglot$/m],
    [['bench', '--task', 'polyglot'], /^error: --size must be an integer from 1 to 47 for polyglot$/m],
    [['bench', '--task', 'polyglot', '--size', '0'], /^error: --size must be an integer from 1 to 47 for polyglot$/m],
    [['bench', '--task', 'polyglot', '--size', '49'], /^error: --size must be an integer from 1 to 47 for polyglot$/m],
    [['bench', '--task', 'slug', '--size', '3'], /^error: --size: slug has no sizes$/m],
    [['evolve', 'h.json'], /^error: evolve needs --tasks <repo> or --task polyglot, with --mode hours, night or days$/m],
    [['evolve', 'h.json', '--task', 'polyglot', '--size', '2'], /^error: --size must be an integer from 3 to 47 for evolve --task polyglot$/m],
    [['evolve', 'h.json', '--task', 'polyglot', '--size', '48'], /^error: --size must be an integer from 3 to 47 for evolve --task polyglot$/m],
    [['evolve', 'h.json', '--task', 'pool', '--size', '3'], /^error: evolve takes --task polyglot only; your own tasks go in --tasks <repo>$/m],
    [['evolve', 'h.json', '--task', 'polyglot', '--size', '3', '--tasks', 'x'], /^error: --tasks cannot go with --task or --size$/m],
    [['evolve', 'h.json', '--tasks', 'x', '--only', 'a'], /^error: --only is for bench: /m],
    [['bench', '--max-turns', '1.5'], /^error: --max-turns must be a positive integer$/m],
    [['replay', 'x.jsonl', '--turn', '0', '--kind', 'openai', '--base-url', 'http://x'], /^error: --turn must be a positive integer$/m],
    [['replay', 'x.jsonl', '--turn', '1', '--kind', 'anthropic', '--base-url', 'http://x'], /^error: --kind anthropic is not yet supported by replay$/m],
    [['replay', 'x.jsonl', '--turn', '1', '--kind', 'vllm', '--base-url', 'http://x'], /^error: --kind must be openai or ollama$/m],
    [['replay', 'x.jsonl', '--turn', '1', '--kind', 'openai', '--base-url', 'x'], /^error: --base-url must be an http\(s\) URL$/m],
    [['analyze'], /^error: analyze needs at least one bench JSON, run id or trace file$/m],
    [['proxy', 'extra'], /^error: proxy takes no positional arguments$/m],
    [['proxy', '--port', 'x'], /^error: --port must be an integer from 0 to 65535$/m],
    [['proxy', '--upstream', 'https://u:p@api.example.com'], /^error: --upstream must not carry a login or password$/m],
    [['proxy', '--upstream', 'https://api.example.com?k=1'], /^error: --upstream must not carry a query or fragment$/m],
    [['proxy', '--upstream', 'http://user:@evil.com'], /^error: --upstream must not carry a login or password$/m],
    [['proxy', '--upstream', 'http://127.0.0.1@evil.com'], /^error: --upstream must not carry a login or password$/m],
    [['proxy', '--upstream', 'https://a.com#f'], /^error: --upstream must not carry a query or fragment$/m],
    [['proxy', '--upstream', 'https://a.com?'], /^error: --upstream must not carry a query or fragment$/m],
    [['proxy', '--upstream', 'http://api.example.com'], /^error: --upstream over http must be a loopback address; use https$/m],
  ]
  for (const [args, message] of cases) {
    const r = cli(args)
    expect([args, r.status]).toEqual([args, 2])
    expect([args, r.stderr]).toEqual([args, expect.stringMatching(message)])
    // the message is one line and the usage is the very next one: a message that runs over several lines does not pass
    expect([args, r.stderr]).toEqual([args, expect.stringMatching(new RegExp(`^error: [^\n]+\nusage: llm-harness-builder ${args[0]}\\b`, 'm'))])
    expect(r.stderr).not.toMatch(/^\s+at /m)
  }
}, 120_000)

test('serve --port 0 listens on a free port and says which', async () => {
  const cwd = tmpSync('lhb-cwd-')
  const p = spawnCli(['serve', '--no-open', '--port', '0'], { cwd })
  try {
    const port = await new Promise<number>((done, fail) => {
      let err = ''
      p.stderr.on('data', (b: Buffer) => { err += b; const m = /serving on http:\/\/localhost:(\d+)/.exec(err); if (m) done(Number(m[1])) })
      p.on('exit', code => fail(new Error(`serve exited ${code}: ${err}`)))
    })
    expect(port).toBeGreaterThan(0)
    expect((await fetch(`http://127.0.0.1:${port}/api/harnesses`)).status).toBe(200)
  } finally { p.kill() }
}, 30_000)

const hasPython = spawnSync('python3', ['--version']).status === 0
/** The CLI in a real terminal (a pty), with keystrokes played in; returns what it printed and its exit code. */
function inTerminal(steps: object[], args: string[], env: Record<string, string>, cwd: string) {
  const stepsFile = join(cwd, 'steps.json')
  writeFileSync(stepsFile, JSON.stringify(steps))
  const r = spawnSync('python3', [join(ROOT, 'tests', 'fixtures', 'pty-run.py'), stepsFile, join(ROOT, 'node_modules', '.bin', 'tsx'), join(ROOT, 'src', 'cli.ts'), ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  const m = /\nEXIT (-?\d+)\n$/.exec(r.stdout)
  return { out: r.stdout, code: m ? Number(m[1]) : NaN }
}

test.skipIf(!hasPython)('in a terminal, Ctrl-C while the model works keeps the trace and exits 130', async () => {
  const wd = await tmp('lhb-cli-'), cwd = tmpSync('lhb-cwd-')
  const fake = fakeFile(wd, [{ toolCalls: [{ name: 'bash', args: { command: 'sleep 5' } }] }, { content: 'fin' }])
  const r = inTerminal([{ after: '[y/N]', send: 'y\r' }, { delay: 1, send: '\u0003' }], ['run', harness('bare'), '--workdir', wd, 'x'], { LHB_FAKE_BACKEND: fake }, cwd)
  expect(r.code, r.out).toBe(130)
  expect(r.out).not.toContain('done: final')
  expect(await readdir(join(cwd, 'runs'))).toEqual([expect.stringMatching(/^[0-9a-f]{8}\.jsonl$/)])
}, 30_000)

test.skipIf(!hasPython)('in a terminal, Ctrl-C at the approval prompt exits 130 with no stack and keeps the trace', async () => {
  const wd = await tmp('lhb-cli-'), cwd = tmpSync('lhb-cwd-')
  const fake = fakeFile(wd, [{ toolCalls: [{ name: 'bash', args: { command: 'echo hi' } }] }])
  const r = inTerminal([{ after: '[y/N]', send: '\u0003' }], ['run', harness('bare'), '--workdir', wd, 'x'], { LHB_FAKE_BACKEND: fake }, cwd)
  expect(r.code, r.out).toBe(130)
  expect(r.out).toContain('run bash: "echo hi"')
  expect(r.out).not.toMatch(/AbortError|^\s+at /m)
  expect(await readdir(join(cwd, 'runs'))).toEqual([expect.stringMatching(/^[0-9a-f]{8}\.jsonl$/)])
}, 30_000)

test.skipIf(!hasPython)('in a terminal, answering n denies the call: it does not run, and the run goes on to its end', async () => {
  const wd = await tmp('lhb-cli-'), cwd = tmpSync('lhb-cwd-')
  const fake = fakeFile(wd, [{ toolCalls: [{ name: 'bash', args: { command: 'touch ran.txt' } }] }, { content: 'fin' }])
  const r = inTerminal([{ after: '[y/N]', send: 'n\r' }], ['run', harness('bare'), '--workdir', wd, 'x'], { LHB_FAKE_BACKEND: fake }, cwd)
  expect(r.code, r.out).toBe(0)
  expect(r.out).toContain('denied by user')
  expect(r.out).toContain('done: final')
  expect(existsSync(join(wd, 'ran.txt'))).toBe(false)
  expect(await readdir(join(cwd, 'runs'))).toEqual([expect.stringMatching(/^[0-9a-f]{8}\.jsonl$/)])
}, 30_000)

// Why one readline for the whole run: with one per question, a line typed while the model works waits in the
// terminal and answers the next question, which its typist has not seen yet.
test.skipIf(!hasPython)('in a terminal, a line typed while the model works does not answer the next question', async () => {
  const wd = await tmp('lhb-cli-'), cwd = tmpSync('lhb-cwd-')
  const fake = fakeFile(wd, [
    { toolCalls: [{ name: 'bash', args: { command: 'sleep 2' } }] },
    { toolCalls: [{ name: 'bash', args: { command: 'touch second.txt' } }] },
    { content: 'fin' },
  ])
  const r = inTerminal([
    { after: '[y/N]', send: 'y\r' },                            // the first question: run sleep 2
    { delay: 0.7, send: 'y\r' },                                // typed ahead, while it runs
    { after: 'run bash: "touch second.txt"', send: 'n\r' },     // the second question, answered once it is on the screen
  ], ['run', harness('bare'), '--workdir', wd, 'x'], { LHB_FAKE_BACKEND: fake }, cwd)
  expect(r.code, r.out).toBe(0)
  expect(r.out).toContain('denied by user')
  expect(existsSync(join(wd, 'second.txt'))).toBe(false)
}, 30_000)

test.skipIf(!hasPython)('in a terminal, Ctrl-D at the approval prompt ends the run like Ctrl-C: exit 130, the trace kept, no stack', async () => {
  const wd = await tmp('lhb-cli-'), cwd = tmpSync('lhb-cwd-')
  const fake = fakeFile(wd, [{ toolCalls: [{ name: 'bash', args: { command: 'touch ran.txt' } }] }])
  const r = inTerminal([{ after: '[y/N]', send: '\u0004' }], ['run', harness('bare'), '--workdir', wd, 'x'], { LHB_FAKE_BACKEND: fake }, cwd)
  expect(r.code, r.out).toBe(130)
  expect(r.out).not.toMatch(/AbortError|ERR_USE_AFTER_CLOSE|^\s+at /m)
  expect(existsSync(join(wd, 'ran.txt'))).toBe(false)
  expect(await readdir(join(cwd, 'runs'))).toEqual([expect.stringMatching(/^[0-9a-f]{8}\.jsonl$/)])
}, 30_000)

test.skipIf(!hasPython)('in a terminal, Ctrl-D while the model works closes the input: the next question ends the run like Ctrl-C', async () => {
  const wd = await tmp('lhb-cli-'), cwd = tmpSync('lhb-cwd-')
  const fake = fakeFile(wd, [
    { toolCalls: [{ name: 'bash', args: { command: 'sleep 2' } }] },
    { toolCalls: [{ name: 'bash', args: { command: 'touch second.txt' } }] },
    { content: 'fin' },
  ])
  const r = inTerminal([{ after: '[y/N]', send: 'y\r' }, { delay: 0.7, send: '\u0004' }], ['run', harness('bare'), '--workdir', wd, 'x'], { LHB_FAKE_BACKEND: fake }, cwd)
  expect(r.code, r.out).toBe(130)
  expect(r.out).not.toMatch(/AbortError|ERR_USE_AFTER_CLOSE|^\s+at /m)
  expect(existsSync(join(wd, 'second.txt'))).toBe(false)
  expect(await readdir(join(cwd, 'runs'))).toEqual([expect.stringMatching(/^[0-9a-f]{8}\.jsonl$/)])
}, 30_000)

// ESC [ 8 m hides everything after it until an attribute reset: if what the model read were printed as it is, the
// question that follows could be written in the screen's own colour.
test.skipIf(!hasPython)('in a terminal, a file the model read cannot hide the question: its escapes are shown as text, and the question starts with an attribute reset', async () => {
  const wd = await tmp('lhb-cli-'), cwd = tmpSync('lhb-cwd-'), fake = join(wd, 'fake.json')
  await writeFile(join(wd, 'evil.txt'), '\u001b[8mhidden')
  await writeFile(fake, JSON.stringify([
    { toolCalls: [{ name: 'read_file', args: { path: 'evil.txt' } }] },
    { toolCalls: [{ name: 'bash', args: { command: 'echo hi' } }] },
    { content: 'fin' },
  ]))
  const r = inTerminal([{ after: '[y/N]', send: 'n\r' }], ['run', harness('bare'), '--workdir', wd, 'x'], { LHB_FAKE_BACKEND: fake }, cwd)
  expect(r.code, r.out).toBe(0)
  // the six characters of the escape and the rest of the sequence, as text
  expect(r.out).toContain('tool_result read_file: \\u001b[8mhidden')
  expect(r.out).not.toContain('\u001b[8m')
  // the reset is the last thing written before the question
  expect(r.out).toContain('\u001b[0mrun bash: "echo hi"')
  expect(r.out).toContain('denied by user')
}, 30_000)

test.skipIf(!hasPython)('in a terminal, the live text is escaped too: a reply streamed in cannot send a control sequence', async () => {
  const wd = await tmp('lhb-cli-'), cwd = tmpSync('lhb-cwd-')
  const fake = fakeFile(wd, [{ content: 'fin', deltas: [{ reasoning: 'hm\u001b[8m' }, { content: 'fi\u001b[2K' }, { content: 'n\u009b1G\u202e\nline two\ttab' }] }])
  const r = inTerminal([], ['run', harness('bare'), '--workdir', wd, 'x'], { LHB_FAKE_BACKEND: fake }, cwd)
  expect(r.code, r.out).toBe(0)
  const out = r.out.replaceAll('\r\n', '\n') // the terminal turns every newline into a carriage return and a newline
  // the reasoning is dim, with the dim and the reset the CLI writes itself around the escaped text
  expect(out).toContain('\u001b[2mhm\\u001b[8m\u001b[0m')
  // the content: escaped, its line and its tab kept
  expect(out).toContain('fi\\u001b[2Kn\\u009b1G\\u202e\nline two\ttab')
  for (const raw of ['\u001b[8m', '\u001b[2K', '\u009b', '\u202e']) expect(out).not.toContain(raw)
}, 30_000)

const NO_TTY = 'stdin is not a terminal, so nothing can answer an approval prompt: pass --yes to approve every command, or run in a terminal'
function refusedCleanly(r: { status: number | null; stderr: string; cwd: string }) {
  expect(r.status).toBe(2)
  expect(r.stderr).toContain(NO_TTY)
  expect(r.stderr).not.toContain('llm_request')
  expect(r.stderr).not.toContain('no more responses')
  expect(r.stderr).not.toMatch(/^\s+at /m)
  expect(existsSync(join(r.cwd, 'runs'))).toBe(false)
}

test('run without --yes and without a terminal stops before the trace and the first request when it may ask', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = fakeFile(wd, [])
  const plain = JSON.parse(await readFile(harness('bare'), 'utf8'))
  const untilOnly = join(wd, 'until.json'), mcpOnly = join(wd, 'mcp.json')
  await writeFile(untilOnly, JSON.stringify({ ...plain, tools: { enabled: ['read_file'], approveBash: false }, loop: { ...plain.loop, untilBash: 'true' } }))
  await writeFile(mcpOnly, JSON.stringify({ ...plain, tools: { enabled: ['read_file'], approveBash: false }, mcpServers: { s: { command: process.execPath, args: [join(ROOT, 'tests', 'fixtures', 'mcp-server.mjs')] } } }))
  // stdin an empty pipe (EOF), as spawnSync gives it
  for (const h of [harness('bare'), untilOnly, mcpOnly]) refusedCleanly(cli(['run', h, '--workdir', wd, 'x'], { LHB_FAKE_BACKEND: fake }))
  // stdin /dev/null
  const cwd = tmpSync('lhb-cwd-')
  const ignored = spawnCliSync(['run', harness('bare'), '--workdir', wd, 'x'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LHB_FAKE_BACKEND: fake } })
  refusedCleanly({ ...ignored, cwd })
}, 60_000)

test('run without a terminal whose stdin stays open does not wait for an answer that cannot come', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = fakeFile(wd, [])
  const cwd = tmpSync('lhb-cwd-')
  const p = spawnCli(['run', harness('bare'), '--workdir', wd, 'x'],
    { cwd, env: { ...process.env, LHB_FAKE_BACKEND: fake } })
  try {
    let stderr = ''
    p.stderr.on('data', (b: Buffer) => { stderr += b })
    // 'close', not 'exit': it comes after the last byte of stderr has been read. stdin is never written nor closed.
    // The wait ends by itself before the test's own timeout, so that a refusal that regressed to waiting does not leave the CLI running.
    const status = await new Promise<number | null>((done, fail) => {
      p.on('close', done)
      setTimeout(() => fail(new Error(`the CLI was still running after 20 s; stderr so far: ${stderr}`)), 20_000).unref()
    })
    refusedCleanly({ status, stderr, cwd })
  } finally { p.kill() }
}, 30_000)

test('run without a terminal goes on when the harness cannot ask (curator-judge: approveBash without bash)', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = fakeFile(wd, [{ content: 'fin' }])
  const r = cli(['run', harness('curator-judge'), '--workdir', wd, 'judge'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  expect(r.stderr).not.toContain('stdin is not a terminal')
}, 30_000)

const KEY_NAME = 'LHB_CLI_TEST_API_KEY', KEY = 'sk-or-v1-' + 'c4'.repeat(16), MARK = `[redacted: ${KEY_NAME}]`
/** `bare` on a hosted backend whose bash gets the key: the run the key could leak from. */
async function keyedHarness(dir: string, baseUrl: string) {
  const plain = JSON.parse(await readFile(harness('bare'), 'utf8'))
  const file = join(dir, 'keyed.json')
  await writeFile(file, JSON.stringify({ ...plain, backend: { kind: 'openai', baseUrl, model: 'fake/model', temperature: 0, apiKeyEnv: KEY_NAME }, tools: { ...plain.tools, approveBash: false, bashEnv: [KEY_NAME] } }))
  return file
}
/** Every file under `dir`, as one string: what a search of the run files for the key would see. */
function allText(dir: string): string {
  if (!existsSync(dir)) return ''
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile()).map(d => readFileSync(join(d.parentPath, d.name), 'utf8')).join('\n')
}

test('run against a hosted API: the bearer token reaches it, nothing else is asked, the key goes back nowhere and sits in no file', async () => {
  const api = await fakeOpenAI([toolTurn('bash', { command: `printf %s "$${KEY_NAME}"` }), textTurn('done')])
  try {
    const wd = await tmp('lhb-cli-'), file = await keyedHarness(wd, api.baseUrl)
    const r = await cliAsync(['run', file, '--workdir', wd, '--yes', 'go'], { [KEY_NAME]: KEY })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain(`the key in ${KEY_NAME} goes to ${new URL(api.baseUrl).host}`)
    expect(api.seen.map(s => `${s.method} ${s.path}`)).toEqual(['GET /v1/models', 'POST /v1/chat/completions', 'POST /v1/chat/completions'])
    expect(api.seen.every(s => s.headers.authorization === `Bearer ${KEY}`)).toBe(true)
    expect(api.seen[2].body).toContain(MARK); expect(api.seen[2].body).not.toContain(KEY)
    const runs = allText(join(r.cwd, 'runs'))
    expect(runs).toContain(MARK); expect(runs).not.toContain(KEY)
    expect(r.stderr).not.toContain(KEY)
  } finally { await api.close() }
}, 30_000)

/** `bare` on the Anthropic API, priced, with the key in bash's environment. */
async function claudeHarness(dir: string, baseUrl: string) {
  const file = await keyedHarness(dir, baseUrl), h = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...h, backend: { kind: 'anthropic', baseUrl, model: 'claude-haiku-5-5', temperature: 0, maxTokens: 1024, apiKeyEnv: KEY_NAME, pricePerMTok: { input: 0.1, output: 0.5 } } }))
  return file
}

test('run against the Anthropic API: x-api-key reaches it, the run ends final, the key sits in no file and not on stderr', async () => {
  const api = await fakeAnthropic([toolReply('bash', { command: `printf %s "$${KEY_NAME}"` }), textReply('done')])
  try {
    const wd = await tmp('lhb-cli-'), file = await claudeHarness(wd, api.baseUrl)
    const r = await cliAsync(['run', file, '--workdir', wd, '--yes', 'go'], { [KEY_NAME]: KEY })
    expect(r.status).toBe(0)
    expect(api.seen.map(s => `${s.method} ${s.path}`)).toEqual(['GET /v1/models/claude-haiku-5-5', 'POST /v1/messages', 'POST /v1/messages'])
    // the harness's temperature stays in the file and is not sent: no model on this API takes one
    expect(r.stderr).toContain('temperature 0 not sent: claude-haiku-5-5 takes no temperature (Anthropic API 2026-10-21)\n')
    expect(api.seen[1].body).not.toContain('temperature')
    expect(api.seen.every(s => s.headers['x-api-key'] === KEY && s.headers.authorization === undefined)).toBe(true)
    expect(api.seen[2].body).toContain(MARK); expect(api.seen[2].body).not.toContain(KEY)
    const runs = allText(join(r.cwd, 'runs'))
    expect(runs).toContain('"reason":"final"')
    expect(runs).toContain(MARK); expect(runs).not.toContain(KEY)
    expect(r.stderr).not.toContain(KEY)
  } finally { await api.close() }
}, 30_000)

test('bench against the Anthropic API: preflight asks the model, the window is its max_input_tokens, a med $ column, no key in any file', async () => {
  const api = await fakeAnthropic([textReply('done')])
  try {
    const wd = await tmp('lhb-cli-'), file = await claudeHarness(wd, api.baseUrl), out = join(wd, 'b.json')
    const r = await cliAsync(['bench', '--n', '1', '--out', out, file], { [KEY_NAME]: KEY })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('window 200000')
    expect(r.stdout).toContain('med $')
    expect(api.seen.slice(0, 2).map(s => `${s.method} ${s.path}`)).toEqual(['GET /v1/models', 'GET /v1/models/claude-haiku-5-5'])
    expect(api.seen.every(s => s.headers['x-api-key'] === KEY)).toBe(true)
    expect(allText(wd) + allText(join(r.cwd, 'runs')) + r.stderr + r.stdout).not.toContain(KEY)
  } finally { await api.close() }
}, 60_000)

test('bench against the Anthropic API: an error the server words with a terminal escape is printed escaped', async () => {
  const srv = http.createServer((_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad \x1b[31mred' } })) })
  await listen(srv)
  try {
    const wd = await tmp('lhb-cli-'), file = await claudeHarness(wd, `http://127.0.0.1:${(srv.address() as AddressInfo).port}`)
    const r = await cliAsync(['bench', '--n', '1', '--out', join(wd, 'b.json'), file], { [KEY_NAME]: KEY })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('GET /v1/models: 400 invalid_request_error: bad \\u001b[31mred')
    expect(r.stderr).not.toContain('\x1b')
  } finally { await new Promise<void>(r => { srv.closeAllConnections(); srv.close(() => r()) }) }
}, 30_000)

test('a key typed into the task is redacted in the trace\'s first line', async () => {
  const api = await fakeOpenAI([textTurn('done')])
  try {
    const wd = await tmp('lhb-cli-'), file = await keyedHarness(wd, api.baseUrl)
    const r = await cliAsync(['run', file, '--workdir', wd, '--yes', `use ${KEY}`], { [KEY_NAME]: KEY })
    expect(r.status).toBe(0)
    const runs = join(r.cwd, 'runs'), [trace] = readdirSync(runs)
    const first = (await readFile(join(runs, trace), 'utf8')).split('\n')[0]
    expect(first).toContain(MARK); expect(first).not.toContain(KEY)
    expect(JSON.parse(first).meta.task).toBe(`use ${MARK}`)
  } finally { await api.close() }
}, 30_000)

test('bench against a hosted API: the start line before preflight, /models asked with the key, the window the smaller one, no key in any file', async () => {
  const api = await fakeOpenAI([textTurn('done')], [{ id: 'fake/model', context_length: 50000, top_provider: { context_length: 40000 } }])
  try {
    const wd = await tmp('lhb-cli-'), file = await keyedHarness(wd, api.baseUrl), out = join(wd, 'b.json')
    const r = await cliAsync(['bench', '--n', '1', '--out', out, file], { [KEY_NAME]: KEY })
    expect(r.status).toBe(0)
    const note = r.stderr.indexOf(`the key in ${KEY_NAME} goes to`), pre = r.stderr.indexOf('preflight: ')
    expect(note).toBeGreaterThanOrEqual(0); expect(pre).toBeGreaterThan(note)
    expect(r.stderr).toContain('window 40000')
    expect(api.seen[0]).toMatchObject({ method: 'GET', path: '/v1/models' })
    expect(api.seen.every(s => s.headers.authorization === `Bearer ${KEY}`)).toBe(true)
    expect(allText(wd) + allText(join(r.cwd, 'runs'))).not.toContain(KEY)
  } finally { await api.close() }
}, 60_000)

test('bench with a keyed and an unkeyed harness on one URL and model preflights them apart: the unkeyed one gets no hosted-API window', async () => {
  const api = await fakeOpenAI([textTurn('done'), textTurn('done')], [{ id: 'fake/model', context_length: 50000, top_provider: { context_length: 40000 } }])
  try {
    const wd = await tmp('lhb-cli-'), keyed = await keyedHarness(wd, api.baseUrl), plain = join(wd, 'plain.json')
    const k = JSON.parse(await readFile(keyed, 'utf8')), { apiKeyEnv: _, ...backend } = k.backend
    await writeFile(plain, JSON.stringify({ ...k, name: 'plain', backend }))
    const r = await cliAsync(['bench', '--n', '1', '--out', join(wd, 'b.json'), keyed, plain], { [KEY_NAME]: KEY })
    expect(r.status).toBe(0)
    // With the variable missing from the cache key the second harness would reuse the first one's answer, and one line would print.
    const lines = r.stderr.match(/^preflight: .*$/gm) ?? []
    expect(lines).toEqual([expect.stringContaining('window 40000'), expect.stringContaining('window unknown')])
  } finally { await api.close() }
}, 60_000)

test('a keyed harness sent elsewhere with --base-url: the start line names the new host, and the key goes there', async () => {
  const api = await fakeOpenAI([textTurn('done')])
  try {
    const wd = await tmp('lhb-cli-'), file = await keyedHarness(wd, 'https://api.example/v1')
    const r = await cliAsync(['run', file, '--workdir', wd, '--yes', '--base-url', api.baseUrl, 'x'], { [KEY_NAME]: KEY })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain(`the key in ${KEY_NAME} goes to ${new URL(api.baseUrl).host}`)
    expect(r.stderr).not.toContain('api.example')
    expect(api.seen[0].headers.authorization).toBe(`Bearer ${KEY}`)
  } finally { await api.close() }
}, 30_000)

test('demo on a hosted API: the start line per harness on stderr, stdout pure JSONL, and nothing of Ollama or llama-server in a request', async () => {
  const api = await fakeOpenAI([textTurn('done'), textTurn('{"calls":[],"final":"done"}'), textTurn('done')])
  try {
    const r = await cliAsync(['demo', '--json', '--kind', 'openai', '--base-url', api.baseUrl, '--api-key-env', KEY_NAME, '--model', 'fake/model'], { [KEY_NAME]: KEY })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain(`bare: the key in ${KEY_NAME} goes to`)
    expect(r.stdout).not.toContain('the key in')
    for (const line of r.stdout.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow()
    const chats = api.seen.filter(s => s.path === '/v1/chat/completions')
    expect(chats).toHaveLength(3)
    for (const s of chats) {
      const body = JSON.parse(s.body)
      for (const k of ['options', 'num_ctx', 'chat_template_kwargs', 'think']) expect([k, k in body]).toEqual([k, false])
      expect(s.headers.authorization).toBe(`Bearer ${KEY}`)
    }
  } finally { await api.close() }
}, 90_000)

test('--api-key-env with a name that is not *_API_KEY is an argument error in run, demo and bench', () => {
  const msg = 'error: --api-key-env must be an upper-case variable name ending in _API_KEY (like OPENROUTER_API_KEY)'
  for (const args of [['run', harness('bare'), 'x'], ['demo'], ['bench', '--n', '1']]) {
    const r = cli([...args, '--api-key-env', 'GITHUB_TOKEN'])
    expect([args[0], r.status]).toEqual([args[0], 2])
    expect(r.stderr).toContain(msg); expect(r.stderr).toMatch(/usage: llm-harness-builder/)
  }
}, 60_000)

test('a key with --kind ollama is an invalid harness, named so', async () => {
  const r = cli(['run', harness('bare'), '--workdir', await tmp('lhb-cli-'), '--yes', '--kind', 'ollama', '--base-url', 'http://127.0.0.1:9/v1', '--api-key-env', KEY_NAME, 'x'], { [KEY_NAME]: KEY })
  expect(r.status).toBe(2)
  expect(r.stderr).toContain('invalid harness')
  expect(r.stderr).toContain('backend.apiKeyEnv needs kind openai or anthropic: a key goes only to an OpenAI-compatible or the Anthropic API')
}, 30_000)

test('a key variable that is not set or is empty stops run and demo before the trace, and says where the name came from', async () => {
  const wd = await tmp('lhb-cli-'), file = await keyedHarness(wd, 'https://api.example/v1')
  const unset = cli(['run', file, '--workdir', wd, '--yes', 'x'])
  expect(unset.status).toBe(2)
  expect(unset.stderr).toContain(`${KEY_NAME} is not set: ${file} sends its value as the API key (backend.apiKeyEnv)`)
  expect(existsSync(join(unset.cwd, 'runs'))).toBe(false)
  const empty = cli(['run', file, '--workdir', wd, '--yes', 'x'], { [KEY_NAME]: '  ' })
  expect(empty.status).toBe(2)
  expect(empty.stderr).toContain(`${KEY_NAME} is empty: ${file} sends its value as the API key (backend.apiKeyEnv)`)
  const flag = cli(['demo', '--kind', 'openai', '--base-url', 'https://api.example/v1', '--api-key-env', KEY_NAME])
  expect(flag.status).toBe(2)
  expect(flag.stderr).toContain(`${KEY_NAME} is not set: --api-key-env names it as the API key`)
  expect(existsSync(join(flag.cwd, 'runs'))).toBe(false)
}, 60_000)

test('a server\'s junk — escape codes as token counts, a number as a tool name — never reaches the terminal raw and does not crash the run', async () => {
  const esc = '\u001b[?7l'
  const api = await fakeOpenAI([
    [{ choices: [{ index: 0, delta: { reasoning: { x: 1 }, tool_calls: [{ index: 0, id: 'c1', function: { name: 42, arguments: '{}' } }] }, finish_reason: null }] },
     { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: esc, completion_tokens: 1 } }],
    textTurn('done'),
  ])
  try {
    const wd = await tmp('lhb-cli-'), file = await keyedHarness(wd, api.baseUrl)
    const r = await cliAsync(['run', file, '--workdir', wd, '--yes', 'x'], { [KEY_NAME]: KEY })
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('\u001b')
    expect(r.stderr).toContain('tool_call 42 {}')
  } finally { await api.close() }
}, 30_000)

test('replay --api-key-env sends the key to the server it names, says so on stderr, and refuses a key it cannot send', async () => {
  const api = await fakeOpenAI([textTurn('A'), textTurn('A')])
  try {
    const cwd = tmpSync('lhb-cwd-'); execSync('mkdir runs', { cwd })
    await writeFile(join(cwd, 'runs', 'abc12345.jsonl'), [
      { meta: { id: 'abc12345' } },
      { seq: 0, turn: 1, type: 'llm_request', payload: { model: 'fake/model', messages: [], temperature: 0.2, stream: true } },
      { seq: 1, turn: 1, type: 'llm_response', raw: { choices: [{ message: { content: 'A' } }] }, content: 'A', latencyMs: 1 },
    ].map(l => JSON.stringify(l)).join('\n') + '\n')
    const at = (kind: string, baseUrl: string) => ['replay', 'abc12345', '--turn', '1', '--n', '2', '--kind', kind, '--base-url', baseUrl, '--api-key-env', KEY_NAME]
    const r = await cliAsync(at('openai', api.baseUrl), { [KEY_NAME]: KEY }, cwd)
    expect(r.status).toBe(0)
    expect(r.stderr).toContain(`the key in ${KEY_NAME} goes to ${new URL(api.baseUrl).host}`)
    expect(api.seen.map(s => s.headers.authorization)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`])
    expect(r.stdout).toContain('2 samples, 1 distinct')
    // Each of these must refuse before any request: whatever reaches the fake server lands in api.seen, and the last line holds it to the two samples above.
    const unset = await cliAsync(at('openai', api.baseUrl), {}, cwd)
    expect(unset.status).toBe(2); expect(unset.stderr).toContain(`${KEY_NAME} is not set: --api-key-env names it as the API key`)
    const ollama = await cliAsync(at('ollama', api.baseUrl), { [KEY_NAME]: KEY }, cwd)
    expect(ollama.status).toBe(2); expect(ollama.stderr).toContain('error: --api-key-env needs --kind openai or anthropic: a key goes only to an OpenAI-compatible or the Anthropic API')
    const lan = await cliAsync(at('openai', 'http://192.168.1.5/v1'), { [KEY_NAME]: KEY }, cwd)
    expect(lan.status).toBe(2)
    expect(lan.stderr).toContain('error: --api-key-env needs an https --base-url (http only on localhost, 127.0.0.1 or [::1]): the key would cross the network in clear text')
    // `http://` has the prefix but no host: keyErrors cannot judge a URL that does not parse, so the --base-url check itself must refuse it.
    const noHost = await cliAsync(at('openai', 'http://'), { [KEY_NAME]: KEY }, cwd)
    expect(noHost.status).toBe(2); expect(noHost.stderr).toContain('error: --base-url must be an http(s) URL')
    // As in run, demo and bench the name is checked first: with no --turn, --kind or --base-url (and no such run), any later check would give another message.
    const name = await cliAsync(['replay', 'nope', '--api-key-env', 'GITHUB_TOKEN'], {}, cwd)
    expect(name.status).toBe(2)
    expect(name.stderr).toContain('error: --api-key-env must be an upper-case variable name ending in _API_KEY (like OPENROUTER_API_KEY)')
    expect(name.stderr).toContain('usage: llm-harness-builder replay')
    expect(api.seen).toHaveLength(2)
  } finally { await api.close() }
}, 60_000)

test('the done line carries the run cost when the harness has a price, and no $ otherwise', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = join(wd, 'fake.json'), file = join(wd, 'priced.json')
  const plain = JSON.parse(await readFile(harness('bare'), 'utf8'))
  await writeFile(file, JSON.stringify({ ...plain, backend: { ...plain.backend, pricePerMTok: { input: 1, output: 2 } } }))
  await writeFile(fake, JSON.stringify([{ content: 'a', usage: { promptTokens: 1_000_000, completionTokens: 500_000 } }]))
  expect(cli(['run', file, '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake }).stderr).toContain('done: final after 1 turns, 0 tool calls · $2 total')
  const r = cli(['run', harness('bare'), '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake })
  expect(r.stderr).toContain('done: final')
  expect(r.stderr).not.toContain('$')
}, 30_000)

test('bench refuses a harness whose native tool calls the model does not take, before any run', async () => {
  const listed = { data: [{ id: 'fake/model', supported_parameters: ['max_tokens'] }] }
  const srv = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(listed)) })
  await listen(srv)
  try {
    const wd = await tmp('lhb-cli-'), file = await keyedHarness(wd, `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`)
    const r = await cliAsync(['bench', '--n', '1', '--out', join(wd, 'b.json'), file], { [KEY_NAME]: KEY })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('fake/model takes no tools (OpenRouter supported_parameters)')
    expect(r.stderr).toContain('mode: "prompted"')
  } finally { await new Promise<void>(r => { srv.closeAllConnections(); srv.close(() => r()) }) }
}, 30_000)

const withNotesOn = async (dir: string) => {
  const f = join(dir, 'notes-harness.json')
  await writeFile(f, JSON.stringify({ ...JSON.parse(readFileSync(harness('bare'), 'utf8')), notes: { enabled: true, maxTokens: 400 } }))
  return f
}

test('run with notes on: writes the note to the notes dir, outside the project, and says so', async () => {
  const wd = await tmp('lhb-cli-'), cwd = await tmp('lhb-cwd-'), nd = await tmp('lhb-notes-')
  const fake = fakeFile(wd, [{ content: 'done' }, { content: JSON.stringify({ notes: ['tests run with npm test'] }) }])
  const r = cli(['run', await withNotesOn(cwd), '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake, LHB_NOTES_DIR: nd }, cwd)
  expect(r.status).toBe(0)
  const file = join(nd, `${await notesKey(wd)}.jsonl`)
  expect(r.stderr).toContain('note: tests run with npm test')
  expect((await readNotes(file)).map(n => n.text)).toEqual(['tests run with npm test'])
  expect(existsSync(join(cwd, 'runs', 'notes'))).toBe(false)
}, 30_000)

test('run with notes on from the project root: a notes dir inside the workdir is refused', async () => {
  const wd = await tmp('lhb-cli-')
  const fake = fakeFile(wd, [{ content: 'done' }])
  const r = cli(['run', await withNotesOn(wd), '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake, LHB_NOTES_DIR: join(wd, 'runs', 'notes') }, wd)
  expect(r.status).toBe(0)
  expect(r.stderr).toContain('is inside the workdir')
  expect(r.stderr).toContain('LHB_NOTES_DIR outside the workdir')
  expect(r.stderr).not.toMatch(/notes: \d+ loaded/)
  expect(existsSync(join(wd, 'runs', 'notes'))).toBe(false)
}, 30_000)

test('run prints the notes count once', async () => {
  const wd = await tmp('lhb-cli-'), cwd = await tmp('lhb-cwd-'), nd = await tmp('lhb-notes-')
  const fake = fakeFile(wd, [{ content: 'done' }, { content: JSON.stringify({ notes: [] }) }])
  await writeFile(join(nd, `${await notesKey(wd)}.jsonl`), JSON.stringify({ id: 'a', ts: 1, author: 'model', text: 'old fact' }) + '\n')
  const r = cli(['run', await withNotesOn(cwd), '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake, LHB_NOTES_DIR: nd }, cwd)
  expect(r.stderr.match(/notes: \d+ loaded/g)).toEqual(['notes: 1 loaded'])
}, 30_000)

test("bench: a run's tokens are the sum of its replies' usage, firstPromptTokens the first prompt", async () => {
  const cwd = await tmp('lhb-cwd-')
  const bench = async (replies: object[]) => {
    const out = join(cwd, 'b.json')
    const fake = fakeFile(cwd, replies)
    expect(cli(['bench', '--n', '1', '--out', out, harness('bare')], { LHB_FAKE_BACKEND: fake }, cwd).status).toBe(0)
    return JSON.parse(await readFile(out, 'utf8')).harnesses[0].runs[0]
  }
  const withUsage = await bench([{ toolCalls: [{ name: 'bash', args: { command: 'true' } }], usage: { promptTokens: 100, completionTokens: 10 } }, { content: 'done', usage: { promptTokens: 150, completionTokens: 5 } }])
  expect(withUsage.tokens).toBe(265)
  expect(withUsage.firstPromptTokens).toBe(100)
  const without = await bench([{ toolCalls: [{ name: 'bash', args: { command: 'true' } }] }, { content: 'done' }])
  expect(without.tokens).toBeUndefined()
  expect(without.firstPromptTokens).toBeUndefined()
  // a later reply's prompt must not stand in for a first reply that reported nothing
  const late = await bench([{ toolCalls: [{ name: 'bash', args: { command: 'true' } }] }, { content: 'done', usage: { promptTokens: 150, completionTokens: 5 } }])
  expect(late.tokens).toBe(155)
  expect(late.firstPromptTokens).toBeUndefined()
}, 60_000)

test('fake backend: an entry with when answers only requests that contain it, keep leaves it in', async () => {
  const cwd = await tmp('lhb-cwd-')
  const hfile = async (systemPrompt: string) => {
    const h = JSON.parse(await readFile(harness('bare'), 'utf8'))
    const f = join(cwd, `${systemPrompt}.json`)
    await writeFile(f, JSON.stringify({ ...h, systemPrompt }))
    return f
  }
  const fake = fakeFile(cwd, [{ when: 'OTHER', content: 'wrong' }, { when: 'MARK', keep: true, content: 'right' }])
  const env = { LHB_FAKE_BACKEND: fake }
  for (let i = 0; i < 2; i++) {
    const r = cli(['run', await hfile('MARK'), '--workdir', cwd, '--yes', 'x'], env, cwd)
    expect(r.stderr + r.stdout).toContain('right')
    expect(r.stderr + r.stdout).not.toContain('wrong')
  }
  const r = cli(['run', await hfile('plain'), '--workdir', cwd, '--yes', 'x'], env, cwd)
  expect(r.stderr).toContain('no response for this request')
}, 60_000)

test('bench with notes on reads the task notes and never writes them', async () => {
  const cwd = await tmp('lhb-cwd-'), nd = await tmp('lhb-notes-')
  const file = join(nd, 'task-slug.jsonl')
  writeFileSync(file, JSON.stringify({ id: 'n1', ts: 1, author: 'user', text: 'kept' }) + '\n')
  const fake = join(cwd, 'fake.json')
  // one reply: a writer request would find the queue empty and fail the run's last event
  await writeFile(fake, JSON.stringify([{ content: 'done' }]))
  const r = cli(['bench', '--n', '1', '--out', join(cwd, 'b.json'), await withNotesOn(cwd)], { LHB_FAKE_BACKEND: fake, LHB_NOTES_DIR: nd }, cwd)
  expect(r.status).toBe(0)
  expect(r.stderr).toContain('notes on, 1 in')
  expect(readFileSync(file, 'utf8')).toBe(JSON.stringify({ id: 'n1', ts: 1, author: 'user', text: 'kept' }) + '\n')
  const trace = JSON.parse(await readFile(join(cwd, 'b.json'), 'utf8')).harnesses[0].runs[0].trace
  const events = (await readFile(join(cwd, 'runs', `${trace}.jsonl`), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
  expect(events.some(e => e.type === 'notes_loaded')).toBe(true)
  expect(events.some(e => e.type === 'note_written')).toBe(false)
}, 60_000)

test('bench with notes on and no task notes says it measures notes off', async () => {
  const cwd = await tmp('lhb-cwd-'), nd = await tmp('lhb-notes-')
  const fake = fakeFile(cwd, [{ content: 'done' }])
  const r = cli(['bench', '--n', '1', '--out', join(cwd, 'b.json'), await withNotesOn(cwd)], { LHB_FAKE_BACKEND: fake, LHB_NOTES_DIR: nd }, cwd)
  expect(r.stderr).toContain('this bench runs as with notes off')
}, 60_000)


test('bench --tasks: runs each task in a clone, PASS and FAIL with a reason, patch kept, repo untouched', async () => {
  const repo = await tasksRepo(TWO)
  const env = await tasksEnv([bashCall('echo ok > done.txt'), { content: 'done' }, { content: 'done' }])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['bench', '--tasks', repo, '--n', '1', '--yes', '--out', join(cwd, 'b.json'), harness('bare')], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  const j = JSON.parse(await readFile(join(cwd, 'b.json'), 'utf8'))
  const sha = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
  expect(r.stderr).toMatch(/^bench: 1 harnesses × 2 runs,/m)
  expect(r.stderr).toContain('bare #1 a ')
  expect(j).toMatchObject({ taskName: 'tasks', tasksRepo: realpathSync(repo), tasksSha: sha })
  expect(j.harnesses[0].runs.map((x: any) => [x.task, x.verdict, x.lastError])).toEqual([['a', 'PASS', undefined], ['b', 'FAIL', 'check exited 1']])
  expect(clonesIn(env)).toEqual([])
  expect(execSync('git --no-optional-locks status --porcelain', { cwd: repo, encoding: 'utf8' })).toBe('')
  expect(existsSync(join(repo, 'done.txt'))).toBe(false)
  expect(readFileSync(join(cwd, 'runs', `${j.harnesses[0].runs[0].trace}.patch`), 'utf8')).toContain('done.txt')
}, 60_000)

test('bench --tasks: asks before running the commands, remembers, asks again when they change', async () => {
  const repo = await tasksRepo(TWO)
  const env = await tasksEnv([{ content: 'done' }, { content: 'done' }, { content: 'done' }, { content: 'done' }])
  const cwd = await tmp('lhb-cwd-')
  const args = ['bench', '--tasks', repo, '--n', '1', '--out', join(cwd, 'b.json'), harness('bare')]
  const no = cli(args, env, cwd)
  expect(no.status).toBe(2)
  for (const s of ['make done.txt', "check — in each run's clone, after the run", 'pass --yes']) expect(no.stderr).toContain(s)
  expect(cli([...args, '--yes'], env, cwd).status).toBe(0)
  expect(cli(args, env, cwd).status).toBe(0)
  writeFileSync(join(repo, 'lhb-tasks.json'), JSON.stringify({ tasks: [TWO[0], { ...TWO[1], check: 'exit 2' }] }))
  await gitCommit(repo)
  expect(cli(args, env, cwd).status).toBe(2)
}, 90_000)

test('bench --tasks: refuses --task or --size with it, and a folder that is not a repo', async () => {
  const repo = await tasksRepo(TWO)
  const env = await tasksEnv([])
  for (const extra of [['--task', 'slug'], ['--size', '3']]) {
    const r = cli(['bench', '--tasks', repo, ...extra, '--yes', harness('bare')], env)
    expect(r.status).toBe(2); expect(r.stderr).toContain('--tasks cannot go with --task or --size')
  }
  const r = cli(['bench', '--tasks', await tmp('lhb-plain-'), '--yes', harness('bare')], env)
  expect(r.status).toBe(2); expect(r.stderr).toContain('is not a git repository')
}, 60_000)

test('bench --tasks --only: runs just the named tasks and says so; an unknown name lists the tasks; --only needs --tasks', async () => {
  const repo = await tasksRepo(TWO)
  const env = await tasksEnv([{ content: 'done' }])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['bench', '--tasks', repo, '--only', 'b,b', '--n', '1', '--yes', '--out', join(cwd, 'b.json'), harness('bare')], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(r.stderr).toMatch(/^tasks: 1 from /m)
  expect(r.stderr).not.toContain('make done.txt')
  const j = JSON.parse(await readFile(join(cwd, 'b.json'), 'utf8'))
  expect(j).toMatchObject({ taskCount: 1, only: ['b'] })
  expect(j.task).toMatch(/ \(only b\)$/)
  expect(j.harnesses[0].runs.map((x: any) => x.task)).toEqual(['b'])
  for (const [only, why] of [['c', 'no task c'], ['a,', 'an empty name'], ['', 'an empty name']]) {
    const bad = cli(['bench', '--tasks', repo, '--only', only, '--yes', harness('bare')], env)
    expect(bad.status).toBe(2); expect(bad.stderr).toContain(`--only: ${why}; the tasks are a, b`)
  }
  const no = cli(['bench', '--only', 'a', harness('bare')], env)
  expect(no.status).toBe(2); expect(no.stderr).toContain('--only needs --tasks')
}, 60_000)

test('bench --tasks: a changed protected file is a FAIL and the check never runs', async () => {
  const marker = join(await tmp('lhb-mark-'), 'ran')
  const repo = await tasksRepo([{ name: 'a', prompt: 'p', check: `touch "${marker}"` }], { 'a.test.js': 't\n' })
  const env = await tasksEnv([bashCall('echo hacked > a.test.js'), { content: 'done' }])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['bench', '--tasks', repo, '--n', '1', '--yes', '--out', join(cwd, 'b.json'), harness('bare')], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  const run = JSON.parse(await readFile(join(cwd, 'b.json'), 'utf8')).harnesses[0].runs[0]
  expect([run.verdict, run.lastError]).toEqual(['FAIL', 'changed a protected file: a.test.js'])
  expect(existsSync(marker)).toBe(false)
}, 60_000)

test('bench --tasks: the model changing the shared node_modules stops the bench after its JSON', async () => {
  const repo = await tasksRepo(TWO)
  mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true }); writeFileSync(join(repo, 'node_modules', 'x', 'index.js'), '1')
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n'); await gitCommit(repo, 'ig')
  const env = await tasksEnv([bashCall('rm node_modules/x/index.js'), { content: 'done' }, { content: 'done' }])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['bench', '--tasks', repo, '--n', '1', '--yes', '--out', join(cwd, 'b.json'), harness('bare')], env, cwd)
  expect(r.status).toBe(1)
  expect(r.stderr).toContain('the model changed the installed packages')
  expect(JSON.parse(await readFile(join(cwd, 'b.json'), 'utf8')).harnesses[0].runs).toHaveLength(1)
  expect(clonesIn(env)).toEqual([])
}, 60_000)

// Ctrl-C once the bench has printed `ready` and a clone exists: nothing is left of it.
async function benchCtrlC(setup: string | undefined, fake: unknown[], ready: string) {
  const repo = await gitRepo({ 'lhb-tasks.json': JSON.stringify({ tasks: TWO, ...(setup && { setup }) }) })
  const env = await tasksEnv(fake)
  const cwd = await tmp('lhb-cwd-')
  const child = spawnCli(['bench', '--tasks', repo, '--n', '1', '--yes', '--out', join(cwd, 'b.json'), harness('bare')],
    { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  await new Promise<void>(res => child.stderr!.on('data', d => { err += d; if (err.includes(ready)) res() }))
  await new Promise(r => setTimeout(r, 1500))
  expect(clonesIn(env).length).toBeGreaterThan(0)
  child.kill('SIGINT')
  await new Promise(r => child.on('exit', r))
  expect(clonesIn(env)).toEqual([])
}

test('bench --tasks: Ctrl-C leaves no clone behind, the setup clone included', () =>
  benchCtrlC('mkdir -p node_modules/x', [bashCall('sleep 20'), { content: 'done' }], '--- round'), 60_000)

test('bench --tasks: Ctrl-C during setup leaves no clone behind', () =>
  benchCtrlC('sleep 20', [], 'tasks: 2 from'), 60_000)

test('bench --tasks: a failing setup is one line, not a stack trace', async () => {
  const repo = await gitRepo({ 'lhb-tasks.json': JSON.stringify({ tasks: TWO, setup: 'echo nope; exit 2' }) })
  const env = await tasksEnv([])
  const r = cli(['bench', '--tasks', repo, '--n', '1', '--yes', harness('bare')], env)
  expect(r.status).not.toBe(0)
  expect(r.stderr).toContain('setup failed (exit 2): nope')
  expect(r.stderr).not.toMatch(/^\s+at /m)
  expect(clonesIn(env)).toEqual([])
}, 60_000)

test('bench --tasks: swapping the node_modules link for a folder of the model\'s own is a FAIL', async () => {
  const repo = await tasksRepo([{ name: 'a', prompt: 'p', check: 'true' }], { '.gitignore': 'node_modules\n' })
  mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true }); writeFileSync(join(repo, 'node_modules', 'x', 'index.js'), '1')
  const env = await tasksEnv([bashCall('rm node_modules && mkdir -p node_modules/.bin'), { content: 'done' }])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['bench', '--tasks', repo, '--n', '1', '--yes', '--out', join(cwd, 'b.json'), harness('bare')], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  const run = JSON.parse(await readFile(join(cwd, 'b.json'), 'utf8')).harnesses[0].runs[0]
  expect([run.verdict, run.lastError]).toEqual(['FAIL', 'changed a protected file: node_modules'])
  expect(readFileSync(join(repo, 'node_modules', 'x', 'index.js'), 'utf8')).toBe('1')
}, 60_000)

test('bench --tasks: what a run left in the background is dead before its check', async () => {
  const repo = await tasksRepo([{ name: 'a', prompt: 'p', check: 'a=$(wc -c < grow.txt); sleep 0.5; test "$(wc -c < grow.txt)" = "$a"' }])
  const pidFile = join(await tmp('lhb-pid-'), 'pid')
  const env = await tasksEnv([bashCall(`(while :; do echo x >> grow.txt; sleep 0.05; done) >/dev/null 2>&1 & sleep 30 >/dev/null 2>&1 & echo $! > "${pidFile}"; echo started`), { content: 'done' }])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['bench', '--tasks', repo, '--n', '1', '--yes', '--out', join(cwd, 'b.json'), harness('bare')], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  const run = JSON.parse(await readFile(join(cwd, 'b.json'), 'utf8')).harnesses[0].runs[0]
  expect([run.verdict, run.lastError]).toEqual(['PASS', undefined])
  expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow()
}, 60_000)

test('bench --tasks: a server that is down is reported before setup runs', async () => {
  const marker = join(await tmp('lhb-mark-'), 'ran')
  const repo = await gitRepo({ 'lhb-tasks.json': JSON.stringify({ tasks: TWO, setup: `touch "${marker}"` }) })
  const env = await tasksEnv([])
  const { LHB_FAKE_BACKEND: _, ...noFake } = env
  const r = cli(['bench', '--tasks', repo, '--n', '1', '--yes', '--kind', 'ollama', '--base-url', 'http://127.0.0.1:1', harness('bare')], noFake)
  expect(r.status).toBe(2)
  expect(existsSync(marker)).toBe(false)
}, 60_000)

test('bench --tasks: setup gets the env names of the harnesses\' tools.bashEnv', async () => {
  const repo = await gitRepo({ 'lhb-tasks.json': JSON.stringify({ tasks: [{ name: 'a', prompt: 'p', check: 'true' }], setup: 'test "$LHB_T_FOO" = 1' }) })
  const env = await tasksEnv([{ content: 'done' }])
  const cwd = await tmp('lhb-cwd-')
  const h = join(cwd, 'h.json')
  writeFileSync(h, JSON.stringify({ ...JSON.parse(readFileSync(harness('bare'), 'utf8')), tools: { enabled: ['bash'], approveBash: true, bashEnv: ['LHB_T_FOO'] } }))
  const r = cli(['bench', '--tasks', repo, '--n', '1', '--yes', '--out', join(cwd, 'b.json'), h], { ...env, LHB_T_FOO: '1' }, cwd)
  expect(r.status, r.stderr).toBe(0)
}, 60_000)

test('bench --tasks: a bad tasks file is refused before the consent text', async () => {
  const repo = await gitRepo({ 'lhb-tasks.json': JSON.stringify({ tasks: TWO, protect: [':(bogus)x'] }) })
  const r = cli(['bench', '--tasks', repo, '--n', '1', harness('bare')], await tasksEnv([]))
  expect(r.status).toBe(2)
  expect(r.stderr).toContain('lhb-tasks.json: protect:')
  expect(r.stderr).not.toContain('make done.txt')
}, 60_000)

test('bench --tasks: what setup leaves in the background is gone before the first run', async () => {
  const pidFile = join(await tmp('lhb-pid-'), 'pid')
  const repo = await gitRepo({ 'lhb-tasks.json': JSON.stringify({ tasks: [{ name: 'a', prompt: 'p', check: 'test ! -f alive.txt' }], setup: `sleep 30 >/dev/null 2>&1 & echo $! > "${pidFile}"` }) })
  const env = await tasksEnv([bashCall(`kill -0 "$(cat "${pidFile}")" 2>/dev/null && echo alive > alive.txt; true`), { content: 'done' }])
  const cwd = await tmp('lhb-cwd-')
  const r = cli(['bench', '--tasks', repo, '--n', '1', '--yes', '--out', join(cwd, 'b.json'), harness('bare')], env, cwd)
  expect(r.status, r.stderr).toBe(0)
  expect(JSON.parse(await readFile(join(cwd, 'b.json'), 'utf8')).harnesses[0].runs[0].verdict).toBe('PASS')
}, 60_000)


test('bench records backend.reasoningEffort in the JSON config', async () => {
  const wd = await tmp('lhb-cli-')
  const f = join(wd, 'eff.json'), fake = join(wd, 'fake.json'), out = join(wd, 'e.json')
  const h = JSON.parse(readFileSync(harness('tuned'), 'utf8')); h.backend = { ...h.backend, kind: 'openai', reasoningEffort: 'high' }
  await writeFile(f, JSON.stringify(h)); await writeFile(fake, JSON.stringify([{ content: '{"calls":[],"final":"x"}' }]))
  const r = cli(['bench', '--n', '1', '--out', out, f], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  expect(JSON.parse(await readFile(out, 'utf8')).harnesses[0].config.backend.reasoningEffort).toBe('high')
}, 60_000)

test('bench --models runs every harness on every model into one JSON and one table', async () => {
  const wd = await tmp('lhb-cli-')
  const out = join(wd, 'b.json')
  const fake = fakeFile(wd, [{ content: TUNED_EDIT }, { content: TUNED_FINAL }, { content: TUNED_EDIT }, { content: TUNED_FINAL }])
  const r = cli(['bench', '--n', '1', '--models', 'ma,mb', '--out', out, harness('tuned')], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  const j = JSON.parse(await readFile(out, 'utf8'))
  expect(j.harnesses.map((h: any) => [h.name, h.config.backend.model])).toEqual([['tuned', 'ma'], ['tuned', 'mb']])
  expect(r.stdout).toMatch(/^tuned · ma\s+1\/1/m); expect(r.stdout).toMatch(/^tuned · mb\s+1\/1/m)
  expect(r.stderr).toMatch(/tuned · mb\s+\S*tuned\.json/)
})
test('bench --models: --model with it, and an empty entry, are argument errors', () => {
  for (const args of [['--model', 'x', '--models', 'a,b'], ['--models', 'a,'], ['--models', ''], ['--models', ',a'], ['--models', 'a,a']]) {
    const r = cli(['bench', '--n', '1', ...args, harness('tuned')])
    expect([args, r.status]).toEqual([args, 2]); expect(r.stderr).toMatch(/^error: --model/); expect(r.stderr).toContain('usage: ')
  }
})
