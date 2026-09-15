import { readdir, open, mkdir, writeFile as fsWrite, readFile as fsRead } from 'node:fs/promises'
import path from 'node:path'
import { resolveInside } from './sandbox.js'

export type ToolCtx = { workdir: string; maxToolOutputChars: number; reads?: Set<string> }
type Args = Record<string, unknown>

const str = (args: Args, key: string): string => {
  const v = args[key]
  if (typeof v !== 'string') throw new Error(`argument "${key}" must be a string`)
  return v
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
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally { await fh.close() }
}

export async function writeFile(args: Args, ctx: ToolCtx): Promise<string> {
  const file = await resolveInside(ctx.workdir, str(args, 'path'))
  const content = str(args, 'content')
  await mkdir(path.dirname(file), { recursive: true })
  await fsWrite(file, content, 'utf8')
  return `wrote ${content.length} chars to ${str(args, 'path')}`
}

export async function editFile(args: Args, ctx: ToolCtx): Promise<string> {
  const file = await resolveInside(ctx.workdir, str(args, 'path'))
  const oldS = str(args, 'old'), newS = str(args, 'new')
  const raw = await fsRead(file)
  if (raw.includes(0)) throw new Error('refusing to edit a binary file')
  const text = raw.toString('utf8')
  const crlf = text.includes('\r\n')
  const lf = text.replace(/\r\n/g, '\n')
  const needle = oldS.replace(/\r\n/g, '\n')
  const count = lf.split(needle).length - 1
  if (count !== 1) throw new Error(`"old" must occur exactly once; found ${count} occurrences`)
  const replacement = newS.replace(/\r\n/g, '\n')
  let out = lf.replace(needle, () => replacement)
  if (crlf) out = out.replace(/\n/g, '\r\n')
  await fsWrite(file, out, 'utf8')
  return `edited ${str(args, 'path')}`
}
