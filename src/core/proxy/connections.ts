// src/core/proxy/connections.ts — which agent sent a request, read off the package's connections/*.json.
// A connection maps hint headers to names and says how to cut the agent's wrapping off the task.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type HintKey = 'session' | 'agent' | 'parent' | 'agentType' | 'requestClass'
/** What an agent's hint headers say about a request; never the headers themselves. */
export type ProxyHints = Partial<Record<HintKey, string>>
export type Connection = { name: string; hints: Partial<Record<HintKey, string>>; auxiliary?: string; compaction?: string; taskStrip: [string, string][]; hint?: string }
export type Picked = { conn: Connection; hints: ProxyHints }

/** The package's own folder, never the cwd: the proxy runs inside the repo the agent edits. */
export const CONNECTIONS_DIR = fileURLToPath(new URL('../../../connections', import.meta.url))

/** Header names a connection may not read: their values are keys, and a hint lands in the meta as it is. */
const SECRET = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'cookie'])

/** Every *.json of `dir`: the ones with hints by file name, then the one without (the fallback). Throws naming the file. */
export function loadConnections(dir = CONNECTIONS_DIR): Connection[] {
  let names: string[]
  try { names = readdirSync(dir).filter(f => f.endsWith('.json')).sort() } catch { throw new Error(`no connections folder at ${dir}`) }
  if (!names.length) throw new Error(`no connections (*.json) in ${dir}`)
  const all = names.map(f => {
    let c: Connection
    try { c = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) } catch (e) { throw new Error(`connections/${f}: ${(e as Error).message}`) }
    if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.hints || typeof c.hints !== 'object' || !Array.isArray(c.taskStrip)) {
      throw new Error(`connections/${f}: needs name, hints and taskStrip`)
    }
    for (const h of Object.values(c.hints)) {
      if (typeof h !== 'string' || h !== h.toLowerCase() || SECRET.has(h)) throw new Error(`connections/${f}: hint header ${JSON.stringify(h)} is not a lowercase header name that carries no key`)
    }
    return c
  })
  const hinted = all.filter(c => Object.keys(c.hints).length), fallback = all.filter(c => !Object.keys(c.hints).length)
  if (fallback.length !== 1) throw new Error(`${dir}: needs exactly one connection with empty hints, found ${fallback.length}`)
  return [...hinted, ...fallback]
}

/** The first connection with any valid hint (one string of 1..128 printable ASCII characters), else the fallback with none. */
export function pickConnection(conns: Connection[], headers: Record<string, string | string[] | undefined>): Picked {
  for (const conn of conns) {
    const hints: ProxyHints = {}
    for (const [k, name] of Object.entries(conn.hints) as [HintKey, string][]) {
      const v = headers[name]
      if (typeof v === 'string' && /^[\x21-\x7e]{1,128}$/.test(v)) hints[k] = v
    }
    if (Object.keys(hints).length) return { conn, hints }
  }
  return { conn: conns[conns.length - 1], hints: {} }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The task as the agent typed it: each open..close pair cut out; an unclosed one runs to the end. Literal tags, never a regex. */
export function stripTask(conn: Connection, text: string): string {
  for (const [open, close] of conn.taskStrip) text = text.replace(new RegExp(esc(open) + '[\\s\\S]*?(?:' + esc(close) + '|$)', 'g'), '')
  return text.trim()
}
