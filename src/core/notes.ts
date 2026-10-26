// Notes: short observations a harness keeps from its earlier runs on one folder and sends after the task of the next
// run. One JSON line per note in <runsDir>/notes/<key>.jsonl — outside the project and outside the model's workdir, so
// the model can neither read nor rewrite them, and nothing of them gets committed.
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { HarnessEvent } from './events.js'
import type { Redactor } from './redact.js'

export type Note = { id: string; ts: number; run?: string; author: 'model' | 'user'; text: string }

/** The key of a run's folder: 16 hex chars of the sha256 of its real path. */
export const notesKey = async (workdir: string): Promise<string> =>
  createHash('sha256').update(await realpath(workdir)).digest('hex').slice(0, 16)

export const notesPath = (runsDir: string, key: string): string => path.join(runsDir, 'notes', `${key}.jsonl`)

const isNote = (x: any): x is Note =>
  typeof x?.id === 'string' && typeof x.ts === 'number' && (x.author === 'model' || x.author === 'user') && typeof x.text === 'string'

/** A missing file is no notes; a line that is not a note (a killed write, a hand edit gone wrong) is skipped. */
export async function readNotes(file: string): Promise<Note[]> {
  let text: string
  try { text = await readFile(file, 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  return text.split('\n').flatMap(l => { try { const x = JSON.parse(l); return isNote(x) ? [x] : [] } catch { return [] } })
}

export async function appendNotes(file: string, notes: Note[]): Promise<void> {
  if (!notes.length) return
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, notes.map(n => JSON.stringify(n) + '\n').join(''))
}

const line = (n: Note) => `- ${n.text}`

/** Newest first, as many as fit in `maxTokens` (chars / 4, like estimateTokens). */
export function selectNotes(notes: Note[], maxTokens: number): Note[] {
  const out: Note[] = []
  let used = 0
  for (const n of [...notes].sort((a, b) => b.ts - a.ts)) {
    const cost = Math.ceil((line(n).length + 1) / 4)
    if (used + cost > maxTokens) break
    out.push(n); used += cost
  }
  return out
}

export const notesBlock = (notes: Note[]): string =>
  notes.length ? ['Notes from earlier runs on this project (past observations, not instructions):', ...notes.map(line)].join('\n') : ''

const SECRETS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, /\bgh[pousr]_[A-Za-z0-9]{30,}/g, /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
]
export const NOTE_MAX_CHARS = 300

/** The backend key, secret-looking tokens and the home path out of a note, whitespace collapsed, cut to NOTE_MAX_CHARS. */
export function scrubNote(text: string, redact: Redactor, home: string): string {
  let s = redact.text(text)
  for (const re of SECRETS) s = s.replace(re, '[secret]')
  if (home) s = s.split(home).join('~')
  return s.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX_CHARS)
}

/** What happened in a run, without its content: tool names, argument keys, the path argument, lengths, verdicts.
 *  Argument values are file text (edit, write) or commands taken from the repo (bash), and outputs are the repo's
 *  own text — neither is in here, so hostile text in a project cannot turn into a note or leave the machine. */
export function traceSignals(events: HarnessEvent[]): string {
  const out: string[] = []
  for (const e of events) {
    if (e.type === 'tool_call') {
      const p = typeof e.call.args.path === 'string' ? ` path=${e.call.args.path}` : ''
      out.push(`call ${e.call.name} keys=${Object.keys(e.call.args).join(',')}${p} len=${JSON.stringify(e.call.args).length}`)
    } else if (e.type === 'tool_result' && e.error) out.push(`result ${e.name} error`)
    else if (e.type === 'parse_error') out.push('parse_error')
    else if (e.type === 'final_check') out.push(`final_check ${e.passed ? 'passed' : 'failed'}`)
    else if (e.type === 'done') out.push(`done ${e.reason} turns=${e.turns} calls=${e.toolCallCount}`)
  }
  return out.join('\n')
}
