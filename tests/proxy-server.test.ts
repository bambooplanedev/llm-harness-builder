import { test, expect, afterEach } from 'vitest'
import http from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startProxy } from '../src/core/proxy/server.js'
import { tmp } from './helpers.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cleanups: (() => unknown)[] = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

type Seen = { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string; closed: Promise<void> }
/** A stand-in upstream; `seen` records what reached it, `closed` resolves when its reply's connection goes away. */
async function upstream(h: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => unknown) {
  const seen: Seen[] = []
  const srv = http.createServer((req, res) => {
    let body = ''
    const closed = new Promise<void>(r => res.on('close', () => r()))
    req.on('data', c => (body += c))
    req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body, closed }); void h(req, res, body) })
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  cleanups.push(() => { srv.closeAllConnections(); srv.close() })
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, seen }
}

async function proxy(upstreamUrl: string, over: { recordCap?: number } = {}) {
  const runsDir = await tmp('lhb-proxy-runs-')
  const lines: string[] = []
  const p = await startProxy({ upstream: upstreamUrl, port: 0, runsDir, harness: 'test', log: l => lines.push(l), ...over })
  let stopped = false
  const stop = async () => { if (!stopped) { stopped = true; await p.stop() } }
  cleanups.push(stop)
  return { p, runsDir, lines, base: `http://127.0.0.1:${p.port}`, stop }
}

/** Every recorded run: its meta and events. Read after stop(), which waits for every append. */
async function traces(runsDir: string): Promise<{ meta: any; events: any[] }[]> {
  const files = (await readdir(runsDir).catch(() => [] as string[])).filter(f => f.endsWith('.jsonl')).sort()
  return Promise.all(files.map(async f => {
    const [m, ...events] = (await readFile(join(runsDir, f), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
    return { meta: m.meta, events }
  }))
}

const chat = (messages: object[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'do it' }], extra: object = {}) =>
  JSON.stringify({ model: 'm', stream: true, messages, ...extra })
const sseLines = (chunks: object[]) => chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
const HALF = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'half' }, finish_reason: null }] })}\n\n`
const TOOL_REPLY = sseLines([
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'Привіт' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 4 } },
])
const post = (base: string, body: string, init: RequestInit = {}) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, ...init })

/** One raw request: node's http sends what fetch will not (a `//` path, absolute-form, a foreign Host). */
const raw = (port: number, path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode!, body: b })) })
  r.on('error', reject); r.end()
})

test('forwards the reply byte for byte, split inside a UTF-8 letter, and records it without headers', async () => {
  const bytes = Buffer.from(TOOL_REPLY)
  const cut = bytes.indexOf(Buffer.from('Привіт')) + 1 // inside the first letter's two bytes
  const up = await upstream(async (_q, res) => {
    await sleep(100) // late headers: a normal request must not be aborted once its body has been read
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(bytes.subarray(0, cut)); await sleep(20)
    res.write(bytes.subarray(cut, cut + 50)); await sleep(20)
    res.end(bytes.subarray(cut + 50))
  })
  const px = await proxy(up.url)
  const r = await post(px.base, chat(), { headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token-123', 'accept-encoding': 'gzip' } })
  expect(r.status).toBe(200); expect(r.headers.get('content-type')).toBe('text/event-stream')
  expect(Buffer.from(await r.arrayBuffer()).equals(bytes)).toBe(true)
  expect(up.seen[0]).toMatchObject({ url: '/v1/chat/completions', body: chat() })
  expect(up.seen[0].headers.authorization).toBe('Bearer secret-token-123')
  expect(up.seen[0].headers['accept-encoding']).toBeUndefined()
  await px.stop()
  const [t] = await traces(px.runsDir)
  expect(t.meta).toMatchObject({ harness: 'test', task: 'do it', workdir: '', proxy: { upstream: up.url, pid: process.pid } })
  expect(t.events.map(e => e.type)).toEqual(['llm_request', 'llm_response', 'tool_call', 'done'])
  expect(t.events[1]).toMatchObject({ content: 'Привіт', usage: { promptTokens: 9, completionTokens: 4 } })
  expect(t.events[2].call).toMatchObject({ callId: 'c1', name: 'read_file', args: { path: 'a' }, backendId: 'call_1' })
  expect(t.events[3]).toMatchObject({ type: 'done', reason: 'aborted', turns: 1, toolCallCount: 1 })
  expect(await readFile(join(px.runsDir, `${t.meta.id}.jsonl`), 'utf8')).not.toContain('secret-token-123')
  expect(px.lines).toContain(`run ${t.meta.id}: do it`)
})

test('other paths pass through unrecorded; a chunked request body arrives whole', async () => {
  const up = await upstream((req, res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ url: req.url, body, len: req.headers['content-length'] })) })
  const px = await proxy(up.url)
  expect(JSON.parse((await raw(px.p.port, '/props?model=x')).body)).toMatchObject({ url: '/props?model=x', body: '' })
  const chunked = await new Promise<string>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: px.p.port, path: '/tokenize', method: 'POST', headers: { 'content-type': 'application/json' } },
      res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve(b)) })
    r.on('error', reject); r.write('{"content":'); r.end('"hi"}')
  })
  expect(JSON.parse(chunked)).toEqual({ url: '/tokenize', body: '{"content":"hi"}', len: '16' })
  await px.stop()
  expect(await traces(px.runsDir)).toEqual([])
})

test('an unreachable upstream: 502 to the agent, an error in the trace', async () => {
  const px = await proxy('http://127.0.0.1:1')
  const r = await post(px.base, chat())
  expect(r.status).toBe(502); expect((await r.json()).error.message).toMatch(/ECONNREFUSED/)
  await px.stop()
  const [t] = await traces(px.runsDir)
  expect(t.events.map(e => e.type)).toEqual(['llm_request', 'error', 'done'])
  expect(t.events[1].message).toMatch(/^POST \/chat\/completions: .*ECONNREFUSED/)
})

test('a non-2xx reply passes through; an error chunk inside a 2xx stream keeps its native wording', async () => {
  let n = 0
  const up = await upstream((_q, res) => {
    if (n++ === 0) { res.writeHead(400, { 'content-type': 'application/json' }); return void res.end('{"error":"tools need --jinja"}') }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ error: { message: 'context shift is disabled', code: 400 } })}\n\n`)
  })
  const px = await proxy(up.url)
  const a = await post(px.base, chat())
  expect(a.status).toBe(400); expect(await a.text()).toBe('{"error":"tools need --jinja"}')
  await (await post(px.base, chat())).text()
  await px.stop()
  const [t] = await traces(px.runsDir)
  const errors = t.events.filter(e => e.type === 'error')
  expect(errors[0]).toMatchObject({ turn: 1, message: 'POST /chat/completions: 400', body: '{"error":"tools need --jinja"}' })
  expect(errors[1].turn).toBe(2); expect(errors[1].message + errors[1].body).toMatch(/context shift is disabled/)
})

test('a non-streamed JSON reply is recorded', async () => {
  const body = { choices: [{ index: 0, message: { role: 'assistant', content: 'plain' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }
  const up = await upstream((_q, res) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) })
  const px = await proxy(up.url)
  expect(await (await post(px.base, chat(undefined, { stream: false }))).json()).toEqual(body)
  await px.stop()
  const [t] = await traces(px.runsDir)
  expect(t.events[1]).toMatchObject({ type: 'llm_response', content: 'plain', raw: body, usage: { promptTokens: 3, completionTokens: 1 } })
})

test('an agent that leaves mid-reply aborts the upstream request', async () => {
  const up = await upstream((_q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(HALF) })
  const px = await proxy(up.url)
  const ac = new AbortController()
  const r = await post(px.base, chat(), { signal: ac.signal })
  await r.body!.getReader().read() // the first piece has arrived
  ac.abort()
  await up.seen[0].closed // the upstream saw its request go away
  await px.stop()
  const [t] = await traces(px.runsDir)
  expect(t.events.find(e => e.type === 'error')).toMatchObject({ message: 'client closed the connection', body: 'half' })
  expect(t.events.some(e => e.type === 'llm_response')).toBe(false)
})

test('the upstream dying mid-reply: the agent sees the cut, the trace an error with what came', async () => {
  const up = await upstream((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(HALF); setTimeout(() => req.socket.destroy(), 20) })
  const px = await proxy(up.url)
  const r = await post(px.base, chat())
  await expect(r.text()).rejects.toThrow()
  expect((await raw(px.p.port, '//x')).status).toBe(400) // the proxy is still up (answered by the proxy itself, not the dead upstream)
  await px.stop()
  const [t] = await traces(px.runsDir)
  expect(t.events.find(e => e.type === 'error')).toMatchObject({ message: 'POST /chat/completions: the upstream closed the connection mid-reply', body: 'half' })
})

test('stopping with a reply in flight records it before done, and returns', async () => {
  const up = await upstream((_q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(HALF) })
  const px = await proxy(up.url)
  const r = await post(px.base, chat())
  await r.body!.getReader().read()
  await px.stop()
  const [t] = await traces(px.runsDir)
  expect(t.events.map(e => e.type)).toEqual(['llm_request', 'error', 'done'])
  expect(t.events[1]).toMatchObject({ message: 'the proxy stopped before the reply ended', body: 'half' })
})

test('two sessions at once: two files, each in seq order and alone', async () => {
  const up = await upstream(async (_q, res, body) => {
    const who = JSON.parse(body).messages[1].content
    await sleep(who === 'A' ? 60 : 0)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sseLines([{ choices: [{ index: 0, delta: { content: `ok ${who}` }, finish_reason: 'stop' }] }]))
  })
  const px = await proxy(up.url)
  const session = async (who: string) => {
    const first = [{ role: 'system', content: 's' }, { role: 'user', content: who }]
    await (await post(px.base, chat(first))).text()
    await (await post(px.base, chat([...first, { role: 'assistant', content: `ok ${who}` }, { role: 'user', content: 'more' }]))).text()
  }
  await Promise.all([session('A'), session('B')])
  await px.stop()
  const ts = await traces(px.runsDir)
  expect(ts.map(t => t.meta.task).sort()).toEqual(['A', 'B'])
  for (const t of ts) {
    expect(t.events.map(e => e.type)).toEqual(['llm_request', 'llm_response', 'llm_request', 'llm_response', 'done'])
    expect(t.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4])
    expect(t.events.filter(e => e.type === 'llm_response').map(e => e.content)).toEqual([`ok ${t.meta.task}`, `ok ${t.meta.task}`])
  }
})

test('refuses a // path, absolute-form, a foreign Host and a foreign Origin', async () => {
  const up = await upstream((_q, res) => res.end('upstream'))
  const px = await proxy(up.url)
  expect((await raw(px.p.port, '//evil.example/x')).status).toBe(400)
  expect((await raw(px.p.port, 'http://10.0.0.1/admin')).status).toBe(400)
  expect((await raw(px.p.port, '/props', { host: 'evil.example' })).status).toBe(403)
  expect((await raw(px.p.port, '/props', { origin: 'http://evil.example' })).status).toBe(403)
  expect(await raw(px.p.port, '/props', { host: 'localhost:1234' })).toEqual({ status: 200, body: 'upstream' })
  expect(up.seen).toHaveLength(1)
})

test('a body over the cap, or not JSON, is forwarded and not recorded', async () => {
  const up = await upstream((_q, res, body) => res.end(String(Buffer.byteLength(body))))
  const px = await proxy(up.url, { recordCap: 100 })
  const big = chat([{ role: 'user', content: 'x'.repeat(200) }])
  expect(await (await post(px.base, big)).text()).toBe(String(Buffer.byteLength(big)))
  expect(await (await post(px.base, 'not json')).text()).toBe('8')
  await px.stop()
  expect(await traces(px.runsDir)).toEqual([])
  expect(px.lines.join('\n')).toMatch(/over the 100-byte cap/)
  expect(px.lines.join('\n')).toMatch(/not JSON/)
})
