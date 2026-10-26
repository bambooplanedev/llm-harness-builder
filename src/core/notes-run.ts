// The run with notes around it: the notes of the folder go in after the task, and after the run a separate call with a
// schema writes up to two new ones. Its own file, not notes.ts: run.ts imports notes.ts for the block.
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { apiKey, NO_THINK_LINE, type RunParams } from './config.js'
import type { HarnessEvent, Ev } from './events.js'
import { createBackend, type ChatRequest, type Knob, type Usage } from './backends/index.js'
import { jsonCandidates } from './parse.js'
import { costOf } from './cost.js'
import { runAgent, type RunOpts } from './run.js'
import { redactor } from './redact.js'
import { appendNotes, readNotes, scrubNote, selectNotes, traceSignals, NOTE_MAX_CHARS, type Note } from './notes.js'

/** Where a run's notes are, and whether it may add to them: bench reads only, so its runs stay independent. */
export type NotesStore = { file: string; write: boolean }

export const NOTE_SCHEMA = {
  type: 'object',
  properties: { notes: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: NOTE_MAX_CHARS } } },
  required: ['notes'], additionalProperties: false,
}

const WRITER_SYSTEM = 'You keep short notes for a coding agent that works on this project again later. From the run summary, write at most 2 facts about the project or about mistakes worth avoiding, each under 300 characters. Reply {"notes": []} if there is nothing new. Existing notes are listed; do not repeat them.'

/** The notes in a writer reply — bare, fenced, after a <think> block or in prose, as prompted mode reads a reply —
 *  or why there are none: no {"notes": [strings]} anywhere is an error, not a note. */
function parseReply(content: string): string[] {
  for (const x of jsonCandidates(content) as any[])
    if (Array.isArray(x?.notes) && x.notes.every((n: unknown) => typeof n === 'string')) return x.notes.slice(0, 2)
  throw new Error('reply has no {"notes": [strings]}')
}

/** Whether `file` would sit inside `workdir`, where the model's own tools could write a note for the next run. */
async function insideWorkdir(file: string, workdir: string): Promise<boolean> {
  const real = async (p: string): Promise<string> => { try { return await realpath(p) } catch { const d = path.dirname(p); return d === p ? p : path.join(await real(d), path.basename(p)) } }
  const rel = path.relative(await real(workdir), await real(file))
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** runAgent with the folder's notes: holds the run's `done`, makes the writer call, yields `note_written`, then `done`.
 *  The server ends a run's stream at `done`, so the note has to come first. Notes off or no store: runAgent as it is. */
export async function* withNotes(params: RunParams, opts: RunOpts, store: NotesStore | undefined, runId: string): AsyncGenerator<HarnessEvent> {
  const { config } = params
  if (!config.notes?.enabled || !store) { yield* runAgent(params, opts); return }
  if (await insideWorkdir(store.file, params.workdir)) {
    // Said once, where the note would have been, so the trace and the terminal both show why there are none.
    yield* holdDone(runAgent(params, opts), { type: 'note_written', notes: [], error: `the notes file ${store.file} is inside the workdir, where the model could write it; notes are off for this run (set LHB_NOTES_DIR)` })
    return
  }
  const all = await readNotes(store.file)
  const sent = selectNotes(all, config.notes.maxTokens)
  const events: HarnessEvent[] = []
  let done: Extract<HarnessEvent, { type: 'done' }> | undefined
  for await (const e of runAgent({ ...params, notes: sent }, opts)) {
    if (e.type === 'done') { done = e; break }
    events.push(e)
    yield e
  }
  if (!done) return
  // A run that never got a reply has nothing to note, and a dead server would only be asked again.
  if (store.write && done.turns > 0 && !['aborted', 'backend_error', 'mcp_error'].includes(done.reason)) {
    const name = config.backend.apiKeyEnv
    const redact = redactor(name === undefined ? undefined : apiKey(config.backend, process.env), name ?? '')
    const written: Ev = await writeNotes(params, opts, store.file, sent, [...events, done], runId, redact)
    yield redact.deep({ ...written, seq: done.seq, turn: done.turn, ts: Date.now() } as HarnessEvent)
    yield { ...done, seq: done.seq + 1 }
  } else yield done
}

/** The run's events as they come, with `extra` between the last of them and `done`. */
async function* holdDone(run: AsyncGenerator<HarnessEvent>, extra: Ev): AsyncGenerator<HarnessEvent> {
  for await (const e of run) {
    if (e.type !== 'done') { yield e; continue }
    yield { ...extra, seq: e.seq, turn: e.turn, ts: Date.now() } as HarnessEvent
    yield { ...e, seq: e.seq + 1 }
  }
}

async function writeNotes(params: RunParams, opts: RunOpts, file: string, existing: Note[], events: HarnessEvent[], runId: string,
  redact: ReturnType<typeof redactor>): Promise<Ev> {
  const { config, task } = params
  // What the run's knobs_off said the model does not take is left out here too.
  const off = new Set<Knob | string>(events.flatMap(e => e.type === 'knobs_off' ? e.off.map(o => o.knob) : []))
  const b = config.backend
  const req: ChatRequest = {
    model: b.model,
    messages: [
      // The harness's /no_think line rides along: without it a Qwen3 thinks by default and spends the reply cap on it.
      { role: 'system', content: NO_THINK_LINE.test(config.systemPrompt) ? WRITER_SYSTEM + '\n/no_think' : WRITER_SYSTEM },
      { role: 'user', content: `Task:\n${task}\n\nRun summary:\n${traceSignals(events)}\n\nExisting notes:\n${existing.map(n => n.text).join('\n') || '(none)'}` },
    ],
    // Only where the harness holds replies to a schema itself: a server without structured output refuses the field.
    ...(config.toolCalls.enforceSchema ? { responseSchema: NOTE_SCHEMA } : {}),
    ...(off.has('temperature') ? {} : { temperature: b.temperature }),
    ...(off.has('maxTokens') ? {} : { maxTokens: b.maxTokens ?? 1024 }),
    ...(off.has('think') || b.think === undefined ? {} : { think: b.think }),
    ...(b.numCtx === undefined ? {} : { numCtx: b.numCtx }),
  }
  let usage: Usage | undefined
  const spent = (u?: Usage) => { const c = costOf(u, b.pricePerMTok); return { ...(u ? { usage: u } : {}), ...(c === undefined ? {} : { costUsd: c }) } }
  try {
    const backend = opts.backend ?? createBackend(b)
    const r = await backend.send(backend.buildPayload(req), opts.signal)
    usage = r.usage
    const notes: Note[] = parseReply(r.content)
      .map(t => scrubNote(t, redact, homedir()))
      .filter(Boolean)
      .map(text => ({ id: randomUUID(), ts: Date.now(), run: runId, author: 'model', text }))
    await appendNotes(file, notes)
    return { type: 'note_written', notes: notes.map(n => ({ id: n.id, text: n.text })), ...spent(usage) }
  } catch (e) {
    return { type: 'note_written', notes: [], ...spent(usage), error: (e as Error).message }
  }
}
