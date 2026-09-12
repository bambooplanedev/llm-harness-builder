#!/usr/bin/env node
// src/cli.ts
import { parseArgs } from 'node:util'
import { readFile, mkdtemp, cp, writeFile, access, mkdir } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgent, type RunOpts } from './core/run.js'
import { validateConfig, type HarnessConfig } from './core/config.js'
import { validateWorkdir } from './core/tools/sandbox.js'
import type { Backend, NormalizedResponse } from './core/backends/types.js'
import type { HarnessEvent, ToolCall } from './core/events.js'
import { startServer } from './server/index.js'
import { DEMO_TASK } from './core/prompts.js'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const die = (msg: string): never => { console.error(msg); process.exit(2) }

let fakeCache: Promise<Backend | undefined> | undefined
/** Test hook: LHB_FAKE_BACKEND=<file.json> with an array of Partial<NormalizedResponse>. One shared queue per process. */
function fakeBackendFromEnv(): Promise<Backend | undefined> {
  return (fakeCache ??= (async () => {
    const f = process.env.LHB_FAKE_BACKEND
    if (!f) return undefined
    const queue: Partial<NormalizedResponse>[] = JSON.parse(await readFile(f, 'utf8'))
    return { async listModels() { return ['fake'] }, buildPayload: r => r, async send() { const r = queue.shift(); if (!r) throw new Error('fake backend: no more responses'); return { content: '', toolCalls: [], raw: {}, ...r } } } as Backend
  })())
}

async function loadHarness(file: string, over: { model?: string; baseUrl?: string; kind?: string }): Promise<HarnessConfig> {
  const cfg = JSON.parse(await readFile(file, 'utf8'))
  if (over.model) cfg.backend.model = over.model
  if (over.baseUrl) cfg.backend.baseUrl = over.baseUrl
  if (over.kind) cfg.backend.kind = over.kind
  const errs = validateConfig(cfg)
  if (errs.length) die(`invalid harness ${file}:\n  ${errs.join('\n  ')}`)
  return cfg
}

function describe(e: HarnessEvent): string {
  switch (e.type) {
    case 'context_stats': return `[t${e.turn}] context ~${e.estimatedTokens} tok${e.droppedChars ? `, dropped ${e.droppedChars} chars` : ''}`
    case 'llm_request': return `[t${e.turn}] llm_request`
    case 'llm_response': return `[t${e.turn}] llm_response ${e.latencyMs}ms${e.usage ? ` (${e.usage.promptTokens}+${e.usage.completionTokens} tok)` : ''}${e.content ? `\n    ${e.content.slice(0, 200).replace(/\n/g, ' ')}` : ''}`
    case 'parse_error': return `[t${e.turn}] parse_error: ${e.message}`
    case 'tool_call': return `[t${e.turn}] tool_call ${e.call.name} ${JSON.stringify(e.call.args).slice(0, 200)}`
    case 'approval_required': return `[t${e.turn}] approval_required ${e.call.name}`
    case 'tool_result': return `[t${e.turn}] tool_result ${e.name}${e.error ? ' (error)' : ''}${e.truncated ? ' (truncated)' : ''}: ${e.output.slice(0, 200).replace(/\n/g, ' ')}`
    case 'error': return `error: ${e.message}${e.body ? `\n${e.body}` : ''}`
    case 'done': return `done: ${e.reason} after ${e.turns} turns, ${e.toolCallCount} tool calls${e.reason === 'final' && e.toolCallCount === 0 ? '  ! final after 0 tool calls' : ''}${e.text ? `\n${e.text}` : ''}`
  }
}

async function execRun(config: HarnessConfig, task: string, workdir: string, o: { yes: boolean; json: boolean; quiet?: boolean }): Promise<HarnessEvent> {
  const rl = o.yes ? null : createInterface({ input: process.stdin, output: process.stderr })
  const approve = async (call: ToolCall) => {
    if (o.yes) return true
    const a = await rl!.question(`run bash: ${call.args.command}\n[y/N] `)
    return /^y(es)?$/i.test(a.trim())
  }
  const opts: RunOpts = { approve, backend: await fakeBackendFromEnv() }
  let last: HarnessEvent | undefined
  try {
    for await (const e of runAgent({ config, task, workdir }, opts)) {
      last = e
      if (o.json) process.stdout.write(JSON.stringify(e) + '\n')
      if (!o.quiet) console.error(describe(e))
    }
  } finally {
    rl?.close()
  }
  return last!
}

async function cmdRun(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    workdir: { type: 'string' }, yes: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
    model: { type: 'string' }, 'base-url': { type: 'string' }, kind: { type: 'string' },
  } })
  const [file, ...taskParts] = positionals
  if (!file || !taskParts.length) die('usage: llm-harness-builder run <harness.json> --workdir <dir> "task" [--yes] [--json] [--model m] [--base-url u] [--kind openai|ollama]')
  const workdir = path.resolve(values.workdir ?? '.')
  const werr = await validateWorkdir(workdir); if (werr) die(werr)
  const config = await loadHarness(file, { model: values.model, baseUrl: values['base-url'], kind: values.kind })
  const last = await execRun(config, taskParts.join(' '), workdir, { yes: values.yes, json: values.json })
  process.exitCode = last.type === 'done' && last.reason === 'final' ? 0 : 1
}

async function makeDemoWorkdir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lhb-demo-'))
  await cp(path.join(PKG_ROOT, 'examples'), dir, { recursive: true })
  const lines: string[] = []
  for (let i = 0; i < 3000; i++) lines.push(`2026-09-11T10:${String(i % 60).padStart(2, '0')}:00Z INFO request id=${i} path=/api/slug status=200 ms=${(i * 7) % 90}`)
  lines.push('2026-09-11T11:00:00Z ERROR bug report: slugify("  Hello, World!  ") returned "hello-world-" but expected "hello-world" (leading and trailing dashes must be stripped)')
  lines.push('2026-09-11T11:00:01Z INFO request id=3001 path=/api/slug status=200 ms=12')
  await mkdir(path.join(dir, 'data'), { recursive: true })
  await writeFile(path.join(dir, 'data', 'app.log'), lines.join('\n') + '\n')
  return dir
}

async function cmdDemo(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { model: { type: 'string' }, 'base-url': { type: 'string' }, kind: { type: 'string' }, json: { type: 'boolean', default: false } } })
  const rows: string[] = []
  for (const name of ['bare', 'tuned', 'tuned-hermes']) {
    const config = await loadHarness(path.join(PKG_ROOT, 'harnesses', `${name}.json`), { model: values.model, baseUrl: values['base-url'], kind: values.kind })
    const workdir = await makeDemoWorkdir()
    console.error(`\n=== ${name} (${config.backend.model}) in ${workdir}`)
    const last = await execRun(config, DEMO_TASK, workdir, { yes: true, json: values.json })
    const check = spawnSync('sh', [path.join(workdir, 'check.sh')])
    const verdict = check.status === 0 ? 'PASS' : 'FAIL'
    const d = last.type === 'done' ? last : undefined
    rows.push(`${name.padEnd(12)} ${verdict}  reason=${d?.reason ?? '?'} turns=${d?.turns ?? '?'} toolCalls=${d?.toolCallCount ?? '?'}`)
  }
  const summary = '\n' + rows.join('\n')
  if (values.json) console.error(summary)
  else console.log(summary)
}

async function cmdServe(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string', default: '7331' }, 'no-open': { type: 'boolean', default: false } } })
  const cwd = process.cwd()
  const harnessesDir = path.join(cwd, 'harnesses')
  try { await access(harnessesDir) } catch { await cp(path.join(PKG_ROOT, 'harnesses'), harnessesDir, { recursive: true }) }
  const fake = await fakeBackendFromEnv()
  const srv = await startServer({
    port: Number(values.port), runsDir: path.join(cwd, 'runs'), harnessesDir,
    staticDir: path.join(PKG_ROOT, 'web', 'dist'), backendFactory: fake ? () => fake : undefined,
  })
  const url = `http://localhost:${srv.port}`
  console.error(`llm-harness-builder serving on ${url}  (harnesses: ${harnessesDir}, runs: ${path.join(cwd, 'runs')})`)
  if (!values['no-open']) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
}

const [cmd = 'serve', ...rest] = process.argv.slice(2)
const commands: Record<string, (a: string[]) => Promise<void>> = { serve: cmdServe, run: cmdRun, demo: cmdDemo }
if (!commands[cmd]) die('usage: llm-harness-builder [serve|run|demo] ...')
commands[cmd](rest).catch(e => die(String(e?.stack ?? e)))
