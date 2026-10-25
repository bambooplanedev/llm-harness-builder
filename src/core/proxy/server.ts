// src/core/proxy/server.ts — the recording proxy: forwards every request to one upstream unchanged and writes
// chat completions and Anthropic messages into runs/<id>.jsonl through TraceWriter. Forwarding never waits on recording.
import http from 'node:http'
import https from 'node:https'
import { randomUUID } from 'node:crypto'
import { TraceWriter } from '../../server/runs.js'
import { refusal } from '../../server/origin.js'
import { collect, fromJson } from '../backends/openai.js'
import { collectAnthropic, fromAnthropicJson } from '../backends/anthropic.js'
import { BackendError, jsonChunks, type NormalizedResponse } from '../backends/types.js'
import type { HarnessEvent } from '../events.js'
import { Sessions, hintsOf, type ReplyOutcome, type RunMeta } from './sessions.js'
import { redactor } from '../redact.js'

export type ProxyOpts = {
  /** Server root, e.g. http://127.0.0.1:8080; a path prefix, if any, is kept. */
  upstream: string
  port: number
  runsDir: string
  /** The `harness` label of every run this proxy writes. */
  harness: string
  /** One line per new run and per recording problem; stderr in the CLI. */
  log?: (line: string) => void
  /** Request bodies larger than this are forwarded but not recorded. */
  recordCap?: number
}
export type ProxyServer = { port: number; stop(): Promise<void> }

const HOP = ['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate']
// A request also loses host (http.request sets the upstream's), accept-encoding (the reply and the copy we parse
// stay plain text) and content-length (set again from the bytes actually sent).
const REQ_DROP = new Set([...HOP, 'host', 'accept-encoding', 'content-length'])
const RES_DROP = new Set(HOP)

function headersWithout(h: http.IncomingHttpHeaders, drop: Set<string>): http.OutgoingHttpHeaders {
  const listed = String(h.connection ?? '').split(',').map(s => s.trim().toLowerCase())
  const out: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !drop.has(k) && !listed.includes(k)) out[k] = v
  return out
}

async function readAll(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

const refuse = (res: http.ServerResponse, status: number, message: string) => {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message } }))
}

/**
 * 'drain' or 'close', whichever comes first: a client that has left never drains. `destroyed` is
 * a state, checked first, not just an event: if `res` already closed before this was called (the
 * 'close' event fires once and does not replay for a listener attached afterwards), waiting on a
 * fresh 'close' listener here would hang forever.
 */
export const drained = (res: http.ServerResponse) => new Promise<void>(resolve => {
  if (res.destroyed) return resolve()
  const done = () => { res.off('drain', done); res.off('close', done); resolve() }
  res.on('drain', done); res.on('close', done)
})

type Api = 'openai' | 'anthropic'
const LABEL: Record<Api, string> = { openai: 'POST /chat/completions', anthropic: 'POST /v1/messages' }
/** The API a request is recorded as, if any: /v1/messages/count_tokens and the rest pass through unrecorded. */
const apiOf = (method: string | undefined, pathname: string): Api | undefined =>
  method !== 'POST' ? undefined : pathname.endsWith('/chat/completions') ? 'openai' : pathname.endsWith('/v1/messages') ? 'anthropic' : undefined

/** Takes this request's x-api-key and bearer token out of whatever is recorded from it; headers themselves never are. */
const scrubberOf = (h: http.IncomingHttpHeaders) => {
  const key = redactor(String(h['x-api-key'] ?? ''), 'x-api-key')
  const token = redactor(String(h.authorization ?? '').replace(/^Bearer\s+/i, ''), 'authorization')
  return <T>(x: T): T => token.deep(key.deep(x))
}

/** The text, thinking and tool-argument deltas of a Messages SSE text, joined in order; lines that do not parse are skipped. */
const deltaText = (sse: string) => sse.split('\n').map(l => {
  if (!l.startsWith('data:')) return ''
  try { const d = JSON.parse(l.slice(5)).delta; return [d?.text, d?.thinking, d?.partial_json].find(x => typeof x === 'string') ?? '' } catch { return '' }
}).join('')

/** The reply as the backend itself would read it: a JSON body or an SSE stream, by content-type. */
async function readReply(chunks: Buffer[], contentType: string, api: Api): Promise<NormalizedResponse> {
  if (/^application\/json/i.test(contentType)) {
    const j = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return api === 'anthropic' ? fromAnthropicJson(j) : fromJson(j)
  }
  const sse = jsonChunks({ body: (async function* () { yield* chunks })() }, LABEL[api], 'data:')
  return api === 'anthropic' ? collectAnthropic(sse) : collect(sse)
}

export async function startProxy(o: ProxyOpts): Promise<ProxyServer> {
  const up = new URL(o.upstream)
  const prefix = up.pathname.replace(/\/+$/, '')
  const log = o.log ?? (() => {})
  const cap = o.recordCap ?? 20e6
  const sessions = new Sessions({ now: Date.now, newId: () => randomUUID().slice(0, 8), harness: o.harness, upstream: o.upstream, pid: process.pid })
  const writers = new Map<string, { t: TraceWriter; chain: Promise<void> }>()
  const inflight = new Set<AbortController>()
  // The subset of inflight that stop() abandons *itself*: an ac already aborted by something else (the client
  // leaving) when stop() reaches it keeps that cause, since stop() is not what ended it.
  const stoppedByUs = new Set<AbortController>()
  const handlers = new Set<Promise<void>>()

  /** Appends in call order per run; the first call writes the meta line. A failure is logged, never thrown. */
  const record = (run: string, events: HarnessEvent[], meta?: RunMeta) => {
    let w = writers.get(run)
    if (!w) {
      // No file and no meta: an auxiliary request waiting for its session's first turn, nothing to write yet.
      if (!meta) return
      const t = new TraceWriter(o.runsDir, false, run)
      const { id: _id, ...rest } = meta
      w = { t, chain: t.open(rest) }
      writers.set(run, w)
    }
    const { t } = w
    w.chain = w.chain.then(() => t.append(...events)).catch(e => log(`recording run ${run}: ${(e as Error).message}`))
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    // The same rules as serve: a page the user visits must not reach the model through us (DNS rebinding, a
    // simple cross-site POST). Agents are not browsers and send no Origin.
    const no = refusal(req)
    if (no) return refuse(res, 403, no)
    // `//host/x` and absolute-form `http://host/x` would send the request somewhere other than the upstream.
    const p = req.url ?? ''
    if (!p.startsWith('/') || p.startsWith('//')) return refuse(res, 400, 'bad request path')
    const target = new URL(up.origin + prefix + p)
    if (target.origin !== up.origin) return refuse(res, 400, 'bad request path')
    const body = await readAll(req)

    let rec: { run: string; turn: number; api: Api; side?: { model: string } } | undefined
    const api = apiOf(req.method, target.pathname)
    const scrub = scrubberOf(req.headers)
    if (api) {
      let payload: unknown
      if (body.length > cap) log(`not recorded: a ${body.length}-byte request is over the ${cap}-byte cap`)
      else try { payload = JSON.parse(body.toString('utf8')) } catch { log('not recorded: the request body is not JSON') }
      if (payload && typeof payload === 'object') {
        // Only the hint headers, scrubbed like the body: Sessions never sees req.headers.
        const out = sessions.onRequest(scrub(payload), api, scrub(hintsOf(req.headers)))
        if (out.meta) log(`run ${out.run}: ${out.meta.task.slice(0, 80).replace(/\n/g, ' ')}`)
        record(out.run, out.events, out.meta)
        rec = { run: out.run, turn: out.turn, api, side: out.side }
      }
    }

    const t0 = Date.now()
    const ac = new AbortController()
    inflight.add(ac)
    const chunks: Buffer[] = []
    let status = 0, contentType = '', failure: string | undefined
    // Not req.on('close'): since Node 16 that fires once the request body has been read. A close after a failure
    // is our own res.destroy() below, not the agent leaving.
    let clientClosed = false
    // Named, not inline, so it can also be run right below: `res` may already have closed during
    // the `readAll(req)` await above, and a 'close' listener attached only now would never see an
    // event that already fired — `destroyed` is the state that event left behind, checked directly.
    const onResClose = () => { if (!res.writableFinished && failure === undefined) { clientClosed = true; ac.abort() } }
    res.on('close', onResClose)
    if (res.destroyed) onResClose()
    try {
      const upRes = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const r = (up.protocol === 'https:' ? https : http).request(target, {
          method: req.method, signal: ac.signal,
          headers: { ...headersWithout(req.headers, REQ_DROP), 'content-length': body.length },
        }, resolve)
        r.on('error', reject)
        r.end(body)
      })
      status = upRes.statusCode ?? 502
      contentType = String(upRes.headers['content-type'] ?? '')
      res.writeHead(status, headersWithout(upRes.headers, RES_DROP))
      for await (const c of upRes) {
        if (rec) chunks.push(c as Buffer)
        if (!res.write(c)) await drained(res)
      }
      if (!upRes.complete) throw new Error('the upstream closed the connection mid-reply')
      res.end()
    } catch (e) {
      failure = (e as Error).message
      if (!res.headersSent && !clientClosed) refuse(res, 502, `proxy: upstream ${up.origin}: ${failure}`)
      else res.destroy()
    } finally { inflight.delete(ac) }

    if (!rec) return
    // A cut Messages stream has no message_stop, which collectAnthropic refuses: its body is the text its deltas carried,
    // joined, never the raw SSE (a key echoed in pieces would pass the scrubber); nothing readable is no body.
    const partial = async () => rec.api === 'anthropic' ? deltaText(Buffer.concat(chunks).toString('utf8')) || undefined
      : (await readReply(chunks, contentType, rec.api).catch(() => undefined))?.content ?? ''
    let outcome: ReplyOutcome
    if (stoppedByUs.has(ac) && failure !== undefined) outcome = { ok: false, message: 'the proxy stopped before the reply ended', body: await partial() }
    else if (clientClosed) outcome = { ok: false, message: 'client closed the connection', body: await partial() }
    else if (failure !== undefined && !status) outcome = { ok: false, message: `${LABEL[rec.api]}: ${failure}` }
    else if (failure !== undefined) outcome = { ok: false, message: `${LABEL[rec.api]}: the upstream closed the connection mid-reply`, body: await partial() }
    else if (status < 200 || status > 299) outcome = { ok: false, message: `${LABEL[rec.api]}: ${status}`, body: Buffer.concat(chunks).toString('utf8') }
    else {
      try { outcome = { ok: true, res: await readReply(chunks, contentType, rec.api), latencyMs: Date.now() - t0 } }
      catch (e) {
        outcome = e instanceof BackendError ? { ok: false, message: e.message, body: e.body } : { ok: false, message: `could not read the reply: ${(e as Error).message}` }
      }
    }
    record(rec.run, sessions.onReply(rec.run, rec.turn, scrub(outcome), rec.side))
  }

  const server = http.createServer((req, res) => {
    const h = handle(req, res).catch(e => {
      log(`proxy: ${(e as Error).message}`)
      if (!res.headersSent) refuse(res, 500, 'proxy error'); else res.destroy()
    })
    handlers.add(h)
    void h.finally(() => handlers.delete(h))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })

  return {
    port: (server.address() as { port: number }).port,
    /** Aborts replies in flight, waits for them to be recorded, then ends every open run with done. */
    async stop() {
      for (const ac of inflight) { if (!ac.signal.aborted) stoppedByUs.add(ac); ac.abort() }
      server.closeAllConnections()
      await new Promise<void>(r => server.close(() => r()))
      await Promise.all(handlers)
      for (const { run, meta, events } of sessions.close()) record(run, events, meta)
      await Promise.all([...writers.values()].map(w => w.chain))
    },
  }
}
