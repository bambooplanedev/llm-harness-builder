// src/core/proxy/own.ts — the user's own dialect (.mjs) and connection (.json) files, over the built-in ones.
// An own dialect is code run with full trust; the checks here are against mistakes, not against its author.
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Dialect } from './dialects/dialect.js'
import { ID, checkConnection, type Connection } from './connections.js'

type Kind = 'dialect' | 'connection'

/** The real file behind `file`: absolute, a regular file, its real name ending in `ext`. `?`/`#` in the string cannot swap it. */
function realFile(file: string, kind: Kind, ext: string): string {
  const no = (why: string) => new Error(`${kind} ${file}: ${why}`)
  if (!path.isAbsolute(file)) throw no('the path must be absolute')
  let real: string
  try { real = realpathSync(file) } catch (e) { throw no((e as Error).message) }
  if (!statSync(real).isFile()) throw no('not a file')
  if (path.extname(real) !== ext) throw no(`not a ${ext} file: ${real}`)
  return real
}

export function loadOwnConnection(file: string): Connection {
  const real = realFile(file, 'connection', '.json')
  let c: unknown
  try { c = JSON.parse(readFileSync(real, 'utf8')) } catch (e) { throw new Error(`connection ${file}: ${(e as Error).message}`) }
  return checkConnection(c, `connection ${file}`)
}

const METHODS = ['matches', 'keyOf', 'toolResults', 'readReply', 'partial'] as const

export async function loadOwnDialect(file: string): Promise<Dialect> {
  const real = realFile(file, 'dialect', '.mjs')
  const no = (why: string) => new Error(`dialect ${file}: ${why}`)
  let d: Record<string, unknown>
  try { d = (await import(pathToFileURL(real).href)).default } catch (e) { throw no(e instanceof Error ? e.message : String(e)) }
  if (!d || typeof d !== 'object') throw no('needs `export default` of a dialect object')
  if (typeof d.id !== 'string' || !ID.test(d.id)) throw no(`id must match ${ID}`)
  if (typeof d.label !== 'string') throw no('label must be a string')
  for (const m of METHODS) if (typeof d[m] !== 'function') throw no(`${m} must be a function`)
  return guard(d as Dialect)
}

/** `d` with every call's return shape checked; anything thrown that is not an Error becomes one naming the method. */
function guard(d: Dialect): Dialect {
  const fail = (m: string, why: unknown): never => { throw why instanceof Error ? why : new Error(`dialect ${d.id}: ${m}: ${String(why)}`) }
  const call = <M extends typeof METHODS[number]>(m: M, args: Parameters<Dialect[M]>): ReturnType<Dialect[M]> => {
    try { return (d[m] as (...a: unknown[]) => ReturnType<Dialect[M]>).apply(d, args) } catch (e) { return fail(m, e) }
  }
  const awaited = async <M extends 'readReply' | 'partial'>(m: M, args: Parameters<Dialect[M]>) => {
    try { return await call(m, args) } catch (e) { return fail(m, e) }
  }
  const str = (v: unknown) => typeof v === 'string'
  return {
    id: d.id, label: d.label,
    matches: (...a) => call('matches', a),
    keyOf(...a) {
      const r = call('keyOf', a) as unknown as Record<string, unknown>
      if (!r || typeof r !== 'object' || typeof r.then === 'function' || !str(r.key) || !str(r.taskText) || !str(r.model) || !Number.isInteger(r.len) || (r.len as number) < 0) {
        fail('keyOf', 'must return { key, taskText, model } strings and len, an integer >= 0, synchronously')
      }
      return r as ReturnType<Dialect['keyOf']>
    },
    toolResults(...a) {
      const r = call('toolResults', a)
      if (!Array.isArray(r)) fail('toolResults', 'must return an array')
      return r
    },
    async readReply(...a) {
      const r = await awaited('readReply', a)
      if (!r || typeof r !== 'object' || !str(r.content) || !Array.isArray(r.toolCalls)) fail('readReply', 'must resolve to { content: string, toolCalls: [] }')
      return r
    },
    async partial(...a) {
      const r = await awaited('partial', a)
      if (r !== undefined && !str(r)) fail('partial', 'must resolve to a string or undefined')
      return r
    },
  }
}

/**
 * Own items in flag order, then the built-ins none of them replaces; one startup line per own file.
 * Two own files with one id are refused, naming the second.
 */
export function mergeOwn<T>(own: { item: T; file: string }[], builtIn: T[], idOf: (t: T) => string, kind: Kind): { list: T[]; lines: string[] } {
  const seen = new Map<string, string>()
  for (const { item, file } of own) {
    const id = idOf(item), first = seen.get(id)
    if (first !== undefined) throw new Error(`${kind} ${file}: ${id} is already loaded from ${first}`)
    seen.set(id, file)
  }
  const builtIds = new Set(builtIn.map(idOf))
  return {
    list: [...own.map(o => o.item), ...builtIn.filter(b => !seen.has(idOf(b)))],
    lines: own.map(({ item, file }) => `${kind} ${idOf(item)} from ${file}${builtIds.has(idOf(item)) ? ' (replaces built-in)' : ''}`),
  }
}

const hinted = (c: Connection) => Object.keys(c.hints).length > 0

/** Own connections over the built-ins in pick order: hinted ones (own first), then the single fallback. */
export function mergeConnections(files: string[], builtIn: Connection[]): { list: Connection[]; lines: string[] } {
  const own = files.map(file => ({ item: loadOwnConnection(file), file }))
  const { list, lines } = mergeOwn(own, builtIn, c => c.name, 'connection')
  const fallbacks = list.filter(c => !hinted(c))
  if (fallbacks.length !== 1) {
    // Only an own file changes the count: one with empty hints, or one that replaced the built-in fallback.
    const culprit = own.find(o => !hinted(o.item) || builtIn.some(b => !hinted(b) && b.name === o.item.name))?.file ?? files[0]
    throw new Error(`connection ${culprit}: needs exactly one connection with empty hints after merging, found ${fallbacks.length} (an own fallback must be named generic)`)
  }
  return { list: [...list.filter(hinted), ...fallbacks], lines }
}

/** Own dialects over the built-ins, loaded in flag order. */
export async function mergeDialects(files: string[], builtIn: readonly Dialect[]): Promise<{ list: Dialect[]; lines: string[] }> {
  const own: { item: Dialect; file: string }[] = []
  for (const file of files) own.push({ item: await loadOwnDialect(file), file })
  return mergeOwn(own, [...builtIn], d => d.id, 'dialect')
}
