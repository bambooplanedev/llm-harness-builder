import { test, expect } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, readdir, stat, cp } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunStore } from '../src/server/runs'

const ROOT = process.cwd()
const harness = (name: string) => join(ROOT, 'harnesses', `${name}.json`)
// Fresh cwd per spawn: the CLI writes runs/ into cwd, which must not be the repo. tsx by absolute path: npx from a tmp cwd does not resolve it.
const cli = (args: string[], env: Record<string, string> = {}, cwd = mkdtempSync(join(tmpdir(), 'lhb-cwd-'))) =>
  Object.assign(spawnSync(join(ROOT, 'node_modules', '.bin', 'tsx'), [join(ROOT, 'src', 'cli.ts'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } }), { cwd })

test('run --json prints jsonl and exits 0 on final', async () => {
  const wd = await mkdtemp(join(tmpdir(), 'lhb-cli-'))
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
  const wd = await mkdtemp(join(tmpdir(), 'lhb-cli-'))
  const fake = join(wd, 'fake.json')
  await writeFile(fake, JSON.stringify([{ content: '' }, { content: '' }]))
  const r = cli(['run', harness('bare'), '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(1)
}, 30_000)

test('demo prints PASS/FAIL per harness', async () => {
  const fake = join(await mkdtemp(join(tmpdir(), 'lhb-cli-')), 'fake.json')
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
  const fake = join(await mkdtemp(join(tmpdir(), 'lhb-cli-')), 'fake.json')
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
  const wd = await mkdtemp(join(tmpdir(), 'lhb-cli-'))
  const fake = join(wd, 'fake.json')
  await writeFile(fake, JSON.stringify([{ content: 'Let me look at that first.' }]))
  const r = cli(['run', harness('tuned-hermes'), '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  expect(r.stderr).toMatch(/! final after 0 tool calls/)
}, 30_000)

test('run dies with a clear message when the harness has no backend object and an override is given', async () => {
  const wd = await mkdtemp(join(tmpdir(), 'lhb-cli-'))
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
  const wd = await mkdtemp(join(tmpdir(), 'lhb-cli-'))
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
  const wd = await mkdtemp(join(tmpdir(), 'lhb-cli-'))
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
  const wd = await mkdtemp(join(tmpdir(), 'lhb-cli-'))
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
  const wd = await mkdtemp(join(tmpdir(), 'lhb-cli-'))
  for (const file of [join(wd, 'nope.json'), wd]) {
    const r = cli(['run', file, '--workdir', wd, '--yes', 'task'])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/cannot read harness/)
    expect(r.stderr).not.toMatch(/at .*cli\.ts/)
  }
}, 30_000)

test('run starts an mcp server and reports its counts on stderr', async () => {
  const wd = await mkdtemp(join(tmpdir(), 'lhb-cli-'))
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
  expect(r.stderr).toMatch(/mcp test: 7 offered, 1 tools, 15 desc \+ 77 schema chars/)
}, 30_000)

test('run without --yes prompts "start mcp server", not "run bash", for an mcp approval', async () => {
  const wd = await mkdtemp(join(tmpdir(), 'lhb-cli-'))
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
