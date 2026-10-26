// The run with notes around it: the notes of the folder go in after the task, and after the run a separate call with a
// schema writes up to two new ones. Its own file, not notes.ts: run.ts imports notes.ts for the block.
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { apiKey, type RunParams } from './config.js'
import type { HarnessEvent, Ev } from './events.js'
import { createBackend, type ChatRequest, type Knob, type Usage } from './backends/index.js'
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

/** The notes in a writer reply, or why there are none: anything but {"notes": [strings]} is an error, not a note. */
function parseReply(content: string): string[] {
  const x = JSON.parse(content)
  if (!Array.isArray(x?.notes) || !x.notes.every((n: unknown) => typeof n === 'string')) throw new Error('reply is not {"notes": [strings]}')
  return x.notes.slice(0, 2)
}

/** runAgent with the folder's notes: holds the run's `done`, makes the writer call, yields `note_written`, then `done`.
 *  The server ends a run's stream at `done`, so the note has to come first. Notes off or no store: runAgent as it is. */
export async function* withNotes(params: RunParams, opts: RunOpts, store: NotesStore | undefined, runId: string): AsyncGenerator<HarnessEvent> {
  const { config } = params
  if (!config.notes?.enabled || !store) { yield* runAgent(params, opts); return }
  const all = await readNotes(store.file)
  const events: HarnessEvent[] = []
  let done: Extract<HarnessEvent, { type: 'done' }> | undefined
  for await (const e of runAgent({ ...params, notes: selectNotes(all, config.notes.maxTokens) }, opts)) {
    if (e.type === 'done') { done = e; break }
    events.push(e)
    yield e
  }
  if (!done) return
  if (store.write && done.reason !== 'aborted') {
    const name = config.backend.apiKeyEnv
    const redact = redactor(name === undefined ? undefined : apiKey(config.backend, process.env), name ?? '')
    const written: Ev = await writeNotes(params, opts, store.file, all, [...events, done], runId, redact)
    yield redact.deep({ ...written, seq: done.seq, turn: done.turn, ts: Date.now() } as HarnessEvent)
    yield { ...done, seq: done.seq + 1 }
  } else yield done
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
      { role: 'system', content: WRITER_SYSTEM },
      { role: 'user', content: `Task:\n${task}\n\nRun summary:\n${traceSignals(events)}\n\nExisting notes:\n${existing.map(n => n.text).join('\n') || '(none)'}` },
    ],
    ...(off.has('responseSchema') ? {} : { responseSchema: NOTE_SCHEMA }),
    ...(off.has('temperature') ? {} : { temperature: b.temperature }),
    ...(off.has('maxTokens') ? {} : { maxTokens: b.maxTokens ?? 1024 }),
    ...(off.has('think') || b.think === undefined ? {} : { think: b.think }),
    ...(b.numCtx === undefined ? {} : { numCtx: b.numCtx }),
  }
  let usage: Usage | undefined
  try {
    const backend = opts.backend ?? createBackend(b)
    const r = await backend.send(backend.buildPayload(req), opts.signal)
    usage = r.usage
    const notes: Note[] = parseReply(r.content)
      .map(t => scrubNote(t, redact, homedir()))
      .filter(Boolean)
      .map(text => ({ id: randomUUID(), ts: Date.now(), run: runId, author: 'model', text }))
    await appendNotes(file, notes)
    return { type: 'note_written', notes: notes.map(n => ({ id: n.id, text: n.text })), ...(usage ? { usage } : {}) }
  } catch (e) {
    return { type: 'note_written', notes: [], ...(usage ? { usage } : {}), error: (e as Error).message }
  }
}
