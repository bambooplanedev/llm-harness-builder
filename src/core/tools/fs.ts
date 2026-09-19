import { readdir, open, mkdir, writeFile as fsWrite, readFile as fsRead, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveInside } from './sandbox.js'

export type ToolCtx = { workdir: string; maxToolOutputChars: number; reads?: Set<string>; explainEditMiss?: boolean }
type Args = Record<string, unknown>

const str = (args: Args, key: string): string => {
  const v = args[key]
  if (typeof v !== 'string') throw new Error(`argument "${key}" must be a string`)
  return v
}

/**
 * Substrings of the two errors bench counts. Exported so the counter keys off the text the tool
 * writes rather than a copy of it: change the wording here and both move together.
 */
export const GUARD_BLOCKED = 'has not been read in this run'
export const EDIT_MISS = 'must occur exactly once'

const exists = async (p: string): Promise<boolean> => { try { await stat(p); return true } catch { return false } }

/** No-op unless the harness asked for the guard: ctx.reads is present only then. */
function ensureRead(ctx: ToolCtx, file: string, shown: string): void {
  if (ctx.reads && !ctx.reads.has(file)) throw new Error(`${shown} ${GUARD_BLOCKED}; call read_file first`)
}

export async function listDir(args: Args, ctx: ToolCtx): Promise<string> {
  const dir = await resolveInside(ctx.workdir, str(args, 'path'))
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter(e => !e.name.startsWith('.'))
    .map(e => (e.isDirectory() ? e.name + '/' : e.name))
    .sort()
    .join('\n')
}

/** Hard ceiling on one read. The per-harness maxToolOutputChars cut happens in the run loop, which reports how much it dropped. */
const MAX_READ_BYTES = 4 << 20

export async function readFile(args: Args, ctx: ToolCtx): Promise<string> {
  const file = await resolveInside(ctx.workdir, str(args, 'path'))
  const fh = await open(file, 'r')
  try {
    const n = Math.min((await fh.stat()).size, MAX_READ_BYTES)
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    ctx.reads?.add(file)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally { await fh.close() }
}

export async function writeFile(args: Args, ctx: ToolCtx): Promise<string> {
  const file = await resolveInside(ctx.workdir, str(args, 'path'))
  const content = str(args, 'content')
  // An existing file must have been read; a new one may be created freely. The stat only runs
  // when the guard is on, so a harness without it writes exactly as before.
  if (ctx.reads && await exists(file)) ensureRead(ctx, file, str(args, 'path'))
  await mkdir(path.dirname(file), { recursive: true })
  await fsWrite(file, content, 'utf8')
  ctx.reads?.add(file)
  return `wrote ${content.length} chars to ${str(args, 'path')}`
}

/** Letters, digits and "_" only: two lines equal under this differ in punctuation or whitespace alone. */
const bare = (s: string): string => s.replace(/[^\p{L}\p{N}_]+/gu, '')

/**
 * For a one-line "old" that was not found: the file line equal to it once punctuation and whitespace
 * are ignored, shown verbatim. '' when there is none — the caller's message then stays as it was.
 */
function explainMiss(lf: string, needle: string, shown: string): string {
  const probe = needle.trim()
  if (probe.includes('\n') || !bare(probe)) return ''
  const lines = lf.split('\n')
  const i = lines.findIndex(l => bare(l) === bare(probe))
  if (i < 0 || lines[i].length > 300) return ''
  return `. Line ${i + 1} of ${shown} matches your "old" except for punctuation or whitespace; the file has exactly:\n${lines[i]}`
}

export async function editFile(args: Args, ctx: ToolCtx): Promise<string> {
  const file = await resolveInside(ctx.workdir, str(args, 'path'))
  ensureRead(ctx, file, str(args, 'path'))
  const oldS = str(args, 'old'), newS = str(args, 'new')
  const raw = await fsRead(file)
  if (raw.includes(0)) throw new Error('refusing to edit a binary file')
  const text = raw.toString('utf8')
  const crlf = text.includes('\r\n')
  const lf = text.replace(/\r\n/g, '\n')
  const needle = oldS.replace(/\r\n/g, '\n')
  const count = lf.split(needle).length - 1
  if (count !== 1) throw new Error(`"old" ${EDIT_MISS}; found ${count} occurrences`
    + (count === 0 && ctx.explainEditMiss ? explainMiss(lf, needle, str(args, 'path')) : ''))
  const replacement = newS.replace(/\r\n/g, '\n')
  if (needle === replacement) throw new Error('"old" and "new" are identical: nothing to change')
  let out = lf.replace(needle, () => replacement)
  if (crlf) out = out.replace(/\n/g, '\r\n')
  await fsWrite(file, out, 'utf8')
  ctx.reads?.add(file)
  return `edited ${str(args, 'path')}`
}
