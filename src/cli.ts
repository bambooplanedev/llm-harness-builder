#!/usr/bin/env node
// src/cli.ts
import { parseArgs } from 'node:util'
import { readFile, writeFile, cp, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, lstatSync, truncateSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mayAsk, type RunOpts } from './core/run.js'
import { killTracked } from './core/procs.js'
import { withNotes, type NotesStore } from './core/notes-run.js'
import { notesKey, notesPath, readNotes, scrubText, stateDir } from './core/notes.js'
import { smallestGain } from './core/stats.js'
import { costOf } from './core/cost.js'
import { ALLOWED, CANDIDATES, type EvolveMode, MODES, ROUNDS, numbersOf, runCount, splitSets, splitOf, referenceLabel, neededFlips, usable, decideRound, sweptCands, applyEdit, bindingTokens, checkEdit, failureGroups, signatureOf, proposerInput, proposerRequest, parseProposal, parseJournal, replay, spent, type Edit, type JournalLine, type RunLite, type SetName } from './core/evolve.js'
import { evolveReport } from './core/evolve-report.js'
import { loadRepoTasks, hostOf, consentText, hasConsent, saveConsent, git, TASKS_FILE, type RepoTasks, type EvolveConsent } from './core/repo-tasks.js'
import { cloneAt, linkNodeModules, protectedChanged, runCheck, finishRun, removeAllClonesSync, prepareModules, modulesManifest, modulesTampered, type Clone } from './core/repo-clone.js'
import { validateConfig, sendsAnswerSchema, KEY_ENV, FLAG_WORDS, keyNameMessage, keyErrors, keyProblem, keyNote, apiKey, NO_THINK_LINE, isHttpUrl, isLoopbackUrl, type HarnessConfig, type BackendKind } from './core/config.js'
import { validateWorkdir } from './core/tools/sandbox.js'
import { BackendError, isStop, sendRetrying, type Backend, type ChatRequest, type Delta, type NormalizedResponse } from './core/backends/types.js'
import { approvalPrompt, mcpCounts, quitWithoutWork, showable, showableText, type HarnessEvent, type ToolCall } from './core/events.js'
import { startServer } from './server/index.js'
import { TraceWriter, type Meta } from './server/runs.js'
import { TASKS, type Task } from './core/tasks.js'
import { loadPolyglot, polyglotTasks, polyglotBinding, removeAllPolyglotSync, POLYGLOT_MAX } from './core/polyglot.js'
import { childEnv, bashEnvNote } from './core/tools/env.js'
import { median, formatTable, rowNames, BENCH_TASKS, benchTotal, runTitle, benchFileName, autoApproves, type BenchRun, type BenchHarness, type BenchResult } from './core/bench.js'
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
/** Test hook: the wait before a 429 is tried again, in ms. */
const RETRY_MS = process.env.LHB_RETRY_MS === undefined ? undefined : Number(process.env.LHB_RETRY_MS)
const demoHarnesses = (kind?: string, apiKeyEnv?: string): string[] => kind === 'openai' && apiKeyEnv ? DEMO_HARNESSES.map(h => h === 'tuned-nothink' ? 'tuned' : h) : DEMO_HARNESSES

let fakeCache: Promise<Backend | undefined> | undefined
/** Test hook: LHB_FAKE_BACKEND=<file.json> with an array of Partial<NormalizedResponse>; an entry may carry `deltas` as well, which stream to the terminal before its reply returns, and `throw: { status, message?, moderated?, retryAfter? }` throws that BackendError after them. An entry with `when` answers only a request whose JSON contains it, and `keep` leaves it in the queue; the first entry that fits is used. One shared queue per process. */
function fakeBackendFromEnv(): Promise<Backend | undefined> {
  return (fakeCache ??= (async () => {
    const f = process.env.LHB_FAKE_BACKEND
    if (!f) return undefined
    type Throw = { status: number; message?: string; moderated?: boolean; retryAfter?: number }
    const queue: (Partial<NormalizedResponse> & { deltas?: Delta[]; when?: string; keep?: boolean; throw?: Throw })[] = JSON.parse(await readFile(f, 'utf8'))
    return {
      async listModels() { return ['fake'] }, buildPayload: r => r,
      async send(payload: unknown, _signal?: AbortSignal, onDelta?: (d: Delta) => void) {
        const text = JSON.stringify(payload)
        const i = queue.findIndex(e => e.when === undefined || text.includes(e.when))
        if (i < 0) throw new Error(queue.length ? 'fake backend: no response for this request' : 'fake backend: no more responses')
        const r = queue[i]!
        if (!r.keep) queue.splice(i, 1)
        const { deltas, when: _w, keep: _k, throw: t, ...reply } = r
        for (const d of deltas ?? []) onDelta?.(d)
        if (t) throw new BackendError(t.message ?? `fake backend: ${t.status}`, undefined, t)
        return { content: '', toolCalls: [], raw: {}, ...reply }
      },
    } as Backend
  })())
}

type Overrides = { model?: string; baseUrl?: string; kind?: string; apiKeyEnv?: string; maxTurns?: number }

async function loadHarness(file: string, over: Overrides, needKey = true): Promise<HarnessConfig> {
  // One catch for the whole read: a missing file, a directory and malformed JSON all used to reach
  // the top-level handler and print a stack at someone who mistyped a path.
  let cfg: any
  try { cfg = JSON.parse(await readFile(file, 'utf8')) }
  catch (e) { return die(`cannot read harness ${file}:\n  ${(e as Error).message}`) }
  return overridden(cfg, over, file, needKey)
}

/** The harness file's JSON with the command line's overrides, checked; `raw` itself is left as it was (evolve saves it). */
function overridden(raw: unknown, over: Overrides, file: string, needKey = true): HarnessConfig {
  const cfg = structuredClone(raw) as any
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
  // Not for evolve --report: it reads only the journal, so an unset, empty or malformed key is no reason to refuse it.
  const problem = needKey && keyProblem(cfg.backend, process.env)
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
  const opts: RunOpts = { approve, backend: await fakeBackendFromEnv(), signal: o.signal, retryMs: RETRY_MS }
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
async function benchOnce(config: HarnessConfig, round: number, timeoutS: number, out: string, task: Task, notes: NotesStore, size?: number): Promise<BenchRun> {
  // An exception that escapes execRun is text nothing has cleaned yet, and it goes to the bench JSON and the terminal.
  const redact = redactor(apiKey(config.backend, process.env), config.backend.apiKeyEnv ?? '')
  let workdir = '', traceId: string | undefined, parseErrors = 0, toolChars = 0, costUsd: number | undefined, peakTokens: number | undefined, tokens: number | undefined, firstPromptTokens: number | undefined, seenFirst = false, modelMs = 0, toolErrors = 0, guardBlocks = 0, editMiss = 0, toolCounts: Record<string, number> = {}, outputLines = 0, reasoningTokens: number | undefined, lastError: string | undefined, stop: number | undefined, stopMidReply = false, t0 = Date.now(), run: BenchRun
  process.stderr.write(`${config.name} ${runTitle({ round, task: task.name })} `)
  try {
    workdir = await task.prepare(size)
    process.stderr.write(`${workdir} ... `)
    t0 = Date.now()
    const { id, last } = await execRun(config, task.input ? `${task.prompt}\n\n${task.input(size)}` : task.prompt, workdir, {
      yes: true, json: false, quiet: true, answerSchema: task.answerSchema?.(size), signal: AbortSignal.timeout(timeoutS * 1000), bench: { file: path.basename(out), round },
      // Read, never written: a note from run 1 would make run 2 depend on it, and the bench's runs must stay independent.
      notes,
      onEvent: e => {
        if (e.type === 'parse_error') parseErrors++
        if (e.type === 'llm_response' && e.costUsd !== undefined) costUsd = (costUsd ?? 0) + e.costUsd
        if (e.type === 'llm_response') {
          modelMs += e.latencyMs
          if (!seenFirst) { seenFirst = true; firstPromptTokens = e.usage?.promptTokens }
          if (e.usage?.reasoningTokens !== undefined) reasoningTokens = (reasoningTokens ?? 0) + e.usage.reasoningTokens
          if (e.usage) { const t = e.usage.promptTokens + e.usage.completionTokens; peakTokens = Math.max(peakTokens ?? 0, t); tokens = (tokens ?? 0) + t }
        }
        if (e.type === 'mcp_server_start') toolChars += e.descriptionChars + e.schemaChars
        if (e.type === 'tool_result') {
          toolCounts[e.name] = (toolCounts[e.name] ?? 0) + 1
          // A final newline ends a line, it does not start one.
          outputLines += e.output === '' ? 0 : e.output.replace(/\n$/, '').split('\n').length
        }
        if (e.type === 'tool_result' && e.error) {
          toolErrors++
          if (e.output.includes(GUARD_BLOCKED)) guardBlocks++
          else if (e.output.includes(EDIT_MISS)) editMiss++
        }
        if (e.type === 'parse_error' || e.type === 'error') lastError = e.message
        if (e.type === 'error' && isStop(e)) { stop = e.status; stopMidReply = !!e.midReply }
      },
    })
    traceId = id
    // What the run left in the background (`&`, nohup) dies before the check reads the files it could still be writing.
    await killTracked()
    const ms = Date.now() - t0
    const d = last.type === 'done' ? last : undefined
    // A stop is the server's answer, not the model's work: there is nothing to check.
    const c = stop !== undefined ? false : await task.check(workdir, size, d?.reason === 'final' ? d.text : undefined, childEnv(config.tools.bashEnv))
    const checked = typeof c === 'boolean' ? { pass: c } : c
    if (checked.reason) lastError = checked.reason
    const verdict = checked.pass ? 'PASS' : 'FAIL'
    run = { ...(task.name ? { task: task.name } : {}), ...checked.tests ? { tests: checked.tests } : {}, round, verdict, reason: d?.reason ?? 'error', turns: d?.turns ?? 0, toolCalls: d?.toolCallCount ?? 0, parseErrors, lastError, ms, workdir, trace: id, toolChars: toolChars || undefined, modelMs, costUsd, peakTokens, tokens: seenFirst ? tokens : 0, firstPromptTokens, toolErrors, guardBlocks: config.tools.requireReadBeforeEdit ? guardBlocks : undefined, editMiss, toolCounts, outputLines, reasoningTokens, ...stop === undefined ? {} : { stop }, ...stopMidReply ? { stopMidReply } : {} }
  } catch (e) {
    run = { ...(task.name ? { task: task.name } : {}), round, verdict: 'FAIL', reason: 'error', turns: 0, toolCalls: 0, parseErrors, lastError: redact.text(String(e)), ms: Date.now() - t0, workdir, toolChars: toolChars || undefined, modelMs, costUsd, peakTokens, tokens: seenFirst ? tokens : 0, firstPromptTokens, toolErrors, guardBlocks: config.tools.requireReadBeforeEdit ? guardBlocks : undefined, editMiss, toolCounts, outputLines, reasoningTokens }
  } finally {
    // The check's own leftovers too, and a run that threw: nothing keeps writing into a clone being removed.
    await killTracked()
    // The clone of a task of the user's own goes away whatever happened; a failure to clean up is said, not thrown.
    if (workdir && task.dispose) await task.dispose(workdir, traceId).catch(e => console.error(`cannot clean up ${workdir}: ${(e as Error).message}`))
  }
  // A run that threw before or in its check still counts its exercise's tests, so sums stay comparable.
  if (task.tests !== undefined) run.tests ??= { passed: 0, total: task.tests }
  const tail = (run.reason === 'error' || run.reason === 'aborted') && run.lastError ? `  ${showable(run.lastError.replace(/\s+/g, ' ').slice(0, 200))}` : ''
  process.stderr.write(`${run.verdict}  reason=${run.reason} turns=${run.turns} toolCalls=${run.toolCalls} parseErrors=${run.parseErrors} ${Math.round(run.ms / 1000)}s${run.trace ? ` trace=${run.trace}` : ''}${tail}\n`)
  return run
}

function rollup(h: BenchHarness) {
  h.pass = h.runs.filter(r => r.verdict === 'PASS').length
  h.reasons = {}
  for (const r of h.runs) h.reasons[r.reason] = (h.reasons[r.reason] ?? 0) + 1
  if (h.runs.some(r => r.tests)) h.tests = h.runs.reduce((a, r) => ({ passed: a.passed + (r.tests?.passed ?? 0), total: a.total + (r.tests?.total ?? 0) }), { passed: 0, total: 0 })
  h.median = { turns: median(h.runs.map(r => r.turns)), toolCalls: median(h.runs.map(r => r.toolCalls)), ms: median(h.runs.map(r => r.ms)) }
}

/** One Task per task of a repo's lhb-tasks.json: each run in its own clone, its check after a look at the protected files. */
type Work = { tasks: Task[]; live: Map<string, Clone>; modules?: string; ready(env: NodeJS.ProcessEnv): Promise<void> }

/** The Tasks at once (preflight needs one), their node_modules only from ready(): setup runs after preflight, so a
 *  server that is down is said in seconds, not after `npm ci`. */
function repoWork(repo: RepoTasks): Work {
  const w: Work = {
    tasks: [], live: new Map(),
    async ready(env) { w.modules = (await prepareModules(repo, env)).from },
  }
  const live = w.live
  w.tasks = repo.tasks.map(rt => ({
    name: rt.name, prompt: rt.prompt,
    async prepare() { const c = await cloneAt(repo); live.set(c.dir, c); await linkNodeModules(c, w.modules!); return c.dir },
    async check(dir, _size, answer, env) {
      const c = live.get(dir)!
      const changed = await protectedChanged(c, repo)
      if (changed.length) return { pass: false, reason: `changed a protected file: ${changed[0]}` }
      // The test runner's own files: a node_modules of the model's would let its .bin/vitest decide the verdict.
      if (await modulesTampered(c)) return { pass: false, reason: 'changed a protected file: node_modules' }
      return runCheck(c, rt, env ?? childEnv(), answer)
    },
    async dispose(dir, traceId) {
      const c = live.get(dir)
      if (!c) return
      live.delete(dir)
      for (const w of await finishRun(c, traceId && path.join('runs', `${traceId}.patch`))) console.error(w)
    },
  }))
  return w
}

/** Every clone and polyglot workdir a bench made, removed now: at the end, and from the SIGINT handler that exits right
 *  after. An exit before that handler exists (Ctrl-C during setup) is covered by repo-clone's own exit hook. */
function dropWork(w: { live: Map<string, Clone> }): void {
  removeAllClonesSync()
  removeAllPolyglotSync()
  w.live.clear()
}

/** Where evolve's tasks come from: everything the loop reads about them, and nothing it has to know about a repo.
 *  `moved`: why the journal's start line no longer fits these tasks, in the source's own words. */
type EvolveSource = {
  work: Work; id: string; names: string[]; words?: string[]; paths: string[]; prompts: string[]; notesFile: string
  sets: Record<SetName, string[]>; describe: string; moved?: string; consent(yes: boolean, ev: EvolveConsent): Promise<void>
}
type StartLine = Extract<JournalLine, { type: 'start' }>

/** Under --report the tasks are read where the journal started: a commit since changes none of its numbers. */
async function repoSource(dir: string, first: StartLine | undefined, report: boolean, refuse: (why: string, read: boolean) => never): Promise<EvolveSource> {
  const at = report ? first?.sha : undefined
  let repo!: RepoTasks
  try { repo = await loadRepoTasks(dir, at) } catch (e) { refuse((e as Error).message, at !== undefined) }
  const sets = splitSets(repo.tasks)
  return {
    work: repoWork(repo), id: repo.sha, sets,
    names: repo.tasks.map(t => t.name), prompts: repo.tasks.map(t => t.prompt),
    paths: (await git(['ls-tree', '-r', '-z', '--name-only', repo.sha], repo.repo)).split('\0').filter(Boolean),
    notesFile: notesPath(await notesKey(repo.repo)),
    describe: `tasks: ${repo.tasks.length} from ${repo.repo} at ${repo.sha.slice(0, 7)}: train ${sets.train.length}, gate ${sets.gate.length}, test ${sets.test.length}` +
      (repo.uncommitted ? '\nuncommitted changes are not in the clones' : ''),
    ...(first && first.sha !== repo.sha ? { moved: 'the repo has a new commit since this evolve started' } : {}),
    consent: (yes, ev) => askConsent(repo, yes, ev),
  }
}

const SET_OF: SetName[] = ['train', 'gate', 'test']

/** The first `size` exercises, split by their place in the set. Under --report the sets are the journal's own: an
 *  upgraded set (or another --size) changes none of its numbers, and its names still bind what the proposer wrote. */
function polyglotSource(size: number, first: StartLine | undefined, report: boolean, harnessUrl: string): EvolveSource {
  const p = loadPolyglot()
  const id = `polyglot:${createHash('sha256').update(JSON.stringify(p)).digest('hex')}:${size}`
  const tasks = polyglotTasks(p, size)
  const sets = report && first ? first.sets : splitSets(tasks.map((t, i) => ({ name: t.name!, set: SET_OF[i % 3] })))
  return {
    work: { tasks, live: new Map(), async ready() {} }, id, sets,
    ...polyglotBinding(p, [...sets.train, ...sets.gate, ...sets.test]),
    notesFile: notesPath('task-polyglot'),
    describe: `exercises: the first ${size} of ${POLYGLOT_MAX} polyglot exercises: train ${sets.train.length}, gate ${sets.gate.length}, test ${sets.test.length}`,
    ...(!report && first && first.sha !== id ? { moved: 'the exercise set or --size changed since this evolve started' } : {}),
    async consent(yes, { proposer }) {
      const host = hostOf(proposer)
      // The harness's own server already gets everything the runs send; the proposer gets less.
      if (host === hostOf(harnessUrl)) return void console.error(`proposer: ${host}, the harness's own server`)
      const text = ["mode: evolve on polyglot — the model's own prompts run unreviewed while Evolve measures them", `proposer: ${host}`,
        'it receives how the runs failed (fixed-word signatures) and the current values of these fields, and proposes an edit to one of them', `fields: ${ALLOWED.join(', ')}`].join('\n')
      const file = path.join(stateDir(), 'consent', 'task-polyglot.evolve.json'), hash = createHash('sha256').update(text).digest('hex')
      let has = false
      try { has = JSON.parse(readFileSync(file, 'utf8')).hash === hash } catch {}
      await ask(text, has, yes, async () => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify({ hash }) + '\n') },
        { accept: 'send these to this proposer', question: 'Send them to this proposer?' })
    },
  }
}

/** The commands of a repo's tasks run without asking for the whole bench or evolve: accepted once, by hash, before anything runs. */
async function askConsent(repo: RepoTasks, yes: boolean, ev?: EvolveConsent): Promise<void> {
  await ask(consentText(repo, ev), await hasConsent(repo, ev), yes, () => saveConsent(repo, ev))
}

async function ask(text: string, has: boolean, yes: boolean, save: () => Promise<void>, q = { accept: 'accept these commands', question: 'Run these commands?' }): Promise<void> {
  if (has) return
  if (yes) { console.error(text); return save() }
  if (!process.stdin.isTTY) die(`${text}\n\npass --yes to ${q.accept}, or run in a terminal`)
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await rl.question(`${text}\n\n${q.question} [y/N] `)
  rl.close()
  if (!/^y(es)?$/i.test(answer.trim())) die('not accepted; nothing ran')
  await save()
}

async function cmdBench(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: COMMANDS.bench.options })
  if (values.help) return printHelp('bench')
  keyFlag('bench', values['api-key-env'])
  if (!INT.test(values.n)) argError('bench', '--n must be a positive integer')
  if (!INT.test(values.timeout)) argError('bench', '--timeout must be a positive integer')
  const models = values.models?.split(',')
  if (models && values.model !== undefined) argError('bench', '--model cannot go with --models: --models names the models')
  if (models?.includes('')) argError('bench', '--models: an empty model name')
  if (models && new Set(models).size < models.length) argError('bench', '--models: a model is named twice')
  if (values.tasks !== undefined && (values.task !== undefined || values.size !== undefined)) argError('bench', '--tasks cannot go with --task or --size')
  let repo: RepoTasks | undefined
  if (values.tasks !== undefined) try { repo = await loadRepoTasks(values.tasks) } catch (e) { argError('bench', (e as Error).message) }
  if (values.only !== undefined && !repo) argError('bench', '--only needs --tasks')
  const only = values.only === undefined ? undefined : [...new Set(values.only.split(',').map(s => s.trim()))]
  if (repo && only) {
    const names = repo.tasks.map(t => t.name), bad = only.filter(o => !names.includes(o))
    if (bad.length) argError('bench', `--only: ${only.every(Boolean) ? `no task ${bad.join(', ')}` : 'an empty name'}; the tasks are ${names.join(', ')}`)
    // Narrowed before anything reads it: the consent, the tasks line and the runs see only these.
    repo = { ...repo, tasks: repo.tasks.filter(t => only.includes(t.name)) }
  }
  const taskName = repo ? 'tasks' : values.task ?? 'slug'
  const poly = !repo && taskName === 'polyglot'
  const builtin: Task | undefined = repo || poly ? undefined : Object.hasOwn(TASKS, taskName) ? TASKS[taskName as keyof typeof TASKS] : undefined
  if (!repo && !poly && !builtin) argError('bench', `--task must be one of ${Object.keys(BENCH_TASKS).join('|')}`)
  const size = values.size === undefined ? undefined : Number(values.size)
  // A task with sizes needs one in range; a task without sizes takes none.
  if (poly && !(values.size !== undefined && INT.test(values.size) && size! <= POLYGLOT_MAX)) argError('bench', `--size must be an integer from 1 to ${POLYGLOT_MAX} for polyglot`)
  if (builtin) {
    const sizeOk = builtin.max === undefined ? size === undefined : values.size !== undefined && INT.test(values.size) && size! <= builtin.max
    if (!sizeOk) argError('bench', builtin.max === undefined ? `--size: ${taskName} has no sizes` : `--size must be an integer from 1 to ${builtin.max} for ${taskName}`)
  }
  if (values['max-turns'] !== undefined && !INT.test(values['max-turns'])) argError('bench', '--max-turns must be a positive integer')
  const n = Number(values.n), timeoutS = Number(values.timeout)
  const started = new Date()
  const out = values.out ?? path.join('runs', benchFileName(started))
  // Per file: a ./harnesses copied by an older version lacks the newer shipped ones.
  const localDir = path.join(process.cwd(), 'harnesses')
  const files = positionals.length ? positionals : demoHarnesses(values.kind, values['api-key-env']).map(h => [path.join(localDir, `${h}.json`), path.join(PKG_ROOT, 'harnesses', `${h}.json`)].find(existsSync)!)
  const over = { model: values.model, baseUrl: values['base-url'], kind: values.kind, apiKeyEnv: values['api-key-env'], maxTurns: values['max-turns'] === undefined ? undefined : Number(values['max-turns']) }
  console.error(autoApproves('bench'))
  const harnesses: BenchHarness[] = [], from: string[] = []
  // --models: every harness on every model, one model after the other; each model's first harness is the base of its p.
  for (const model of models ?? [values.model]) for (const f of files) {
    const config = await loadHarness(f, { ...over, model })
    from.push(f)
    harnesses.push({ name: config.name, config, pass: 0, reasons: {}, median: { turns: 0, toolCalls: 0, ms: 0 }, runs: [] })
  }
  for (const h of harnesses) {
    const note = bashEnvNote(h.config.tools.bashEnv)
    if (note) console.error(`${h.name}: ${note}`)
    const key = keyNote(h.config.backend, process.env)
    if (key) console.error(`${h.name}: ${key}`)
  }
  // Read once, before any run: the exercises of a later run are the bytes of now, whatever an earlier run did to the files.
  let work: Work = { tasks: poly ? polyglotTasks(loadPolyglot(), size!) : [builtin!], live: new Map(), async ready() {} }
  if (repo) {
    console.error(`tasks: ${repo.tasks.length} from ${repo.repo} at ${repo.sha.slice(0, 7)}`)
    if (repo.uncommitted) console.error('uncommitted changes are not in the clones')
    await askConsent(repo, values.yes)
    work = repoWork(repo)
  }
  const tasks = work.tasks
  // Before any JSON exists: a server that is down, or lacks the model, is a typo to report, not 90 minutes of 'error' rows.
  const no = await preflightAll(harnesses, tasks[0], size)
  if (no) { dropWork(work); die(no) }
  // setup runs once for every harness: it gets the env names any of them passes to its commands.
  try { await work.ready(childEnv([...new Set(harnesses.flatMap(h => h.config.tools.bashEnv ?? []))])) } catch (e) { die((e as Error).message) }
  // What setup left in the background would reach the first run only: every run starts without it.
  await killTracked()
  await mkdir(path.dirname(out), { recursive: true })
  const result: BenchResult = { version: 1, date: started.toISOString(), task: repo ? `${TASKS_FILE} at ${repo.sha.slice(0, 7)} in ${repo.repo}${only ? ` (only ${only.join(', ')})` : ''}` : poly ? `polyglot: the first ${size} of ${POLYGLOT_MAX} Exercism JavaScript exercises` : builtin!.prompt, taskName, size, node: process.version, n, timeoutS, complete: false, harnesses,
    ...(repo ? { tasksRepo: repo.repo, tasksSha: repo.sha, taskCount: repo.tasks.length, ...only && { only } } : poly ? { taskCount: size } : {}) }
  // tmp + rename in the same directory: the SIGINT handler exits immediately, and a half-written
  // JSON would be the only thing left of a 90-minute run. `.tmp`, not `.json`, so /api/bench skips it.
  const tmpOut = `${out}.${process.pid}.tmp`
  // Synchronous: the SIGINT handler saves too, and can then never land between another save's write and rename.
  const save = () => { writeFileSync(tmpOut, JSON.stringify(result, null, 2) + '\n'); renameSync(tmpOut, out) }
  // write() with a callback, not console.log: on a pipe stdout is async, and the SIGINT handler's
  // exit() below would drop the table of a 90-minute run on the floor.
  const finish = (code?: number) => {
    console.error(`wrote ${out}`)
    process.stdout.write(formatTable(harnesses, { wide: values.wide }) + '\n', () => code !== undefined && process.exit(code))
  }
  // The first save happens before any run, so an unwritable --out (a directory, a bad path) is a
  // typo to report, not a crash after 90 minutes.
  try { save() } catch (e) { die(`cannot write ${out}:\n  ${(e as Error).message}`) }
  console.error(`bench: ${harnesses.length} harnesses × ${benchTotal(result) / harnesses.length} runs, timeout ${timeoutS}s per run, writing ${out}`)
  const rows = rowNames(harnesses)
  from.forEach((f, i) => console.error(`  ${rows[i].padEnd(13)} ${f}`))
  // bench reads notes and never writes them: a repo's are those of its folder, a built-in task's are in task-<name>.
  const notes: NotesStore = { file: notesPath(repo ? await notesKey(repo.repo) : `task-${taskName}`), write: false }
  for (const h of harnesses) if (h.config.notes?.enabled) {
    const file = notes.file, n = (await readNotes(file)).length
    console.error(`  ${h.name}: notes on, ${n ? `${n} in` : 'none in'} ${shortHome(file)}${n ? '' : ' — this bench runs as with notes off'}`)
  }
  // A failed write still prints the table: the terminal then holds what the JSON could not.
  process.once('SIGINT', () => { dropWork(work); result.stopped = true; try { save() } catch (e) { console.error(`cannot write ${out}: ${(e as Error).message}`) } finish(130) })
  const modulesDir = work.modules && path.join(work.modules, 'node_modules')
  const modules0 = modulesDir && await modulesManifest(modulesDir)
  for (let round = 1; round <= n; round++) {
    console.error(`--- round ${round}/${n}`)
    for (const task of tasks) for (const h of harnesses) {
      h.runs.push(await benchOnce(h.config, round, timeoutS, out, task, notes, size))
      rollup(h)
      save()
      // The runs' node_modules is a link to a real one: a run that changed it would change every run after it, and the user's tree.
      if (modulesDir && await modulesManifest(modulesDir) !== modules0) {
        dropWork(work)
        console.error(`the model changed the installed packages in ${modulesDir}; stopping`)
        return finish(1)
      }
    }
  }
  dropWork(work)
  result.complete = true
  save()
  finish()
}

/** A path evolve writes to in ./harnesses: never through a link, which the model's bash could have put there. */
const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }
const TRACE_ID = /^[A-Za-z0-9_-]{1,64}$/
/** The text of version n as evolve writes it; the report compares the file on disk with it byte for byte. */
const versionText = (base: string, n: number, cfg: object): string => JSON.stringify({ ...cfg, name: `${base}.v${n}` }, null, 2) + '\n'
type EvolveState = Exclude<ReturnType<typeof replay>, { error: string }>

/** Proposes two edits per round, sweeps them with the current version on train + gate, keeps at most one past the gates, and
 *  measures the last kept version against the original on test. Every completed step is a journal line, one per sweep, and the
 *  state is always the journal replayed: a resumed evolve and an uninterrupted one go on from the same state. */
async function cmdEvolve(argv: string[]) {
  // Before parseArgs, whose "Unknown option" would only advise a `--`.
  if (argv.some(a => a === '--only' || a.startsWith('--only='))) argError('evolve', '--only is for bench: evolve splits all the tasks of the repo into train, gate and test')
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: COMMANDS.evolve.options })
  if (values.help) return printHelp('evolve')
  keyFlag('evolve', values['api-key-env'])
  const [file] = positionals
  if (!file || positionals.length > 1) argError('evolve', 'evolve needs one harness file')
  const poly = values.task !== undefined
  if (values.tasks !== undefined && (poly || values.size !== undefined)) argError('evolve', '--tasks cannot go with --task or --size')
  if (poly && values.task !== 'polyglot') argError('evolve', 'evolve takes --task polyglot only; your own tasks go in --tasks <repo>')
  if (!poly && values.tasks === undefined) argError('evolve', 'evolve needs --tasks <repo> or --task polyglot, with --mode hours, night or days')
  const named = values.mode as keyof typeof MODES | undefined, custom = values.size !== undefined || values.rounds !== undefined
  if (named !== undefined && !Object.hasOwn(MODES, named)) argError('evolve', '--mode must be hours, night or days')
  if (named && custom) argError('evolve', '--mode cannot go with --size or --rounds')
  const size0 = named ? MODES[named].size : Number(values.size)
  const sizeError = `--size must be an integer from 3 to ${POLYGLOT_MAX} for evolve --task polyglot`
  if (poly && values.size !== undefined && !values.report && !(INT.test(values.size) && size0 >= 3 && size0 <= POLYGLOT_MAX)) argError('evolve', sizeError)
  if (values.rounds !== undefined && !INT.test(values.rounds)) argError('evolve', '--rounds must be a positive integer')
  if (!INT.test(values.timeout)) argError('evolve', '--timeout must be a positive integer')
  const timeoutS = Number(values.timeout)
  // Read once: edits go onto this JSON and versions are saved from it, without the overrides; the file is never written.
  let raw: object, bytes: Buffer
  try { bytes = await readFile(file!); raw = JSON.parse(bytes.toString('utf8')) } catch (e) { return die(`cannot read harness ${file}:\n  ${(e as Error).message}`) }
  const over = { model: values.model, baseUrl: values['base-url'], kind: values.kind, apiKeyEnv: values['api-key-env'] }
  const config = overridden(raw, over, file!, !values.report)
  // Priced = the harness's own price: no flag would silently buy a night at a price nobody set a ceiling on. --report runs nothing.
  const limit = values['max-usd'] === undefined ? undefined : Number(values['max-usd'])
  if (limit !== undefined && !(Number.isFinite(limit) && limit > 0)) argError('evolve', '--max-usd must be a positive number')
  if (!values.report) {
    if (limit !== undefined && !config.backend.pricePerMTok) argError('evolve', '--max-usd: no price to count against; the harness has no backend.pricePerMTok')
    if (limit === undefined && config.backend.pricePerMTok) argError('evolve', 'evolve on a priced harness needs --max-usd <dollars>: the most it may spend before it stops (a stopped evolve resumes with a higher one)')
  }
  const proposer = values.proposer === undefined ? config : await loadHarness(values.proposer, {}, !values.report)
  const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
  // Named from the file, never config.name: that is text inside the file, and it becomes a path.
  const base = path.basename(file!).replace(/\.json$/, '')
  const dir = 'harnesses', jf = path.join(dir, `${base}.evolve.jsonl`), snap = path.join(dir, `${base}.evolve.notes.jsonl`)
  const vf = (n: number) => path.join(dir, `${base}.v${n}.json`)
  for (const p of [dir, jf, snap]) if (isLink(p)) die(`${p} is a symbolic link; evolve writes only to a plain file there`)
  const resuming = existsSync(jf)
  if (values.report && !resuming) die(`no evolve journal at ${jf}`)
  let lines: JournalLine[] = [], torn = ''
  // The journal is the report's only source: under --report the refusals never advise deleting it.
  // Its version files stay behind a deleted journal, and the next start refuses to overwrite v1.
  const versions = path.join(dir, `${base}.v*.json`)
  const then = values.report ? `the report cannot be shown from ${jf}` : `delete ${jf} and move away ${versions} to start over`
  const start = (what: string) => `${what}; ${then}`
  // A sound journal that moved out of step with the repo, the harness or the snapshot: when it is finished it holds the
  // only results, and a refused restart points at them, never at deleting them.
  const moved = (what: string) => values.report || !lines.some(l => l.type === 'final') ? start(what)
    : `${what}; this evolve has finished: see its results with --report and the harness and options it ran with, or move away ${jf} and ${versions} to start over`
  if (resuming) {
    const text = readFileSync(jf, 'utf8')
    const j = parseJournal(text)
    if ('error' in j) return die(start(`cannot resume: ${jf} ${j.error}`))
    lines = j.lines
    torn = text
  }
  // Everything below reads only the source: what the tasks are, where they come from, how they run.
  const first = lines[0]?.type === 'start' ? lines[0] : undefined
  if (resuming && !first) die(start('cannot resume: the journal does not begin with a start line'))
  const ranWith = (m: EvolveMode, n: number, r: number) => m === 'custom' ? `${poly ? `--size ${n} ` : ''}--rounds ${r}` : `--mode ${m}`
  // A stopped evolve holds paid runs: the flags that fit it are the journal's to name, and nothing here advises deleting it.
  if (first && !values.report) {
    const ran = ranWith(first.mode, first.sets.train.length + first.sets.gate.length + first.sets.test.length, first.rounds)
    if (!(named || custom) || ran !== ranWith(named ?? 'custom', size0, Number(values.rounds ?? ROUNDS))) die(`this journal ran ${ran}; run the same command with it`)
  }
  // No default: a default would silently buy a night of runs. The report reads all of it from the start line.
  if (!resuming && !named && !custom) argError('evolve', 'evolve needs --mode hours, night or days (--rounds, and --size on polyglot, for an orientation run of your own)')
  if (!resuming && poly && !named && values.size === undefined) argError('evolve', sizeError)
  const { mode, repeats, rounds } = values.report ? first! : named ? { mode: named, ...MODES[named] } : { mode: 'custom' as const, repeats: 1, rounds: Number(values.rounds ?? ROUNDS) }
  const size = values.report ? first!.sets.train.length + first!.sets.gate.length + first!.sets.test.length : size0
  // What the runs depend on besides the tasks: a resume with another harness or other flags would mix two evolves.
  const pin = sha256(JSON.stringify({ harness: sha256(bytes), over, timeoutS, proposer: values.proposer === undefined ? null : sha256(readFileSync(values.proposer)), mode, repeats, rounds }))
  const src = poly ? polyglotSource(size, first, values.report, config.backend.baseUrl)
    : await repoSource(values.tasks!, first, values.report, (why, read) => read ? die(start(why)) : argError('evolve', why))
  const { sets, work } = src, split = splitOf(sets, poly, mode)
  if (typeof split === 'string') return die(split)
  console.error(src.describe)
  console.error(split.declarable ? `a winner can be declared: a candidate needs at least ${neededFlips()} tasks FAIL → PASS on train + gate (more if any go PASS → FAIL)` : referenceLabel(split))
  const count = runCount(sets, repeats, rounds)
  const binding = bindingTokens({ names: src.names, words: src.words, paths: src.paths, prompts: src.prompts })
  const rebuilt = (): EvolveState => {
    const r = replay(lines, raw, { binding, sets })
    return 'error' in r ? die(start(r.error)) : r
  }
  // The model's bash can rewrite files in cwd: every version must have read the snapshot the start line hashed.
  // Called only after rebuilt() succeeded, so a bad first line gets the journal's own error.
  const snapOk = () => {
    try { return lstatSync(snap).isFile() && sha256(readFileSync(snap)) === (lines[0] as Extract<JournalLine, { type: 'start' }>).notes } catch { return false }
  }
  const snapCheck = () => { if (!snapOk()) die(moved(`the notes snapshot changed since this evolve started (${snap})`)) }
  if (resuming) {
    if (src.moved) die(moved(src.moved))
    if (first && (first.pin !== pin || first.mode !== mode || first.repeats !== repeats || first.rounds !== rounds)) die(moved('the harness or its options changed since this evolve started'))
    if (lines[0]?.type === 'start' && lines[0].base !== base) die(start('the journal was written for another harness'))
  }
  // A new journal has no state until its start line.
  let state = resuming ? rebuilt() : undefined as unknown as EvolveState
  // The snapshot is what the next runs read; the report runs nothing.
  if (resuming && !values.report) snapCheck()
  // Rounds are pinned, so only a hand-written journal gets here: its loop would never reach the cut slot, and a final line after its proposal leaves a journal no resume accepts.
  const cut = resuming && !values.report ? state.pending[0] : undefined
  if (cut && cut.round > rounds)
    die(start(`${jf} ends on round ${cut.round}'s candidate ${cut.index}, cut in that round, past the ${rounds} of this evolve`))
  const all = Array.from({ length: rounds }, (_, i) => i + 1).every(round =>
    Array.from({ length: CANDIDATES }, (_, i) => i + 1).every(index => lines.some(l => l.type === 'candidate' && l.round === round && l.index === index)))
  if (resuming && all && !values.report) console.error(`all rounds are in the journal${state.version ? '; measuring the final test' : ''}`)
  // The report reads only the journal, after replay re-checked it: a finished evolve started again prints it as it was, without a clone or a request.
  // vN is what the user is told to use: it has to be the text evolve wrote for the version the numbers are about.
  const changed = (): boolean => { const p = vf(state.version); try { return isLink(p) || readFileSync(p, 'utf8') !== versionText(base, state.version, state.current) } catch { return true } }
  const report = (): string => evolveReport({ lines, attempt: (lines[0] as StartLine).attempt ?? 'unknown', state: { ...state, final: state.final! }, original: raw, split, sets, harness: path.basename(file!), versionFile: state.version ? vf(state.version) : '', changed: !!state.version && changed() })
  if (values.report || (resuming && all && state.final)) {
    if (!state.final) die(`evolve has not finished: no final test in ${jf}; run evolve again to finish`)
    console.log(report())
    return
  }
  if (limit !== undefined && !proposer.backend.pricePerMTok) console.error('the proposer has no price: its calls are not counted against --max-usd')
  // The sweep or proposer call in flight is not journaled yet and a stop drops it, so it counts here: else a stop would let one more sweep through. Not in `pin`: a higher limit is how a stopped evolve resumes.
  let unsaved = 0
  const overStop = (): void => {
    if (limit === undefined || spent(lines) + unsaved < limit) return
    dropWork(work)
    console.error(`evolve stopped: spent $${(spent(lines) + unsaved).toFixed(4)} of $${limit}; the cut sweep's runs are not in the journal, so the real total may be one sweep higher; run again with a higher --max-usd to continue`)
    process.exit(1)
  }
  overStop()
  console.error(`mode ${mode}: up to ${count.all} runs: ${count.probe} probe, ${count.sweeps} sweeps, ${count.test} test`)
  console.error(autoApproves('evolve'))
  await src.consent(values.yes, { proposer: proposer.backend.baseUrl, fields: ALLOWED, mode, runs: count.all })
  // A torn last line goes, or the next line would be appended onto it; only after consent, and only on the run path.
  if (torn && !torn.endsWith('\n')) truncateSync(jf, Buffer.byteLength(torn.slice(0, torn.lastIndexOf('\n') + 1)))
  // The next version is checked now, not after a candidate's runs: a file the journal has no line for is not ours.
  const next = vf((resuming ? state.version : 0) + 1)
  if (isLink(next)) die(`${next} is a symbolic link; evolve writes only to a plain file there`)
  if (existsSync(next)) die(`${next} already exists and the journal has no line for it; move it away first — evolve never overwrites a version`)
  // One whole line per write: a Ctrl-C leaves the journal at a completed step.
  const append = (l: JournalLine) => { appendFileSync(jf, JSON.stringify(l) + '\n'); lines.push(l); state = rebuilt() }
  if (!resuming) {
    if (!existsSync(dir)) await mkdir(dir)
    const host = hostOf(proposer.backend.baseUrl)
    // Every version reads this frozen copy: a note written during evolve would make one version's runs depend on another's.
    // Before the start line: a journal is never without its snapshot.
    writeFileSync(snap, existsSync(src.notesFile) ? readFileSync(src.notesFile) : '')
    // Counted per harness bytes + source, on a new journal only; the journal keeps its own number, so a later attempt never relabels it.
    // An unreadable counter is left as it is and the start line says nothing: the report prints `attempt unknown`, never a made-up number.
    const cf = path.join(stateDir(), 'evolve-attempts', `${sha256(Buffer.concat([bytes, Buffer.from(`${src.id}:${mode}`)]))}.txt`)
    let attempt: number | undefined
    try {
      const t = existsSync(cf) ? readFileSync(cf, 'utf8').trim() : '0'
      if (!/^\d{1,9}$/.test(t)) console.error(`the attempt count is unreadable at ${shortHome(cf)}; this journal starts without one`)
      else {
        const n = Number(t) + 1
        await mkdir(path.dirname(cf), { recursive: true })
        writeFileSync(cf + '.tmp', `${n}\n`); renameSync(cf + '.tmp', cf)
        attempt = n
      }
    } catch { console.error(`the attempt count cannot be read or written at ${shortHome(cf)}; this journal starts without one`) }
    append({ v: 2, type: 'start', base, sha: src.id, pin, sets, declarable: split.declarable, mode, proposer: host, notes: sha256(readFileSync(snap)), repeats, rounds, ...(attempt ? { attempt } : {}) })
  }
  const byName = new Map(work.tasks.map(t => [t.name!, t]))
  const no = await preflightAll([{ name: config.name, config }, { name: 'proposer', config: proposer }], work.tasks[0])
  if (no) { dropWork(work); die(no) }
  try { await work.ready(childEnv(config.tools.bashEnv ?? [])) } catch (e) { die((e as Error).message) }
  await killTracked()
  process.once('SIGINT', () => { dropWork(work); process.exit(130) })
  const modulesDir = work.modules && path.join(work.modules, 'node_modules')
  const modules0 = modulesDir && await modulesManifest(modulesDir)
  const out = path.join('runs', `evolve-${base}.json`), notes: NotesStore = { file: snap, write: false }
  const stop = () => { dropWork(work); console.error(`the model changed the installed packages in ${modulesDir}; stopping`); process.exitCode = 1 }
  const pb = proposer.backend
  const pRedact = redactor(apiKey(pb, process.env), pb.apiKeyEnv ?? '')
  const hRedact = redactor(apiKey(config.backend, process.env), config.backend.apiKeyEnv ?? '')
  // Not a FAIL: the server refused the key, has no credits, or kept limiting. The cut step's runs are not journaled (its proposal may be).
  const WHY: Record<number, string> = { 401: 'the key was refused', 402: 'no credits left', 403: 'the request was refused', 429: 'rate limited, still after 3 retries' }
  const halt = (who: 'harness' | 'proposer', b: HarnessConfig['backend'], status: number, redact: ReturnType<typeof redactor>, midReply?: boolean): never => {
    dropWork(work)
    const why = midReply && status === 429 ? '429 mid-reply, not retried' : WHY[status]
    console.error(showable(redact.text(`evolve stopped: the ${who} backend (${hostOf(b.baseUrl)}) answered ${status}: ${why}; the cut step's runs are not in the journal; run the same command again to resume from the journal`)))
    return process.exit(1)
  }
  /** One sweep: per task every arm in turn, so the server's drift over a night falls on all of them. Runs by arm; undefined = stopped. */
  const sweepOn = async (arms: { cfg: object; name: string }[], names: string[], sweep: number): Promise<RunLite[][] | undefined> => {
    const cs = arms.map(a => overridden({ ...a.cfg, name: a.name }, over, file!))
    const runs: RunLite[][] = arms.map(() => [])
    try { for (const n of names) for (const [i, c] of cs.entries()) {
      overStop()
      const r = await benchOnce(c, sweep, timeoutS, out, byName.get(n)!, notes)
      if (r.stop !== undefined) halt('harness', c.backend, r.stop, hRedact, r.stopMidReply)
      unsaved += r.costUsd ?? 0
      const lite: RunLite = { task: n, verdict: r.verdict, tokens: r.tokens, firstPromptTokens: r.firstPromptTokens, turns: r.turns, modelMs: r.modelMs ?? 0, costUsd: r.costUsd, repeat: sweep, trace: r.trace, reason: r.reason, lastError: r.lastError }
      // Signed now, while the trace is here: the report groups failures by it without reading a trace again.
      runs[i]!.push(lite.verdict === 'FAIL' ? { ...lite, sig: signatureOf(lite, await eventsOf(r.trace)) } : lite)
      // As in bench: a run that changed the linked node_modules changed every run after it.
      if (modulesDir && await modulesManifest(modulesDir) !== modules0) return undefined
    }
    return runs } finally { unsaved = 0 }
  }
  // A trace id from the journal is a path only when it looks like one of ours.
  const eventsOf = async (trace?: string): Promise<HarnessEvent[]> => {
    if (!trace || !TRACE_ID.test(trace)) return []
    try { return (await readTraceFile(path.join('runs', `${trace}.jsonl`))).events } catch { return [] }
  }
  /** The rest of the upper count at the probe's pace. A probe of all PASS or all FAIL has no variance: neededFlips is the floor, so the line never promises +1. */
  const estimate = (probe: RunLite[], msPerRun: number): string => {
    const rest = count.all - count.probe, priced = probe.flatMap(r => r.costUsd === undefined ? [] : [r.costUsd])
    const money = priced.length ? `, about $${(rest * priced.reduce((a, c) => a + c, 0) / priced.length).toFixed(2)}` : ''
    const g = smallestGain(numbersOf(probe).pass / probe.length, repeats, split.trainGate), k = Math.max(g.tasks, neededFlips())
    return `estimate: up to ${rest} more runs, about ${(rest * msPerRun / 3.6e6).toFixed(1)} h${money}; the smallest gain told from noise: ${g.bound ? 'at most ' : ''}+${k} tasks of ${split.trainGate}${g.bound ? ' (upper bound at 1 repeat)' : ''}`
  }
  const pBackend = (await fakeBackendFromEnv()) ?? createBackend(pb)
  const clean = (s: string) => scrubText(s, hRedact, homedir())
  let proposerTokens = 0
  // Built like the notes writer's call: the proposer's own knobs, its /no_think line, a schema only where it enforces one.
  const propose = async (input: string, closed: string[]): Promise<{ edit?: Edit; reason?: string; costUsd?: number }> => {
    const req: ChatRequest = {
      ...proposerRequest(pb.model, input, { schema: proposer.toolCalls.enforceSchema, noThink: NO_THINK_LINE.test(proposer.systemPrompt), fields: closed }),
      temperature: pb.temperature, maxTokens: pb.maxTokens ?? 1024,
      ...(pb.numCtx === undefined ? {} : { numCtx: pb.numCtx }), ...(pb.think === undefined ? {} : { think: pb.think }),
    }
    let cost: number | undefined
    const ask = async (): Promise<{ edit?: Edit; reason?: string }> => {
      let content: string, cut: boolean
      overStop()
      try {
        const r = await sendRetrying(pBackend, pBackend.buildPayload(req), AbortSignal.timeout(timeoutS * 1000), undefined, RETRY_MS)
        if (r.usage) proposerTokens += r.usage.promptTokens + r.usage.completionTokens
        const c = costOf(r.usage, pb.pricePerMTok)
        if (c !== undefined) { cost = (cost ?? 0) + c; unsaved += c }
        content = r.content; cut = !!r.truncated
      // Not a rejection: a journaled one would never be asked again, and the next evolve continues at this candidate.
      } catch (e) {
        if (e instanceof BackendError && isStop(e)) return halt('proposer', pb, e.status!, pRedact, e.midReply)
        dropWork(work); return die(`proposer failed: ${showable(pRedact.text((e as Error).message))}`) }
      try { return { edit: parseProposal(content) } } catch { return { reason: cut ? 'reply cut at maxTokens' : 'no edit in the reply' } }
    }
    // The line that follows holds the cost, so the in-flight copy goes the moment it is written (no check comes between).
    try {
      const p = await ask()
      // Once more, same input and same closed list: a second reply on a closed field is the proposer's, journaled and rejected. Any other refusal is not asked again.
      if (!p.edit || !closed.includes(p.edit.field)) return { ...p, costUsd: cost }
      const again = await ask()
      return { ...again.edit && closed.includes(again.edit.field) ? { edit: again.edit, reason: 'field exhausted' } : again, costUsd: cost }
    } finally { unsaved = 0 }
  }
  const writeVersion = (n: number, cfg: object) => {
    const p = vf(n), text = versionText(base, n, cfg)
    if (isLink(p)) die(`${p} is a symbolic link; evolve writes only to a plain file there`)
    // Checked free before the runs; one that appeared since is not ours to replace.
    try { writeFileSync(p, text, { flag: 'wx' }) } catch { die(`${p} already exists; move it away first — evolve never overwrites a version`) }
  }
  const trainGate = [...sets.train, ...sets.gate]
  // Every gate divides by the original's tokens: without them each sweep would be spent for a sure refusal.
  const usage = () => { if (state.baseline && !usable(state.baseline)) { dropWork(work); die(`the server gave no usage for the original's runs; evolve needs a server that reports token usage; delete ${jf} to start over`) } }
  for (let round = 1; round <= rounds; round++) {
    snapCheck()
    // Nothing left to propose: on to the final test; the report says why.
    if (ALLOWED.every(f => state.exhausted.includes(f))) break
    console.error(`--- round ${round}/${rounds}`)
    if (!state.feed) {
      const t0 = Date.now()
      const runs = await sweepOn([{ cfg: state.current, name: `${base}.cur` }], sets.train, 1)
      if (!runs) return stop()
      console.error(estimate(runs[0]!, (Date.now() - t0) / runs[0]!.length))
      // Not a repeat of anything: a probe run is no sweep's.
      append({ v: 2, type: 'probe', round, runs: runs[0]!.map(({ repeat: _, ...r }) => r) })
    }
    // Both on one current; a proposal journaled before a stop stays as it was: asking again would let a stop re-roll it.
    for (let index = 1; index <= CANDIDATES; index++) {
      if (state.pending.some(p => p.round === round && p.index === index) || lines.some(l => l.type === 'candidate' && l.round === round && l.index === index)) continue
      const train = await Promise.all(state.feed!.map(async run => ({ run, events: await eventsOf(run.trace) })))
      const input = proposerInput(state.current, failureGroups(train), state.rejected, clean)
      // Candidate 2 also leaves candidate 1's field alone (not a rejection: it does not count toward exhausted).
      const first = index > 1 ? [...state.pending, ...lines.flatMap(l => l.type === 'candidate' && l.round === round && l.index === 1 && l.edit ? [l] : [])].find(x => x.round === round && x.index === 1)?.edit?.field : undefined
      const closed = [...state.exhausted, ...first ? [first] : []]
      if (ALLOWED.every(f => closed.includes(f))) {
        console.error(`candidate ${round}.${index}: field exhausted`)
        append({ v: 2, type: 'candidate', round, index, input, accepted: false, reason: 'field exhausted' })
        continue
      }
      const p = await propose(input, closed)
      const why = p.reason ?? checkEdit(p.edit!, { current: state.current, original: raw, tried: state.tried, binding })
      if (why) {
        console.error(`candidate ${round}.${index}: ${showable(why)}`)
        append({ v: 2, type: 'candidate', round, index, input, ...(p.edit ? { edit: p.edit } : {}), accepted: false, reason: why, ...p.costUsd === undefined ? {} : { costUsd: p.costUsd } })
      } else append({ v: 2, type: 'proposal', round, index, input, edit: p.edit!, ...p.costUsd === undefined ? {} : { costUsd: p.costUsd } })
    }
    const open = state.pending.filter(p => p.round === round)
    if (!open.length) continue
    const swept = () => lines.flatMap(l => l.type === 'sweep' && l.round === round ? [l] : [])
    const arms = [{ cfg: state.current, name: `${base}.cur` }, ...open.map(p => ({ cfg: applyEdit(state.current, p.edit), name: `${base}.r${round}c${p.index}` }))]
    for (let sweep = swept().length + 1; sweep <= repeats; sweep++) {
      usage()
      const runs = await sweepOn(arms, trainGate, sweep)
      if (!runs) return stop()
      const [cur, ...cands] = runs
      append({ v: 2, type: 'sweep', round, sweep, cur: cur!, cands: open.map((p, i) => ({ index: p.index, runs: cands[i]! })) })
    }
    usage()
    const verdicts = decideRound({ cur: swept().flatMap(s => s.cur), cands: sweptCands(swept()), orig: state.baseline!, gateNames: sets.gate, split, origMaxTurns: (raw as any).loop?.maxTurns ?? Infinity })
    for (const { round: _, ...p } of open) {
      const d = verdicts.find(v => v.index === p.index)!
      const version = d.accepted ? state.version + 1 : undefined
      if (version) writeVersion(version, applyEdit(state.current, p.edit))
      append({ v: 2, type: 'candidate', round, ...p, accepted: d.accepted, reason: d.reason, numbers: d.numbers, ...(version ? { version } : {}) })
      console.error(`candidate ${round}.${p.index}: ${d.reason}${version ? ` — wrote ${vf(version)}` : ''}`)
    }
  }
  // Measured once: a final line in the journal is the test, and a restart reads it instead of running it again.
  if (!state.final) {
    snapCheck()
    for (let sweep = state.tested + 1; state.version && sweep <= repeats; sweep++) {
      const runs = await sweepOn([{ cfg: raw, name: `${base}.orig` }, { cfg: state.current, name: `${base}.v${state.version}` }], sets.test, sweep)
      if (!runs) return stop()
      append({ v: 2, type: 'testsweep', sweep, orig: runs[0]!, last: runs[1]! })
    }
    append({ v: 2, type: 'final', version: state.version })
  }
  // Per session, so not in the report: the same journal gives the same report.
  console.error(`proposer: ${proposerTokens} tokens in this session (not in the gates)`)
  dropWork(work)
  console.log(report())
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
    cli: args => spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }),
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

const commands: Record<CommandName, (a: string[]) => Promise<void>> = { serve: cmdServe, run: cmdRun, demo: cmdDemo, bench: cmdBench, evolve: cmdEvolve, replay: cmdReplay, analyze: cmdAnalyze, proxy: cmdProxy }
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
