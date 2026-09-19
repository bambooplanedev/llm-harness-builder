#!/usr/bin/env node
// src/cli.ts
import { parseArgs } from 'node:util'
import { readFile, cp, writeFile, rename, access, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgent, type RunOpts } from './core/run.js'
import { validateConfig, type HarnessConfig } from './core/config.js'
import { validateWorkdir } from './core/tools/sandbox.js'
import type { Backend, NormalizedResponse } from './core/backends/types.js'
import { mcpApprovalServer, mcpCounts, quitWithoutWork, type HarnessEvent, type ToolCall } from './core/events.js'
import { startServer } from './server/index.js'
import { TraceWriter, type Meta } from './server/runs.js'
import { DEMO_TASK } from './core/prompts.js'
import { TASKS } from './core/tasks.js'
import { median, formatTable, type BenchRun, type BenchHarness, type BenchResult } from './core/bench.js'
import { GUARD_BLOCKED, EDIT_MISS } from './core/tools/fs.js'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const die = (msg: string): never => { console.error(msg); process.exit(2) }

const DEMO_HARNESSES = ['bare', 'tuned', 'tuned-hermes']

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
  // One catch for the whole read: a missing file, a directory and malformed JSON all used to reach
  // the top-level handler and print a stack at someone who mistyped a path.
  let cfg: any
  try { cfg = JSON.parse(await readFile(file, 'utf8')) }
  catch (e) { return die(`cannot read harness ${file}:\n  ${(e as Error).message}`) }
  if (!cfg || typeof cfg.backend !== 'object' || cfg.backend === null) die(`invalid harness ${file}:\n  backend must be an object`)
  if (over.model) cfg.backend.model = over.model
  if (over.baseUrl) cfg.backend.baseUrl = over.baseUrl
  if (over.kind) cfg.backend.kind = over.kind
  const errs = validateConfig(cfg)
  if (errs.length) die(`invalid harness ${file}:\n  ${errs.join('\n  ')}`)
  return cfg
}

/** `streamed`: the turn's text was already written live to stderr, so llm_response skips its excerpt. */
function describe(e: HarnessEvent, streamed = false): string {
  switch (e.type) {
    case 'context_stats': return `[t${e.turn}] context ${e.exactTokens !== undefined ? `${e.exactTokens} tok exact (~${e.estimatedTokens} est)` : `~${e.estimatedTokens} tok`}${e.droppedChars ? `, dropped ${e.droppedChars} chars` : ''}`
    case 'llm_request': return `[t${e.turn}] llm_request`
    case 'llm_response': return `[t${e.turn}] llm_response ${e.latencyMs}ms${e.usage ? ` (${e.usage.promptTokens}+${e.usage.completionTokens} tok)` : ''}${e.content && !streamed ? `\n    ${e.content.slice(0, 200).replace(/\n/g, ' ')}` : ''}`
    case 'parse_error': return `[t${e.turn}] parse_error: ${e.message}${e.droppedChars ? ` (${e.droppedChars} chars kept out of the history)` : ''}`
    case 'tool_call': return `[t${e.turn}] tool_call ${e.call.name} ${JSON.stringify(e.call.args).slice(0, 200)}`
    case 'mcp_server_start': return `mcp ${e.server}: ${mcpCounts(e)}`
    case 'approval_required': return `[t${e.turn}] approval_required ${e.call.name}`
    case 'tool_result': return `[t${e.turn}] tool_result ${e.name}${e.error ? ' (error)' : ''}${e.truncated ? ' (truncated)' : ''}: ${e.output.slice(0, 200).replace(/\n/g, ' ')}`
    case 'error': return `error: ${e.message}${e.body ? `\n${e.body}` : ''}`
    case 'done': return `done: ${e.reason} after ${e.turns} turns, ${e.toolCallCount} tool calls${quitWithoutWork(e) ? '  ! final after 0 tool calls' : ''}${e.text ? `\n${e.text}` : ''}`
  }
}

type ExecOpts = { yes: boolean; json: boolean; quiet?: boolean; signal?: AbortSignal; onEvent?: (e: HarnessEvent) => void; bench?: Meta['meta']['bench'] }

/** Runs one agent loop and keeps its trace in ./runs/<id>.jsonl, the file format serve reads. Written as .part and renamed when the loop ends, so a live or killed run is never listed. */
async function execRun(config: HarnessConfig, task: string, workdir: string, o: ExecOpts): Promise<{ id: string; last: HarnessEvent }> {
  const trace = new TraceWriter('runs', true)
  await trace.open({ harness: config.name, task, workdir, started: Date.now(), bench: o.bench })
  // Ctrl-C: keep what the run has written instead of leaving a .part nothing ever lists again
  // (serve appends the synthetic done for any trace that ends without one). bench registers its
  // own handler before ours and exits from it, so its .part stays for the Bench page to finish.
  const onSigint = () => { trace.closeSync(); process.exit(130) }
  if (!o.bench) process.once('SIGINT', onSigint)
  const rl = o.yes ? null : createInterface({ input: process.stdin, output: process.stderr })
  const approve = async (call: ToolCall) => {
    if (o.yes) return true
    const server = mcpApprovalServer(call.name)
    const what = server
      ? `start mcp server "${server}": ${call.args.command}`
      : `run bash: ${call.args.command}`
    const a = await rl!.question(`${what}\n[y/N] `)
    return /^y(es)?$/i.test(a.trim())
  }
  const opts: RunOpts = { approve, backend: await fakeBackendFromEnv(), signal: o.signal }
  // Live text only on a terminal: reasoning dim, content plain; a pipe, bench (quiet) and --json see events only.
  let streamed = false
  if (!o.quiet && process.stderr.isTTY) opts.onDelta = d => {
    if (d.reasoning) process.stderr.write(`\x1b[2m${d.reasoning}\x1b[0m`)
    if (d.content) process.stderr.write(d.content)
    streamed = true
  }
  let last: HarnessEvent | undefined
  try {
    for await (const e of runAgent({ config, task, workdir }, opts)) {
      last = e
      await trace.append(e)
      if (o.json) process.stdout.write(JSON.stringify(e) + '\n')
      if (streamed) process.stderr.write('\n')
      if (!o.quiet) console.error(describe(e, streamed))
      streamed = false // nothing yields during send, so any event ends the streamed stretch
      o.onEvent?.(e)
    }
  } finally {
    rl?.close()
    process.off('SIGINT', onSigint) // demo runs three harnesses in one process: a stale handler would rename the wrong run
  }
  await trace.close()
  if (!o.quiet) console.error(`trace ${trace.file}`)
  return { id: trace.id, last: last! }
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
  const { last } = await execRun(config, taskParts.join(' '), workdir, { yes: values.yes, json: values.json })
  process.exitCode = last.type === 'done' && last.reason === 'final' ? 0 : 1
}

async function cmdDemo(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { model: { type: 'string' }, 'base-url': { type: 'string' }, kind: { type: 'string' }, json: { type: 'boolean', default: false } } })
  const rows: string[] = []
  for (const name of DEMO_HARNESSES) {
    const config = await loadHarness(path.join(PKG_ROOT, 'harnesses', `${name}.json`), { model: values.model, baseUrl: values['base-url'], kind: values.kind })
    const workdir = await TASKS.slug.prepare()
    console.error(`\n=== ${name} (${config.backend.model}) in ${workdir}`)
    const { id, last } = await execRun(config, DEMO_TASK, workdir, { yes: true, json: values.json })
    const check = spawnSync('sh', [path.join(workdir, 'check.sh')])
    const verdict = check.status === 0 ? 'PASS' : 'FAIL'
    const d = last.type === 'done' ? last : undefined
    rows.push(`${name.padEnd(12)} ${verdict}  reason=${d?.reason ?? '?'} turns=${d?.turns ?? '?'} toolCalls=${d?.toolCallCount ?? '?'} trace=${id}`)
  }
  const summary = '\n' + rows.join('\n')
  if (values.json) console.error(summary)
  else console.log(summary)
}

const INT = /^[1-9]\d*$/
const stamp = (d: Date) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` }

/** One bench run: fresh demo workdir → execRun (timed) → check.sh. Never throws; an exception becomes a FAIL row with reason 'error'. */
async function benchOnce(config: HarnessConfig, round: number, timeoutS: number, out: string): Promise<BenchRun> {
  let workdir = '', parseErrors = 0, toolChars = 0, toolErrors = 0, guardBlocks = 0, editMiss = 0, lastError: string | undefined, t0 = Date.now(), run: BenchRun
  process.stderr.write(`${config.name} #${round} `)
  try {
    workdir = await TASKS.slug.prepare()
    process.stderr.write(`${workdir} ... `)
    t0 = Date.now()
    const { id, last } = await execRun(config, DEMO_TASK, workdir, {
      yes: true, json: false, quiet: true, signal: AbortSignal.timeout(timeoutS * 1000), bench: { file: path.basename(out), round },
      onEvent: e => {
        if (e.type === 'parse_error') parseErrors++
        if (e.type === 'mcp_server_start') toolChars += e.descriptionChars + e.schemaChars
        if (e.type === 'tool_result' && e.error) {
          toolErrors++
          if (e.output.includes(GUARD_BLOCKED)) guardBlocks++
          else if (e.output.includes(EDIT_MISS)) editMiss++
        }
        if (e.type === 'parse_error' || e.type === 'error') lastError = e.message
      },
    })
    const ms = Date.now() - t0
    const verdict = TASKS.slug.check(workdir) ? 'PASS' : 'FAIL'
    const d = last.type === 'done' ? last : undefined
    run = { round, verdict, reason: d?.reason ?? 'error', turns: d?.turns ?? 0, toolCalls: d?.toolCallCount ?? 0, parseErrors, lastError, ms, workdir, trace: id, toolChars: toolChars || undefined, toolErrors, guardBlocks: config.tools.requireReadBeforeEdit ? guardBlocks : undefined, editMiss }
  } catch (e) {
    run = { round, verdict: 'FAIL', reason: 'error', turns: 0, toolCalls: 0, parseErrors, lastError: String(e), ms: Date.now() - t0, workdir, toolChars: toolChars || undefined, toolErrors, guardBlocks: config.tools.requireReadBeforeEdit ? guardBlocks : undefined, editMiss }
  }
  const tail = (run.reason === 'error' || run.reason === 'aborted') && run.lastError ? `  ${run.lastError.replace(/\s+/g, ' ').slice(0, 200)}` : ''
  process.stderr.write(`${run.verdict}  reason=${run.reason} turns=${run.turns} toolCalls=${run.toolCalls} parseErrors=${run.parseErrors} ${Math.round(run.ms / 1000)}s${run.trace ? ` trace=${run.trace}` : ''}${tail}\n`)
  return run
}

function rollup(h: BenchHarness) {
  h.pass = h.runs.filter(r => r.verdict === 'PASS').length
  h.reasons = {}
  for (const r of h.runs) h.reasons[r.reason] = (h.reasons[r.reason] ?? 0) + 1
  h.median = { turns: median(h.runs.map(r => r.turns)), toolCalls: median(h.runs.map(r => r.toolCalls)), ms: median(h.runs.map(r => r.ms)) }
}

async function cmdBench(argv: string[]) {
  const usage = 'usage: llm-harness-builder bench [harness.json ...] [--n 3] [--timeout 1800] [--out runs/bench-<ts>.json] [--model m] [--base-url u] [--kind openai|ollama]'
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    n: { type: 'string', default: '3' }, timeout: { type: 'string', default: '1800' }, out: { type: 'string' },
    model: { type: 'string' }, 'base-url': { type: 'string' }, kind: { type: 'string' },
  } })
  if (!INT.test(values.n) || !INT.test(values.timeout)) die(usage)
  const n = Number(values.n), timeoutS = Number(values.timeout)
  const started = new Date()
  const out = values.out ?? path.join('runs', `bench-${stamp(started)}.json`)
  const localDir = path.join(process.cwd(), 'harnesses')
  const files = positionals.length ? positionals : DEMO_HARNESSES.map(h => path.join(existsSync(localDir) ? localDir : path.join(PKG_ROOT, 'harnesses'), `${h}.json`))
  const over = { model: values.model, baseUrl: values['base-url'], kind: values.kind }
  const harnesses: BenchHarness[] = []
  for (const f of files) {
    const config = await loadHarness(f, over)
    harnesses.push({ name: config.name, config, pass: 0, reasons: {}, median: { turns: 0, toolCalls: 0, ms: 0 }, runs: [] })
  }
  await mkdir(path.dirname(out), { recursive: true })
  const result: BenchResult = { version: 1, date: started.toISOString(), task: DEMO_TASK, n, timeoutS, complete: false, harnesses }
  // tmp + rename in the same directory: the SIGINT handler exits immediately, and a half-written
  // JSON would be the only thing left of a 90-minute run. `.tmp`, not `.json`, so /api/bench skips it.
  const tmpOut = `${out}.${process.pid}.tmp`
  const save = async () => { await writeFile(tmpOut, JSON.stringify(result, null, 2) + '\n'); await rename(tmpOut, out) }
  // write() with a callback, not console.log: on a pipe stdout is async, and the SIGINT handler's
  // exit() below would drop the table of a 90-minute run on the floor.
  const finish = (code?: number) => {
    console.error(`wrote ${out}`)
    process.stdout.write(formatTable(harnesses) + '\n', () => code !== undefined && process.exit(code))
  }
  // The first save happens before any run, so an unwritable --out (a directory, a bad path) is a
  // typo to report, not a crash after 90 minutes.
  await save().catch(e => die(`cannot write ${out}:\n  ${(e as Error).message}`))
  console.error(`bench: ${files.length} harnesses × ${n} runs, timeout ${timeoutS}s per run, writing ${out}`)
  files.forEach((f, i) => console.error(`  ${harnesses[i].name.padEnd(13)} ${f}`))
  process.once('SIGINT', () => finish(130))
  for (let round = 1; round <= n; round++) {
    console.error(`--- round ${round}/${n}`)
    for (const h of harnesses) {
      h.runs.push(await benchOnce(h.config, round, timeoutS, out))
      rollup(h)
      await save()
    }
  }
  result.complete = true
  await save()
  finish()
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
const commands: Record<string, (a: string[]) => Promise<void>> = { serve: cmdServe, run: cmdRun, demo: cmdDemo, bench: cmdBench }
if (!commands[cmd]) die('usage: llm-harness-builder [serve|run|demo|bench] ...')
commands[cmd](rest).catch(e => die(String(e?.stack ?? e)))
