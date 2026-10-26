#!/usr/bin/env node
// src/cli.ts
import { parseArgs } from 'node:util'
import { readFile, cp, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mayAsk, type RunOpts } from './core/run.js'
import { withNotes, type NotesStore } from './core/notes-run.js'
import { notesKey, notesPath, readNotes, selectNotes } from './core/notes.js'
import { validateConfig, sendsAnswerSchema, KEY_ENV, FLAG_WORDS, keyNameMessage, keyErrors, keyProblem, keyNote, apiKey, isHttpUrl, isLoopbackUrl, type HarnessConfig, type BackendKind } from './core/config.js'
import { validateWorkdir } from './core/tools/sandbox.js'
import type { Backend, Delta, NormalizedResponse } from './core/backends/types.js'
import { approvalPrompt, mcpCounts, quitWithoutWork, showable, showableText, type HarnessEvent, type ToolCall } from './core/events.js'
import { startServer } from './server/index.js'
import { TraceWriter, type Meta } from './server/runs.js'
import { TASKS, type Task } from './core/tasks.js'
import { childEnv, bashEnvNote } from './core/tools/env.js'
import { median, formatTable, benchFileName, autoApproves, type BenchRun, type BenchHarness, type BenchResult } from './core/bench.js'
import { GUARD_BLOCKED, EDIT_MISS } from './core/tools/fs.js'
import { createBackend } from './core/backends/index.js'
import { redactor } from './core/redact.js'
import { replayPayload, replySignature, recordedTurn } from './core/replay.js'
import { normalizeRequest } from './core/normalize.js'
import { analyzeTrace, formatAnalysisTable, type AnalyzedRun } from './core/analyze.js'
import { preflight, windowWarning, type PreflightResult } from './core/preflight.js'
import { knobsOff } from './core/knobs.js'
import { startProxy } from './core/proxy/server.js'
import { COMMANDS, isCommand, usage, commandHelp, overview, type CommandName } from './cli-help.js'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const die = (msg: string): never => { console.error(msg); process.exit(2) }
const PKG = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')) as { version: string; description: string }
/** A command's --help: printed before the command does anything, so `serve --help` copies nothing. */
const printHelp = (name: CommandName): void => { console.log(commandHelp(name)) }
/** An argument the command cannot take: what is wrong on one line (Node's own messages can run over several), then the command's usage; exit 2 like every other refusal. */
function argError(name: CommandName, msg: string): never { return die(`error: ${msg.replace(/\s*\n\s*/g, ' ')}\n${usage(name)}`) }
/** The name --api-key-env gives, checked before any harness is read: the message names the flag the user typed. */
function keyFlag(cmd: CommandName, v: string | undefined): void {
  if (v !== undefined && !KEY_ENV.test(v)) argError(cmd, keyNameMessage('--api-key-env'))
}
const PORT = (s: string) => /^\d+$/.test(s) && Number(s) <= 65535

const DEMO_HARNESSES = ['bare', 'tuned-nothink', 'tuned-hermes']
/** tuned-nothink sets backend.think, which config.ts refuses on a hosted API (openai kind with a key): there demo runs tuned. */
const demoHarnesses = (kind?: string, apiKeyEnv?: string): string[] => kind === 'openai' && apiKeyEnv ? DEMO_HARNESSES.map(h => h === 'tuned-nothink' ? 'tuned' : h) : DEMO_HARNESSES

let fakeCache: Promise<Backend | undefined> | undefined
/** Test hook: LHB_FAKE_BACKEND=<file.json> with an array of Partial<NormalizedResponse>; an entry may carry `deltas` as well, which stream to the terminal before its reply returns. One shared queue per process. */
function fakeBackendFromEnv(): Promise<Backend | undefined> {
  return (fakeCache ??= (async () => {
    const f = process.env.LHB_FAKE_BACKEND
    if (!f) return undefined
    const queue: (Partial<NormalizedResponse> & { deltas?: Delta[] })[] = JSON.parse(await readFile(f, 'utf8'))
    return {
      async listModels() { return ['fake'] }, buildPayload: r => r,
      async send(_payload: unknown, _signal?: AbortSignal, onDelta?: (d: Delta) => void) {
        const r = queue.shift()
        if (!r) throw new Error('fake backend: no more responses')
        const { deltas, ...reply } = r
        for (const d of deltas ?? []) onDelta?.(d)
        return { content: '', toolCalls: [], raw: {}, ...reply }
      },
    } as Backend
  })())
}

async function loadHarness(file: string, over: { model?: string; baseUrl?: string; kind?: string; apiKeyEnv?: string; maxTurns?: number }): Promise<HarnessConfig> {
  // One catch for the whole read: a missing file, a directory and malformed JSON all used to reach
  // the top-level handler and print a stack at someone who mistyped a path.
  let cfg: any
  try { cfg = JSON.parse(await readFile(file, 'utf8')) }
  catch (e) { return die(`cannot read harness ${file}:\n  ${(e as Error).message}`) }
  if (!cfg || typeof cfg.backend !== 'object' || cfg.backend === null) die(`invalid harness ${file}:\n  backend must be an object`)
  if (over.model) cfg.backend.model = over.model
  if (over.baseUrl) cfg.backend.baseUrl = over.baseUrl
  if (over.kind) cfg.backend.kind = over.kind
  if (over.apiKeyEnv !== undefined) cfg.backend.apiKeyEnv = over.apiKeyEnv
  // Only onto a loop object that is there: a harness without one is validateConfig's to report.
  if (over.maxTurns && cfg.loop && typeof cfg.loop === 'object') cfg.loop.maxTurns = over.maxTurns
  const errs = validateConfig(cfg)
  if (errs.length) die(`invalid harness ${file}:\n  ${errs.join('\n  ')}`)
  // The value the name points at: missing, empty or unsendable, nothing can run — and the message says where the name came from.
  const problem = keyProblem(cfg.backend, process.env)
  if (problem) die(`${problem}: ${over.apiKeyEnv !== undefined ? '--api-key-env names it as the API key' : `${file} sends its value as the API key (backend.apiKeyEnv)`}`)
  return cfg
}

/** The first 200 characters of someone else's text as one line: newlines flattened, every character a terminal would act
 *  on escaped (see showable), and the cut at 200 made after that, so the line cannot grow past 200 characters. */
const excerpt = (s: string): string => showable(s.slice(0, 200).replace(/\n/g, ' ')).slice(0, 200)

/** One line per event (a few for an error body or the final text). Text that the model, a file, a command's output or the
 *  server wrote lands here, and the next thing on the screen may be the question whether to run a command: such text goes
 *  through showable (one line) or showableText (lines), never as it is. `streamed`: the turn's text was already written
 *  live to stderr, so llm_response skips its excerpt. */
function describe(e: HarnessEvent, streamed = false, cost?: number): string {
  switch (e.type) {
    case 'context_stats': return `[t${e.turn}] context ${e.exactTokens !== undefined ? `${e.exactTokens} tok exact (~${e.estimatedTokens} est)` : `~${e.estimatedTokens} tok`}${e.droppedChars ? `, dropped ${e.droppedChars} chars` : ''}`
    case 'llm_request': return `[t${e.turn}] llm_request`
    case 'llm_response': return `[t${e.turn}] llm_response ${e.latencyMs}ms${e.usage ? ` (${e.usage.promptTokens}+${e.usage.completionTokens} tok)` : ''}${e.content && !streamed ? `\n    ${excerpt(e.content)}` : ''}`
    case 'parse_error': return `[t${e.turn}] parse_error: ${showable(e.message)}${e.droppedChars ? ` (${e.droppedChars} chars kept out of the history)` : ''}`
    case 'tool_call': return `[t${e.turn}] tool_call ${showable(e.call.name)} ${showable(JSON.stringify(e.call.args)).slice(0, 200)}`
    case 'mcp_server_start': return `mcp ${showable(e.server)}: ${mcpCounts(e)}`
    case 'final_check': return `[t${e.turn}] final_check ${e.passed ? 'passed' : 'failed'}: ${showable(e.command)}${e.passed ? '' : `\n    ${excerpt(e.output)}`}`
    case 'context_reset': return `[t${e.turn}] context_reset: ${e.chars} chars of history cleared, the next request is the task again`
    case 'approval_required': return `[t${e.turn}] approval_required ${showable(e.call.name)}`
    case 'tool_result': return `[t${e.turn}] tool_result ${showable(e.name)}${e.error ? ' (error)' : ''}${e.truncated ? ' (truncated)' : ''}: ${excerpt(e.output)}`
    case 'knobs_off': return e.off.map(o => `${o.knob} ${showable(JSON.stringify(o.value))} not sent: ${showable(o.reason)}`).join('\n')
    case 'proxy_note': return e.kind === 'compaction' ? `[t${e.turn}] compaction` : `[t${e.turn}] auxiliary ${showable(e.model ?? '')} ${e.error !== undefined ? `failed: ${showable(e.error)}` : `${e.latencyMs}ms${e.usage ? ` (${e.usage.promptTokens}+${e.usage.completionTokens} tok)` : ''}`}`
    case 'notes_loaded': return `notes: ${e.ids.length} loaded (${e.chars} chars)`
    case 'note_written': return e.error !== undefined ? `note not written: ${showable(e.error)}` : e.notes.length ? e.notes.map(n => `note: ${showable(n.text)}`).join('\n') : 'note: nothing new'
    case 'error': return `error: ${showable(e.message)}${e.body ? `\n${showableText(e.body)}` : ''}`
    case 'done': return `done: ${e.reason} after ${e.turns} turns, ${e.toolCallCount} tool calls${cost === undefined ? '' : ` · $${Number(cost.toPrecision(4))} total`}${quitWithoutWork(e) ? '  ! final after 0 tool calls' : ''}${e.text ? `\n${showableText(e.text)}` : ''}`
  }
}

type ExecOpts = { yes: boolean; json: boolean; quiet?: boolean; signal?: AbortSignal; onEvent?: (e: HarnessEvent) => void; bench?: Meta['meta']['bench']; answerSchema?: Record<string, unknown>; notes?: NotesStore }

/** Runs one agent loop and keeps its trace in ./runs/<id>.jsonl, the file format serve reads. Written as .part and renamed when the loop ends, so a live or killed run is never listed. */
async function execRun(config: HarnessConfig, task: string, workdir: string, o: ExecOpts): Promise<{ id: string; last: HarnessEvent }> {
  // The task goes to the server as typed; the trace's first line is a file like the events after it, so it has no key in it.
  const redact = redactor(apiKey(config.backend, process.env), config.backend.apiKeyEnv ?? '')
  const trace = new TraceWriter('runs', true)
  await trace.open({ harness: config.name, task: redact.text(task), workdir, started: Date.now(), bench: o.bench })
  // Ctrl-C: keep what the run has written instead of leaving a .part nothing ever lists again
  // (serve appends the synthetic done for any trace that ends without one). bench registers its
  // own handler before ours and exits from it, so its .part stays for the Bench page to finish.
  const onSigint = (): never => { trace.closeSync(); process.exit(130) }
  if (!o.bench) process.once('SIGINT', onSigint)
  // One readline for the whole run, and not a terminal one: it never puts the tty in raw mode, so Ctrl-C is a
  // SIGINT that onSigint answers, at the question as well as mid-run. A line typed while the model works is read at
  // once and dropped (no question is pending, so nobody listens to it): it cannot answer a question its typist has
  // not seen. Ctrl-D (EOF) at the question, or an input that is already closed, ends the run the way Ctrl-C does.
  const rl = o.yes ? null : createInterface({ input: process.stdin, output: process.stderr, terminal: false })
  let inputClosed = false
  const closed = new Promise<null>(resolve => rl?.once('close', () => { inputClosed = true; resolve(null) }))
  // On a terminal the question starts with an attribute reset: whatever was set before it (conceal, a colour that
  // matches the background) cannot carry into the text the answer is decided by.
  const reset = process.stderr.isTTY ? '\x1b[0m' : ''
  const approve = async (call: ToolCall) => {
    if (!rl) return true
    const answer = inputClosed ? null : await Promise.race([closed, rl.question(`${reset}${approvalPrompt(call)}\n[y/N] `)])
    return answer === null ? onSigint() : /^y(es)?$/i.test(answer.trim())
  }
  const opts: RunOpts = { approve, backend: await fakeBackendFromEnv(), signal: o.signal }
  // Live text only on a terminal: reasoning dim, content plain; a pipe, bench (quiet) and --json see events only.
  let streamed = false
  // The text is the model's own, so it goes through showableText: only the dim and the reset around the reasoning are ours.
  if (!o.quiet && process.stderr.isTTY) opts.onDelta = d => {
    if (d.reasoning) process.stderr.write(`\x1b[2m${showableText(d.reasoning)}\x1b[0m`)
    if (d.content) process.stderr.write(showableText(d.content))
    streamed = true
  }
  let last: HarnessEvent | undefined, cost: number | undefined
  try {
    if (o.notes && config.notes?.enabled && !o.quiet)
      console.error(`notes: ${selectNotes(await readNotes(o.notes.file), config.notes.maxTokens).length} loaded from ${shortHome(o.notes.file)}`)
    for await (const e of withNotes({ config, task, workdir, answerSchema: o.answerSchema }, opts, o.notes, trace.id)) {
      last = e
      if ((e.type === 'llm_response' || e.type === 'note_written') && e.costUsd !== undefined) cost = (cost ?? 0) + e.costUsd
      await trace.append(e)
      if (o.json) process.stdout.write(JSON.stringify(e) + '\n')
      if (streamed) process.stderr.write('\n')
      if (!o.quiet) console.error(describe(e, streamed, cost))
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

/** A path under the home dir as ~/…, for the terminal. */
const shortHome = (p: string): string => { const h = homedir(); return p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p }

const NO_TTY = 'stdin is not a terminal, so nothing can answer an approval prompt: pass --yes to approve every command, or run in a terminal'

async function cmdRun(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: COMMANDS.run.options })
  if (values.help) return printHelp('run')
  keyFlag('run', values['api-key-env'])
  const [file, ...taskParts] = positionals
  if (!file || !taskParts.length) argError('run', 'run needs a harness file and a task')
  const workdir = path.resolve(values.workdir ?? '.')
  const werr = await validateWorkdir(workdir); if (werr) die(werr)
  const config = await loadHarness(file, { model: values.model, baseUrl: values['base-url'], kind: values.kind, apiKeyEnv: values['api-key-env'] })
  // A schema the harness would not send is a run whose answer nothing holds to a form, and it would look like any other: refuse it here.
  let answerSchema: Record<string, unknown> | undefined
  const schemaFile = values['answer-schema']
  if (schemaFile !== undefined) {
    if (!sendsAnswerSchema(config)) die(`--answer-schema needs a harness that sends it: toolCalls.mode "native", toolCalls.enforceSchema true, no tools enabled and no mcpServers (${file} is not one)`)
    try { answerSchema = JSON.parse(await readFile(schemaFile, 'utf8')) }
    catch (e) { die(`cannot read answer schema ${schemaFile}:\n  ${(e as Error).message}`) }
    if (typeof answerSchema !== 'object' || answerSchema === null || Array.isArray(answerSchema)) die(`answer schema ${schemaFile} must hold a JSON object`)
  }
  // On a pipe or /dev/null nobody can answer: the run would end at its first question as if interrupted (exit 130, input at EOF) or wait for it forever (input open).
  if (!values.yes && process.stdin.isTTY !== true && mayAsk(config)) die(NO_TTY)
  const note = bashEnvNote(config.tools.bashEnv)
  if (note) console.error(note)
  const key = keyNote(config.backend, process.env)
  if (key) console.error(key)
  const notes = { file: notesPath(await notesKey(workdir)), write: true }
  const { last } = await execRun(config, taskParts.join(' '), workdir, { yes: values.yes, json: values.json, answerSchema, notes })
  const final = last.type === 'done' && last.reason === 'final' ? last : undefined
  let ok = final !== undefined
  // The schema is the server's to enforce, and a server may ignore it; then the same JSON comes back inside a fence. Whether it fits the schema is the caller's to check.
  if (final && answerSchema) try { JSON.parse(final.text ?? '') } catch { ok = false; console.error('final answer is not JSON: the server did not hold it to --answer-schema') }
  process.exitCode = ok ? 0 : 1
}

/**
 * Asks each distinct backend once, before any run: down, no such model, a knob the harness cannot do without. Prints the window it found; returns the refusal, if any.
 * The test backend is the network itself; there is no server behind it to ask.
 */
async function preflightAll(hs: { name: string; config: HarnessConfig; server?: BenchHarness['server'] }[], task: Task, size?: number): Promise<string | undefined> {
  if (await fakeBackendFromEnv()) return undefined
  const asked = new Map<string, PreflightResult>()
  for (const h of hs) {
    const b = h.config.backend, key = `${b.kind} ${b.baseUrl} ${b.model} ${b.numCtx ?? ''} ${b.apiKeyEnv ?? ''}`
    let r = asked.get(key)
    if (!r) {
      asked.set(key, r = await preflight(createBackend(b), b))
      if (r.ok) console.error(`preflight: ${b.baseUrl} ${b.model}: window ${r.server.nCtx ?? 'unknown'}${r.server.build ? `, build ${showable(r.server.build)}` : ''}`)
    }
    if (!r.ok) return showable(redactor(apiKey(b, process.env), b.apiKeyEnv ?? '').text(r.message))
    h.server = r.server
    // A knob without which the harness would be another one is a refusal before any run, like a model that is not there.
    const refuse = knobsOff(h.config, r.server, task.answerSchema?.(size)).refuse
    if (refuse) return showable(`preflight: ${h.name}: ${refuse}`)
    const w = windowWarning(h.config, r.server.nCtx)
    if (w) console.error(w)
  }
}

async function cmdDemo(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: COMMANDS.demo.options })
  if (values.help) return printHelp('demo')
  keyFlag('demo', values['api-key-env'])
  console.error(autoApproves('demo'))
  const names = demoHarnesses(values.kind, values['api-key-env'])
  const configs = await Promise.all(names.map(name => loadHarness(path.join(PKG_ROOT, 'harnesses', `${name}.json`), { model: values.model, baseUrl: values['base-url'], kind: values.kind, apiKeyEnv: values['api-key-env'] })))
  // Not die(): exit 2 is for a bad command line; a server that is not up yet is the newcomer's first stumble.
  const no = await preflightAll(configs.map(config => ({ name: config.name, config })), TASKS.slug)
  if (no) { console.error(no); process.exitCode = 1; return }
  const rows: string[] = []
  for (const [i, name] of names.entries()) {
    const config = configs[i]
    const note = bashEnvNote(config.tools.bashEnv)
    if (note) console.error(`${name}: ${note}`)
    const key = keyNote(config.backend, process.env)
    if (key) console.error(`${name}: ${key}`)
    const workdir = await TASKS.slug.prepare()
    console.error(`\n=== ${name} (${config.backend.model}) in ${workdir}`)
    const { id, last } = await execRun(config, TASKS.slug.prompt, workdir, { yes: true, json: values.json })
    // The same check bench runs: the model's code, the environment its bash had, and a 60 s limit.
    const verdict = TASKS.slug.check(workdir, undefined, undefined, childEnv(config.tools.bashEnv)) ? 'PASS' : 'FAIL'
    const d = last.type === 'done' ? last : undefined
    rows.push(`${name.padEnd(12)} ${verdict}  reason=${d?.reason ?? '?'} turns=${d?.turns ?? '?'} toolCalls=${d?.toolCallCount ?? '?'} trace=${id}`)
  }
  const summary = '\n' + rows.join('\n')
  if (values.json) console.error(summary)
  else console.log(summary)
}

const INT = /^[1-9]\d*$/

/** One bench run: fresh task workdir → execRun (timed) → the task's check. Never throws; an exception becomes a FAIL row with reason 'error'. */
async function benchOnce(config: HarnessConfig, round: number, timeoutS: number, out: string, task: Task, taskName: string, size?: number): Promise<BenchRun> {
  // An exception that escapes execRun is text nothing has cleaned yet, and it goes to the bench JSON and the terminal.
  const redact = redactor(apiKey(config.backend, process.env), config.backend.apiKeyEnv ?? '')
  let workdir = '', parseErrors = 0, toolChars = 0, costUsd: number | undefined, peakTokens: number | undefined, toolErrors = 0, guardBlocks = 0, editMiss = 0, lastError: string | undefined, t0 = Date.now(), run: BenchRun
  process.stderr.write(`${config.name} #${round} `)
  try {
    workdir = await task.prepare(size)
    process.stderr.write(`${workdir} ... `)
    t0 = Date.now()
    const { id, last } = await execRun(config, task.input ? `${task.prompt}\n\n${task.input(size)}` : task.prompt, workdir, {
      yes: true, json: false, quiet: true, answerSchema: task.answerSchema?.(size), signal: AbortSignal.timeout(timeoutS * 1000), bench: { file: path.basename(out), round },
      // Read, never written: a note from run 1 would make run 2 depend on it, and the bench's runs must stay independent.
      notes: { file: notesPath(`task-${taskName}`), write: false },
      onEvent: e => {
        if (e.type === 'parse_error') parseErrors++
        if (e.type === 'llm_response' && e.costUsd !== undefined) costUsd = (costUsd ?? 0) + e.costUsd
        if (e.type === 'llm_response' && e.usage) peakTokens = Math.max(peakTokens ?? 0, e.usage.promptTokens + e.usage.completionTokens)
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
    const d = last.type === 'done' ? last : undefined
    const verdict = task.check(workdir, size, d?.reason === 'final' ? d.text : undefined, childEnv(config.tools.bashEnv)) ? 'PASS' : 'FAIL'
    run = { round, verdict, reason: d?.reason ?? 'error', turns: d?.turns ?? 0, toolCalls: d?.toolCallCount ?? 0, parseErrors, lastError, ms, workdir, trace: id, toolChars: toolChars || undefined, costUsd, peakTokens, toolErrors, guardBlocks: config.tools.requireReadBeforeEdit ? guardBlocks : undefined, editMiss }
  } catch (e) {
    run = { round, verdict: 'FAIL', reason: 'error', turns: 0, toolCalls: 0, parseErrors, lastError: redact.text(String(e)), ms: Date.now() - t0, workdir, toolChars: toolChars || undefined, costUsd, peakTokens, toolErrors, guardBlocks: config.tools.requireReadBeforeEdit ? guardBlocks : undefined, editMiss }
  }
  const tail = (run.reason === 'error' || run.reason === 'aborted') && run.lastError ? `  ${showable(run.lastError.replace(/\s+/g, ' ').slice(0, 200))}` : ''
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
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: COMMANDS.bench.options })
  if (values.help) return printHelp('bench')
  keyFlag('bench', values['api-key-env'])
  if (!INT.test(values.n)) argError('bench', '--n must be a positive integer')
  if (!INT.test(values.timeout)) argError('bench', '--timeout must be a positive integer')
  const task: Task | undefined = Object.hasOwn(TASKS, values.task) ? TASKS[values.task as keyof typeof TASKS] : undefined
  if (!task) argError('bench', `--task must be one of ${Object.keys(TASKS).join('|')}`)
  const size = values.size === undefined ? undefined : Number(values.size)
  // A task with sizes needs one in range; a task without sizes takes none.
  const sizeOk = task.max === undefined ? size === undefined : values.size !== undefined && INT.test(values.size) && size! <= task.max
  if (!sizeOk) argError('bench', task.max === undefined ? `--size: ${values.task} has no sizes` : `--size must be an integer from 1 to ${task.max} for ${values.task}`)
  if (values['max-turns'] !== undefined && !INT.test(values['max-turns'])) argError('bench', '--max-turns must be a positive integer')
  const n = Number(values.n), timeoutS = Number(values.timeout)
  const started = new Date()
  const out = values.out ?? path.join('runs', benchFileName(started))
  // Per file: a ./harnesses copied by an older version lacks the newer shipped ones.
  const localDir = path.join(process.cwd(), 'harnesses')
  const files = positionals.length ? positionals : demoHarnesses(values.kind, values['api-key-env']).map(h => [path.join(localDir, `${h}.json`), path.join(PKG_ROOT, 'harnesses', `${h}.json`)].find(existsSync)!)
  const over = { model: values.model, baseUrl: values['base-url'], kind: values.kind, apiKeyEnv: values['api-key-env'], maxTurns: values['max-turns'] === undefined ? undefined : Number(values['max-turns']) }
  console.error(autoApproves('bench'))
  const harnesses: BenchHarness[] = []
  for (const f of files) {
    const config = await loadHarness(f, over)
    harnesses.push({ name: config.name, config, pass: 0, reasons: {}, median: { turns: 0, toolCalls: 0, ms: 0 }, runs: [] })
  }
  for (const h of harnesses) {
    const note = bashEnvNote(h.config.tools.bashEnv)
    if (note) console.error(`${h.name}: ${note}`)
    const key = keyNote(h.config.backend, process.env)
    if (key) console.error(`${h.name}: ${key}`)
  }
  // Before any JSON exists: a server that is down, or lacks the model, is a typo to report, not 90 minutes of 'error' rows.
  const no = await preflightAll(harnesses, task, size)
  if (no) die(no)
  await mkdir(path.dirname(out), { recursive: true })
  const result: BenchResult = { version: 1, date: started.toISOString(), task: task.prompt, taskName: values.task, size, node: process.version, n, timeoutS, complete: false, harnesses }
  // tmp + rename in the same directory: the SIGINT handler exits immediately, and a half-written
  // JSON would be the only thing left of a 90-minute run. `.tmp`, not `.json`, so /api/bench skips it.
  const tmpOut = `${out}.${process.pid}.tmp`
  // Synchronous: the SIGINT handler saves too, and can then never land between another save's write and rename.
  const save = () => { writeFileSync(tmpOut, JSON.stringify(result, null, 2) + '\n'); renameSync(tmpOut, out) }
  // write() with a callback, not console.log: on a pipe stdout is async, and the SIGINT handler's
  // exit() below would drop the table of a 90-minute run on the floor.
  const finish = (code?: number) => {
    console.error(`wrote ${out}`)
    process.stdout.write(formatTable(harnesses) + '\n', () => code !== undefined && process.exit(code))
  }
  // The first save happens before any run, so an unwritable --out (a directory, a bad path) is a
  // typo to report, not a crash after 90 minutes.
  try { save() } catch (e) { die(`cannot write ${out}:\n  ${(e as Error).message}`) }
  console.error(`bench: ${files.length} harnesses × ${n} runs, timeout ${timeoutS}s per run, writing ${out}`)
  files.forEach((f, i) => console.error(`  ${harnesses[i].name.padEnd(13)} ${f}`))
  // bench never writes notes, and nothing else writes a task's file: an empty one means this bench measures notes off.
  for (const h of harnesses) if (h.config.notes?.enabled) {
    const file = notesPath(`task-${values.task}`), n = (await readNotes(file)).length
    console.error(`  ${h.name}: notes on, ${n ? `${n} in` : 'none in'} ${shortHome(file)}${n ? '' : ' — this bench runs as with notes off'}`)
  }
  // A failed write still prints the table: the terminal then holds what the JSON could not.
  process.once('SIGINT', () => { result.stopped = true; try { save() } catch (e) { console.error(`cannot write ${out}: ${(e as Error).message}`) } finish(130) })
  for (let round = 1; round <= n; round++) {
    console.error(`--- round ${round}/${n}`)
    for (const h of harnesses) {
      h.runs.push(await benchOnce(h.config, round, timeoutS, out, task, values.task, size))
      rollup(h)
      save()
    }
  }
  result.complete = true
  save()
  finish()
}

/** Sends the recorded request of one turn again, as it was sent, and counts the distinct replies. No tool runs: one reply says where the next call goes, not how the run ends. */
async function cmdReplay(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: COMMANDS.replay.options })
  if (values.help) return printHelp('replay')
  keyFlag('replay', values['api-key-env'])
  const [run] = positionals, kind = values.kind, baseUrl = values['base-url']
  const temperature = values.temperature === undefined ? undefined : Number(values.temperature)
  const INT = /^[1-9]\d*$/
  if (!run || positionals.length > 1) argError('replay', 'replay needs one run id or trace file')
  if (!INT.test(values.turn ?? '')) argError('replay', '--turn must be a positive integer')
  if (!INT.test(values.n)) argError('replay', '--n must be a positive integer')
  if (values['max-tokens'] !== undefined && !INT.test(values['max-tokens'])) argError('replay', '--max-tokens must be a positive integer')
  if (kind === 'anthropic') argError('replay', '--kind anthropic is not yet supported by replay')
  if (kind !== 'openai' && kind !== 'ollama') argError('replay', '--kind must be openai or ollama')
  // Not the prefix alone: `http://` has it, keyErrors does not judge a URL that does not parse, and the request would go to host "chat" (http:/chat/completions).
  if (!isHttpUrl(baseUrl)) argError('replay', '--base-url must be an http(s) URL')
  const keyEnv = values['api-key-env']
  const keyErrs = keyErrors({ kind, baseUrl, apiKeyEnv: keyEnv }, FLAG_WORDS)
  if (keyErrs.length) argError('replay', keyErrs.join('; '))
  if (temperature !== undefined && !(values.temperature!.trim() && temperature >= 0 && temperature <= 2)) argError('replay', '--temperature must be a number from 0 to 2')
  const file = run!.endsWith('.jsonl') ? run! : path.join('runs', `${run}.jsonl`)
  let rec: ReturnType<typeof recordedTurn>
  try {
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
    rec = recordedTurn(lines, Number(values.turn))
  }
  catch (e) { return die(`cannot replay ${file}:\n  ${(e as Error).message}`) }
  if (normalizeRequest(rec.payload)?.format === 'anthropic') die(`cannot replay ${file}:\n  a recorded Anthropic request is not yet supported by replay`)
  // Before the first request: check the value the name points at and say where it goes. A server's error can echo the key back, so that text is redacted.
  const keyed = { apiKeyEnv: keyEnv, baseUrl }
  const problem = keyProblem(keyed, process.env)
  if (problem) die(`${problem}: --api-key-env names it as the API key`)
  const note = keyNote(keyed, process.env)
  if (note) console.error(note)
  const redact = redactor(apiKey(keyed, process.env), keyEnv ?? '')
  const payload = replayPayload(rec.payload, kind as BackendKind, { temperature, maxTokens: values['max-tokens'] === undefined ? undefined : Number(values['max-tokens']) })
  const backend = (await fakeBackendFromEnv()) ?? createBackend({ kind: kind as BackendKind, baseUrl: baseUrl!, model: '', temperature: 0, ...(keyEnv ? { apiKeyEnv: keyEnv } : {}) })
  const recorded = rec.raw === undefined ? undefined : replySignature(rec.raw)
  const replies = new Map<string, { count: number; sameAsRecorded: boolean; promptTokens?: number; truncated: boolean }>()
  for (let i = 0; i < Number(values.n); i++) {
    const r = await backend.send(payload).catch(e => die(`backend: ${showable(redact.text((e as Error).message))}${(e as { body?: string }).body ? `\n${showableText(redact.text((e as { body?: string }).body!))}` : ''}`))
    const sig = replySignature(r.raw), seen = replies.get(sig)
    if (seen) seen.count++
    else replies.set(sig, { count: 1, sameAsRecorded: sig === recorded, promptTokens: r.usage?.promptTokens, truncated: !!r.truncated })
    if (!values.json) console.error(`sample ${i + 1}/${values.n}: ${sig === recorded ? 'same as recorded' : 'differs'}`)
  }
  const out = [...replies].map(([reply, v]) => ({ ...v, reply })).sort((a, b) => b.count - a.count)
  if (values.json) { console.log(JSON.stringify({ trace: file, turn: Number(values.turn), n: Number(values.n), payload, recorded, replies: out })); return }
  console.log(`${file} turn ${values.turn}: ${values.n} samples${temperature === undefined ? '' : ` at temperature ${temperature}`}, ${out.length} distinct${recorded === undefined ? '; the recorded turn has no reply to compare with' : ''}`)
  for (const o of out) console.log(`  ${o.count}x ${o.sameAsRecorded ? 'same as recorded' : 'differs'}${o.truncated ? ', cut by max tokens' : ''}${o.promptTokens === undefined ? '' : `, ${o.promptTokens} prompt tok`}\n     ${o.reply.slice(0, 300).replace(/\n/g, ' ')}`)
}

/** A trace file's meta line and events; a half-written last line is skipped, as replay and serve do. */
async function readTraceFile(file: string): Promise<{ harness?: string; events: HarnessEvent[] }> {
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
  const meta = lines.find(l => 'meta' in l)?.meta as Meta['meta'] | undefined
  return { harness: meta?.harness, events: lines.filter(l => !('meta' in l)) }
}

/** One argument of analyze: a bench JSON (its runs' traces sit next to it), or one trace by id or path. */
async function analyzeArg(arg: string): Promise<AnalyzedRun[]> {
  if (arg.endsWith('.json')) {
    const b = JSON.parse(await readFile(arg, 'utf8')) as BenchResult
    if (b?.version !== 1 || !Array.isArray(b.harnesses)) throw new Error('not a bench JSON')
    const out: AnalyzedRun[] = []
    for (const h of b.harnesses) for (const r of h.runs ?? []) {
      const verdict = `${r.verdict} ${r.reason}`
      if (!r.trace) { out.push({ harness: h.name, run: '—', verdict, turns: r.turns, analysis: null }); continue }
      // Next to the JSON by default; `bench --out elsewhere` still writes the traces to runs/.
      const near = path.join(path.dirname(arg), `${r.trace}.jsonl`)
      const { events } = await readTraceFile(existsSync(near) ? near : path.join('runs', `${r.trace}.jsonl`))
      out.push({ harness: h.name, run: r.trace, verdict, turns: r.turns, analysis: analyzeTrace(events) })
    }
    return out
  }
  const file = /\.jsonl(\.part)?$/.test(arg) ? arg : path.join('runs', `${arg}.jsonl`)
  const { harness, events } = await readTraceFile(file)
  const a = analyzeTrace(events)
  return [{ harness: harness ?? '?', run: path.basename(file).replace(/\.jsonl(\.part)?$/, ''), verdict: a.done?.reason ?? '—', turns: a.done?.turns ?? 0, analysis: a }]
}

/** What each budget stub removed, the first edit and the loop file, per run. Reads traces only; no model. */
async function cmdAnalyze(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: COMMANDS.analyze.options })
  if (values.help) return printHelp('analyze')
  if (!positionals.length) argError('analyze', 'analyze needs at least one bench JSON, run id or trace file')
  const rows: AnalyzedRun[] = []
  for (const arg of positionals) {
    try { rows.push(...await analyzeArg(arg)) }
    catch (e) { die(`cannot analyze ${arg}:\n  ${(e as Error).message}`) }
  }
  console.log(values.json ? JSON.stringify(rows) : formatAnalysisTable(rows))
}

async function cmdServe(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: COMMANDS.serve.options })
  if (values.help) return printHelp('serve')
  if (!PORT(values.port)) argError('serve', '--port must be an integer from 0 to 65535')
  const cwd = process.cwd()
  const harnessesDir = path.join(cwd, 'harnesses')
  // Adds the shipped harnesses that are missing; never overwrites an edited copy.
  await cp(path.join(PKG_ROOT, 'harnesses'), harnessesDir, { recursive: true, force: false, errorOnExist: false })
  const fake = await fakeBackendFromEnv()
  const srv = await startServer({
    port: Number(values.port), runsDir: path.join(cwd, 'runs'), harnessesDir, examplesDir: path.join(PKG_ROOT, 'example-runs'),
    staticDir: path.join(PKG_ROOT, 'web', 'dist'), backendFactory: fake ? () => fake : undefined,
    // This very CLI, under the same node flags (tsx in development), in serve's cwd: its traces land in the runs/ serve reads.
    bench: args => spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), 'bench', ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'] }),
  })
  const url = `http://localhost:${srv.port}`
  console.error(`llm-harness-builder serving on ${url}  (harnesses: ${harnessesDir}, runs: ${path.join(cwd, 'runs')})`)
  if (!values['no-open']) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
}

/** Sits between another agent and the server; forwards everything, records chat completions into ./runs, live. */
async function cmdProxy(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: COMMANDS.proxy.options })
  if (values.help) return printHelp('proxy')
  if (positionals.length) argError('proxy', 'proxy takes no positional arguments')
  if (!/^https?:\/\/[^/]/.test(values.upstream)) argError('proxy', '--upstream must be an http(s) URL')
  if (!PORT(values.port)) argError('proxy', '--port must be an integer from 0 to 65535')
  // The agent's key rides on every forwarded request: it must not leave in clear text or be shadowed by one in the URL.
  const u = new URL(values.upstream)
  if (u.username || u.password) argError('proxy', '--upstream must not carry a login or password')
  if (/[?#]/.test(values.upstream)) argError('proxy', '--upstream must not carry a query or fragment')
  if (u.protocol === 'http:' && !isLoopbackUrl(values.upstream)) argError('proxy', '--upstream over http must be a loopback address; use https')
  const upstream = values.upstream.replace(/\/+$/, '')
  if (/\/v1$/.test(upstream)) die(`--upstream is the server root, not its /v1: try ${upstream.slice(0, -3)}`)
  const runsDir = path.join(process.cwd(), 'runs')
  const p = await startProxy({ upstream, port: Number(values.port), runsDir, harness: values.name, log: l => console.error(l) })
    .catch(e => die(`proxy: ${(e as Error).message}`))
  console.error(`proxy on http://127.0.0.1:${p.port}/v1 -> ${upstream}  (runs: ${runsDir}); give the agent that base URL`)
  console.error(`for Claude Code: ANTHROPIC_BASE_URL=http://127.0.0.1:${p.port}`)
  // Stopping is how a proxy session ends, so it exits 0, not run's 130. A second signal while
  // stopping force-exits with 130 instead, in case the graceful stop is stuck: any run this leaves
  // without a `done` gets the usual `aborted` repair from serve once this process's pid is gone.
  let stopping = false
  const stop = () => {
    if (stopping) process.exit(130)
    stopping = true
    p.stop().then(() => process.exit(0), e => die(`proxy: ${(e as Error).message}`))
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
}

const commands: Record<CommandName, (a: string[]) => Promise<void>> = { serve: cmdServe, run: cmdRun, demo: cmdDemo, bench: cmdBench, replay: cmdReplay, analyze: cmdAnalyze, proxy: cmdProxy }
function unknownCommand(c: string): never { return die(`error: unknown command "${c}"\n\n${overview(PKG.description)}`) }

const [cmd = 'serve', ...rest] = process.argv.slice(2)
if (cmd === '--version' || cmd === '-v') console.log(PKG.version)
else if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  const [about] = rest
  if (about === undefined) console.log(overview(PKG.description))
  else if (isCommand(about)) printHelp(about)
  else unknownCommand(about)
}
else if (!isCommand(cmd)) unknownCommand(cmd)
else commands[cmd](rest).catch(e => {
  // A flag the command does not take, a positional it has no place for: Node's message names it.
  if (typeof e?.code === 'string' && e.code.startsWith('ERR_PARSE_ARGS_')) argError(cmd, e.message)
  die(String(e?.stack ?? e))
})
