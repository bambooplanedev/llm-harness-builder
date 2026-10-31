import { readdir, open, mkdir, writeFile as fsWrite, readFile as fsRead, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveInside } from './sandbox.js'
import { GUARD_BLOCKED, EDIT_MISS, EDIT_IDENTICAL } from './errors.js'

export type ToolCtx = { workdir: string; reads?: Set<string>; /** tools.readRanges: read_file takes start/end. */ readRanges?: boolean; /** Set by a ranged read_file for run.ts's line-aware cut, which clears it. */ lastRead?: { file: string; first: number; total: number; capped?: number }; /** Files read only in part (guard on): write_file refuses them. */ partReads?: Set<string>; explainEditMiss?: boolean; /** Names from tools.bashEnv; absent: the base set only. */ bashEnv?: readonly string[]; /** tools.readMaxBytes, tools.bashMaxBytes, tools.bashTimeoutS; absent: the built-in limit. */ readMaxBytes?: number; bashMaxBytes?: number; bashTimeoutS?: number }
type Args = Record<string, unknown>

const str = (args: Args, key: string): string => {
  const v = args[key]
  if (typeof v !== 'string') throw new Error(`argument "${key}" must be a string`)
  return v
}

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

/** Default ceiling on one read (tools.readMaxBytes). The per-harness maxToolOutputChars cut happens in the run loop, which reports how much it dropped. */
const MAX_READ_BYTES = 4 << 20

/** A non-negative-integer number or digit string, else undefined. */
const lineNo = (v: unknown): number | undefined => typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined

/** The first `limit` bytes of a file, decoded, and its whole size in bytes. */
async function head(file: string, limit: number): Promise<{ text: string; size: number }> {
  const fh = await open(file, 'r')
  try {
    const size = (await fh.stat()).size
    const n = Math.min(size, limit)
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return { text: buf.subarray(0, bytesRead).toString('utf8'), size }
  } finally { await fh.close() }
}

async function readRange(args: Args, ctx: ToolCtx): Promise<string> {
  const file = await resolveInside(ctx.workdir, str(args, 'path'))
  const limit = ctx.readMaxBytes ?? MAX_READ_BYTES
  const { text, size } = await head(file, limit)
  const capped = size > limit ? limit : undefined
  const lines = text === '' ? [] : text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  const total = lines.length
  const start = args.start === undefined ? 1 : lineNo(args.start), end = args.end === undefined ? Infinity : lineNo(args.end)
  if (start === undefined || end === undefined || start < 1 || end < start) throw new Error('start and end must be line numbers from 1, with end not before start')
  if (ctx.reads) {
    ctx.reads.add(file)
    // Part only when the selection leaves lines out: {start: 1} on a whole file is a whole read.
    if (start > 1 || end < total || capped) ctx.partReads?.add(file); else ctx.partReads?.delete(file)
  }
  if (total === 0) return '[no lines: the file is empty]'
  if (start > total) return capped ? `[no lines: the first ${capped} bytes hold ${total} lines; read the rest with bash]` : `[no lines: the file has ${total}]`
  ctx.lastRead = { file, first: start, total, capped }
  return lines.slice(start - 1, end).join('\n') + (capped && end >= total ? `\n[truncated at ${capped} bytes]` : '')
}

/** Cuts at whole lines and says which were shown; undefined when not even one fits, then the caller cuts by characters. */
export function cutLines(text: string, max: number, r: { first: number; total: number; capped?: number }): string | undefined {
  if (text.length <= max) return text
  const lines = text.split('\n')
  // Running length, one join at the end: the note's width depends only on k, so each step is O(1).
  let best = 0, len = 0
  for (let k = 1; k <= lines.length; k++) {
    len += lines[k - 1].length + (k > 1 ? 1 : 0)
    if (len + `\n[lines ${r.first}-${r.first + k - 1} of ${r.total}${r.capped ? '+' : ''} shown; read on with start: ${r.first + k}]`.length > max) break
    best = k
  }
  return best ? lines.slice(0, best).join('\n') + `\n[lines ${r.first}-${r.first + best - 1} of ${r.total}${r.capped ? '+' : ''} shown; read on with start: ${r.first + best}]` : undefined
}

export async function readFile(args: Args, ctx: ToolCtx): Promise<string> {
  if (ctx.readRanges) return readRange(args, ctx)
  const file = await resolveInside(ctx.workdir, str(args, 'path'))
  const limit = ctx.readMaxBytes ?? MAX_READ_BYTES
  const { text, size } = await head(file, limit)
  ctx.reads?.add(file)
  // The model must know it saw only the head.
  return text + (size > limit ? `\n[truncated at ${limit} bytes]` : '')
}

export async function writeFile(args: Args, ctx: ToolCtx): Promise<string> {
  const file = await resolveInside(ctx.workdir, str(args, 'path'))
  const content = str(args, 'content')
  // An existing file must have been read; a new one may be created freely. The stat only runs
  // when the guard is on, so a harness without it writes exactly as before.
  if (ctx.reads && await exists(file)) {
    ensureRead(ctx, file, str(args, 'path'))
    if (ctx.partReads?.has(file)) throw new Error(`${str(args, 'path')} was read only in part; read it whole with read_file before overwriting it`)
  }
  await mkdir(path.dirname(file), { recursive: true })
  await fsWrite(file, content, 'utf8')
  ctx.reads?.add(file)
  ctx.partReads?.delete(file)
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
  if (needle === replacement) throw new Error(`${EDIT_IDENTICAL}: nothing to change`)
  let out = lf.replace(needle, () => replacement)
  if (crlf) out = out.replace(/\n/g, '\r\n')
  await fsWrite(file, out, 'utf8')
  ctx.reads?.add(file)
  return `edited ${str(args, 'path')}`
}
