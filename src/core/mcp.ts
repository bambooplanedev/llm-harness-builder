import { spawn, type ChildProcess } from 'node:child_process'
import type { ToolSchema } from './backends/types.js'
import type { McpServerConfig } from './config.js'
import { track, untrack } from './procs.js'

export type McpServerInfo = {
  server: string; command: string; args: string[]
  offered: number; tools: string[]; descriptionChars: number; schemaChars: number
}

export type McpSession = {
  tools: ToolSchema[]
  servers: McpServerInfo[]
  has(name: string): boolean
  call(name: string, args: Record<string, unknown>): Promise<{ output: string; error: boolean }>
  close(): void
}

export const MCP_HANDSHAKE_TIMEOUT_MS = 60_000
export const MCP_CALL_TIMEOUT_MS = 60_000
/** A line longer than this means the server is broken; grow no further. */
const MAX_LINE_BYTES = 1 << 20
const STDERR_TAIL = 8 << 10
const PROTOCOL_VERSION = '2025-06-18'

type Pending = { resolve: (m: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/** One live server connection. Owns its child, its own id counter and its own pending map. */
class Conn {
  private child: ChildProcess
  private pid?: number
  private buf = ''
  private id = 0
  private pending = new Map<number, Pending>()
  private stderr = ''
  dead = false

  constructor(readonly name: string, readonly command: string, readonly args: string[], cwd: string) {
    this.child = spawn(command, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.pid = this.child.pid
    if (this.pid) track(this.pid)
    this.child.stdout!.on('data', (d: Buffer) => this.onData(d))
    this.child.stderr!.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-STDERR_TAIL)
    })
    this.child.on('error', e => this.die(`spawn failed: ${e.message}`))
    this.child.on('close', () => this.die('server exited'))
    // stdin can break before we notice the child is gone; that must not kill the process.
    this.child.stdin!.on('error', () => {})
  }

  private onData(d: Buffer) {
    if (this.dead) return
    this.buf += d.toString('utf8')
    if (this.buf.length > MAX_LINE_BYTES) return this.die('server wrote a line over 1 MB', true)
    for (let i; (i = this.buf.indexOf('\n')) >= 0; ) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let m: any
      try { m = JSON.parse(line) } catch { continue }   // servers do write junk to stdout
      const p = typeof m?.id === 'number' ? this.pending.get(m.id) : undefined
      if (!p) continue
      clearTimeout(p.timer)
      this.pending.delete(m.id)
      p.resolve(m)
    }
  }

  /** killGroup: true when *we* decided the server is broken (timeout, oversize line) and it is
   *  certainly still alive, so we must reap it ourselves. false when the child died on its own
   *  (exit/error): the pid may already be recycled, and killing that group would be worse than
   *  leaking it. */
  private die(why: string, killGroup = false) {
    if (this.dead) return
    this.dead = true
    this.buf = ''
    if (this.pid) {
      if (killGroup) { try { process.kill(-this.pid, 'SIGKILL') } catch {} }
      untrack(this.pid)
    }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(why)) }
    this.pending.clear()
  }

  get stderrTail() { return this.stderr }

  notify(method: string) {
    if (!this.dead) this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.dead) return Promise.reject(new Error(`mcp server "${this.name}" is not running`))
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.die(`timed out after ${Math.round(timeoutMs / 1000)}s`, true)
        reject(new Error(`mcp server "${this.name}": ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  close() {
    this.die('closed', true)
  }
}

/** The server's JSON Schema, made safe for renderTools and for a backend's tools[]. */
function normalize(raw: unknown): Record<string, unknown> {
  const s = raw as Record<string, unknown> | undefined
  if (!s || typeof s !== 'object' || s.type !== 'object') return { type: 'object', properties: {}, required: [] }
  const { $schema, ...rest } = s                          // 11% of the block, pure noise
  return rest as Record<string, unknown>
}

/** MCP content blocks → one string. Non-text blocks cannot reach a local 8B, but must not vanish silently. */
function flatten(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) return '(empty result)'
  const parts = content.map((b: any) =>
    b?.type === 'text' ? String(b.text ?? '') : `[${String(b?.type ?? 'unknown')} content omitted]`)
  const out = parts.join('\n')
  return out.trim() === '' ? '(empty result)' : out
}

export async function startServers(
  servers: Record<string, McpServerConfig>,
  workdir: string,
  opts: { signal?: AbortSignal; taken?: Set<string>; timeoutMs?: number } = {},
): Promise<McpSession> {
  const handshake = opts.timeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS
  const conns: Conn[] = []
  const byTool = new Map<string, Conn>()
  const tools: ToolSchema[] = []
  const info: McpServerInfo[] = []
  const taken = new Set(opts.taken ?? [])

  try {
    for (const [name, cfg] of Object.entries(servers)) {
      if (opts.signal?.aborted) throw new Error('aborted')
      const args = cfg.args ?? []
      const conn = new Conn(name, cfg.command, args, workdir)
      opts.signal?.addEventListener('abort', () => conn.close(), { once: true })
      conns.push(conn)
      try {
        await conn.request('initialize', {
          protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'llm-harness-builder', version: '1' },
        }, handshake)
        conn.notify('notifications/initialized')
        const res = await conn.request('tools/list', {}, handshake)
        const offered: any[] = Array.isArray(res?.result?.tools) ? res.result.tools : []
        const wanted = cfg.tools?.length ? new Set(cfg.tools) : null
        const kept = offered.filter(t => !wanted || wanted.has(t.name))
        let descriptionChars = 0, schemaChars = 0
        for (const t of kept) {
          if (taken.has(t.name))
            throw new Error(`tool name collision: "${t.name}" comes from both the built-ins and mcp server "${name}"`)
          taken.add(t.name)
          const schema: ToolSchema = { name: t.name, description: String(t.description ?? ''), parameters: normalize(t.inputSchema) }
          descriptionChars += schema.description.length
          schemaChars += JSON.stringify(schema.parameters).length
          tools.push(schema)
          byTool.set(t.name, conn)
        }
        info.push({ server: name, command: cfg.command, args, offered: offered.length, tools: kept.map(t => t.name), descriptionChars, schemaChars })
      } catch (e) {
        const tail = conn.stderrTail.trim()
        throw new Error(`mcp server "${name}" failed to start: ${(e as Error).message}${tail ? `\n${tail}` : ''}`)
      }
    }
  } catch (e) {
    for (const c of conns) c.close()     // a later failure must not leave earlier servers running
    throw e
  }

  return {
    tools, servers: info,
    has: (n: string) => byTool.has(n),
    call: async (name, args) => {
      const conn = byTool.get(name)
      if (!conn) return { output: `no mcp server provides "${name}"`, error: true }
      try {
        const m = await conn.request('tools/call', { name, arguments: args }, opts.timeoutMs ?? MCP_CALL_TIMEOUT_MS)
        if (m.error) return { output: `mcp error ${m.error.code}: ${m.error.message}`, error: true }
        return { output: flatten(m.result?.content), error: m.result?.isError === true }
      } catch (e) {
        return { output: (e as Error).message, error: true }
      }
    },
    close: () => { for (const c of conns) c.close() },
  }
}
