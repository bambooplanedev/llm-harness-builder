import { test, expect, afterEach } from 'vitest'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startProxy, drained } from '../src/core/proxy/server.js'
import { normalizeRequest } from '../src/core/normalize.js'
import { tmp } from './helpers.js'
import { textReply, toolReply } from './fake-anthropic.js'

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
// Cyrillic "hi", by \u escape rather than the literal letters: a source-scan test forbids non-English text in
// tracked files, and this reply still needs a two-byte-per-letter word for the chunk boundary to split.
const HELLO = '\u041f\u0440\u0438\u0432\u0456\u0442'
const TOOL_REPLY = sseLines([
  { choices: [{ index: 0, delta: { role: 'assistant', content: HELLO }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 4 } },
])
const msgs = (base: string, body: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  fetch(`${base}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, ...init })
const ANT = JSON.stringify({ model: 'claude-haiku-5-5', stream: true, system: 'sys', messages: [{ role: 'user', content: 'do it' }] })
const post = (base: string, body: string, init: RequestInit = {}) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, ...init })

/** One raw request: node's http sends what fetch will not (a `//` path, absolute-form, a foreign Host). */
const raw = (port: number, path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode!, body: b })) })
  r.on('error', reject); r.end()
})

test('drained resolves immediately when the response is already destroyed, not just on a future close', async () => {
  const already = Object.assign(new EventEmitter(), { destroyed: true }) as unknown as http.ServerResponse
  const raced = await Promise.race([drained(already).then(() => 'resolved'), sleep(200).then(() => 'timed out')])
  expect(raced).toBe('resolved')
  // The ordinary case still works: not yet destroyed, resolves once 'close' fires.
  const later = Object.assign(new EventEmitter(), { destroyed: false }) as unknown as http.ServerResponse
  const p = drained(later).then(() => 'resolved')
  await sleep(10)
  ;(later as unknown as EventEmitter).emit('close')
  expect(await p).toBe('resolved')
})

test('forwards the reply byte for byte, split inside a UTF-8 letter, and records it without headers', async () => {
  const bytes = Buffer.from(TOOL_REPLY)
  const cut = bytes.indexOf(Buffer.from(HELLO)) + 1 // inside the first letter's two bytes
  const up = await upstream(async (_q, res) => {
    await sleep(100) // late headers: a normal request must not be aborted once its body has been read
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(bytes.subarray(0, cut)); await sleep(20)
    res.write(bytes.subarray(cut, cut + 50)); await sleep(20)
    res.end(bytes.subarray(cut + 50))
  })
  const px = await proxy(up.url)
  const r = await post(px.base, chat(), { headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token-123', 'accept-encoding': 'gzip', 'x-claude-code-session-id': 'sess-0001', 'x-claude-code-request-class': 'main' } })
  expect(r.status).toBe(200); expect(r.headers.get('content-type')).toBe('text/event-stream')
  expect(Buffer.from(await r.arrayBuffer()).equals(bytes)).toBe(true)
  expect(up.seen[0]).toMatchObject({ url: '/v1/chat/completions', body: chat() })
  expect(up.seen[0].headers.authorization).toBe('Bearer secret-token-123')
  expect(up.seen[0].headers['accept-encoding']).toBeUndefined()
  await px.stop()
  const [t] = await traces(px.runsDir)
  expect(t.meta).toMatchObject({ harness: 'test', task: 'do it', workdir: '', proxy: { upstream: up.url, pid: process.pid }, session: 'sess-0001', agent: 'main' })
  expect(t.events.map(e => e.type)).toEqual(['llm_request', 'llm_response', 'tool_call', 'done'])
  expect(t.events[1]).toMatchObject({ content: HELLO, usage: { promptTokens: 9, completionTokens: 4 } })
  expect(t.events[2].call).toMatchObject({ callId: 'c1', name: 'read_file', args: { path: 'a' }, backendId: 'call_1' })
  expect(t.events[3]).toMatchObject({ type: 'done', reason: 'proxy_stopped', turns: 1, toolCallCount: 1 })
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

test('a non-streamed JSON reply carrying only an error is recorded as an error, not an empty llm_response', async () => {
  const body = { error: { message: 'boom' } }
  const up = await upstream((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) })
  const px = await proxy(up.url)
  await (await post(px.base, chat(undefined, { stream: false }))).text()
  await px.stop()
  const [t] = await traces(px.runsDir)
  expect(t.events.map(e => e.type)).toEqual(['llm_request', 'error', 'done'])
  expect(t.events[1].message).toMatch(/boom/)
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

test('a stream that fails after 200 — finish_reason "error", OpenRouter\'s way — is recorded as an error, not an empty reply', async () => {
  const up = await upstream((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sseLines([
      { choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] },
      { error: { code: 429, message: 'Rate limit exceeded' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] },
    ]))
  })
  const px = await proxy(up.url)
  await (await post(px.base, chat())).text()
  await px.stop()
  const [t] = await traces(px.runsDir)
  expect(t.events.map(e => e.type)).toEqual(['llm_request', 'error', 'done'])
  expect(t.events[1]).toMatchObject({ message: 'POST /chat/completions: Rate limit exceeded' })
})

test('a page on another localhost port is another origin: refused; the proxy\'s own origin and no origin pass', async () => {
  const up = await upstream((_q, res) => res.end('upstream'))
  const px = await proxy(up.url)
  expect((await raw(px.p.port, '/props', { host: `localhost:${px.p.port}`, origin: 'http://localhost:5173' })).status).toBe(403)
  expect(await raw(px.p.port, '/props', { host: `localhost:${px.p.port}`, origin: `http://localhost:${px.p.port}` })).toEqual({ status: 200, body: 'upstream' })
  expect(await raw(px.p.port, '/props')).toEqual({ status: 200, body: 'upstream' })
  expect(up.seen).toHaveLength(2)
})

test('anthropic: the stream passes byte for byte; the trace has request, reply, call, and the result on the next request', async () => {
  const replies = [toolReply('Read', { file_path: 'a.txt' }), textReply('done')]
  const up = await upstream((_q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(replies.shift()) })
  const px = await proxy(up.url)
  const first = { model: 'claude-haiku-5-5', stream: true, system: [{ type: 'text', text: 'attr' }, { type: 'text', text: 'sys' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'do it' }] }] }
  const sent = toolReply('Read', { file_path: 'a.txt' })
  expect(await (await msgs(px.base, JSON.stringify(first))).text()).toBe(sent)
  expect(up.seen[0].url).toBe('/v1/messages?beta=true')
  const second = { ...first, messages: [...first.messages, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'AAA' }] }] }
  await (await msgs(px.base, JSON.stringify(second))).text()
  await px.stop()
  const [t] = await traces(px.runsDir)
  expect(t.events.map(e => e.type)).toEqual(['llm_request', 'llm_response', 'tool_call', 'tool_result', 'llm_request', 'llm_response', 'done'])
  expect(t.events[3]).toMatchObject({ callId: 'c1', output: 'AAA' })
  expect(normalizeRequest(t.events[0].payload)?.format).toBe('anthropic')
  expect(t.events[2].call).toMatchObject({ name: 'Read', args: { file_path: 'a.txt' }, backendId: 'toolu_1' })
  expect(t.events[1].usage).toMatchObject({ promptTokens: expect.any(Number), completionTokens: 5 })
})

test('anthropic: a JSON reply is recorded; a 200 JSON error is an error event', async () => {
  const bodies = [
    { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'plain' }, { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } }], stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 1 } },
    { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
  ]
  const up = await upstream((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(bodies.shift())) })
  const px = await proxy(up.url)
  await (await msgs(px.base, ANT)).text()
  await (await msgs(px.base, ANT)).text()
  await px.stop()
  const ts = await traces(px.runsDir)
  const events = ts.flatMap(t => t.events)
  expect(events.map(e => e.type)).toEqual(['llm_request', 'llm_response', 'tool_call', 'llm_request', 'error', 'done'])
  expect(events[1]).toMatchObject({ content: 'plain', usage: { promptTokens: 3, completionTokens: 1 } })
  expect(events[2].call).toMatchObject({ name: 'Bash', args: { command: 'ls' }, backendId: 'toolu_9' })
  expect(events[4].message).toMatch(/overloaded_error: busy/)
})

test('anthropic: a 4xx reply passes through and its body is the error body; labels name /v1/messages', async () => {
  const bad = '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}'
  const up = await upstream((_q, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(bad) })
  const px = await proxy(up.url)
  const r = await msgs(px.base, ANT)
  expect(r.status).toBe(400); expect(await r.text()).toBe(bad)
  await px.stop()
  const [t] = await traces(px.runsDir)
  expect(t.events.find(e => e.type === 'error')).toMatchObject({ message: 'POST /v1/messages: 400', body: bad })
})

test('anthropic: the upstream dying mid-stream, and the client leaving, are errors with what came', async () => {
  const sse = textReply('half text'), half = sse.slice(0, sse.indexOf('content_block_stop'))
  const up = await upstream((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(half); if (up.seen.length === 1) setTimeout(() => req.socket.destroy(), 20) })
  const px = await proxy(up.url)
  await expect((await msgs(px.base, ANT)).text()).rejects.toThrow()
  const ac = new AbortController()
  const r = await msgs(px.base, JSON.stringify({ ...JSON.parse(ANT), system: 'other' }), {}, { signal: ac.signal })
  await r.body!.getReader().read()
  ac.abort()
  await up.seen[1].closed
  await px.stop()
  const errors = (await traces(px.runsDir)).flatMap(t => t.events).filter(e => e.type === 'error')
  expect(errors.find(e => e.message === 'POST /v1/messages: the upstream closed the connection mid-reply')?.body).toContain('half text')
  expect(errors.find(e => e.message === 'client closed the connection')?.body).toContain('half text')
})

test('anthropic: a streamed event: error is recorded as an error event', async () => {
  const up = await upstream((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`)
  })
  const px = await proxy(up.url)
  await (await msgs(px.base, ANT)).text()
  await px.stop()
  const [t] = await traces(px.runsDir)
  expect(t.events.map(e => e.type)).toEqual(['llm_request', 'error', 'done'])
  expect(t.events[1].message + t.events[1].body).toMatch(/Overloaded/)
})

const KEY = 'sk-ant-test-' + 'k'.repeat(30), TOKEN = 'oauth-test-' + 't'.repeat(30)
/** Every file in runs/: none may contain the key or the token. */
async function noSecretOnDisk(runsDir: string) {
  for (const f of await readdir(runsDir)) {
    const s = await readFile(join(runsDir, f), 'utf8')
    expect([f, s.includes(KEY), s.includes(TOKEN)]).toEqual([f, false, false])
  }
}

test('anthropic: the key and the bearer token reach the upstream and nothing else: not runs/, not the log', async () => {
  let n = 0
  const up = await upstream((_q, res) => {
    if (n++ === 0) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return void res.end(textReply(`echo ${KEY}`)) }
    res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `bad ${TOKEN}` } }))
  })
  const px = await proxy(up.url)
  // Both headers on every request; both values in the user message, the first reply and the 401 body.
  const both = { 'x-api-key': KEY, authorization: `Bearer ${TOKEN}` }
  const body = (who: string) => JSON.stringify({ model: 'm', stream: true, system: 'sys', messages: [{ role: 'user', content: `${who} ${KEY} ${TOKEN}` }] })
  await (await msgs(px.base, body('a'), both)).text()
  expect((await msgs(px.base, body('b'), both)).status).toBe(401)
  expect(up.seen[0].headers['x-api-key']).toBe(KEY); expect(up.seen[1].headers.authorization).toBe(`Bearer ${TOKEN}`)
  // A hint header carrying the key itself: printable and short, so hintsOf keeps it, and only the scrubber stops it.
  await (await msgs(px.base, body('c'), { ...both, 'x-claude-code-session-id': 's-1', 'x-claude-code-agent-type': KEY })).text()
  await px.stop()
  await noSecretOnDisk(px.runsDir)
  expect(px.lines.length).toBeGreaterThan(0)
  expect(px.lines.join('\n')).not.toContain(KEY); expect(px.lines.join('\n')).not.toContain(TOKEN)
  const all = JSON.stringify(await traces(px.runsDir))
  expect(all).toContain('[redacted: x-api-key]'); expect(all).toContain('[redacted: authorization]')
})

test('anthropic: a subscription request (bearer + anthropic-beta) reaches the upstream unchanged', async () => {
  const up = await upstream((_q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(textReply('ok')) })
  const px = await proxy(up.url)
  const h = { authorization: `Bearer ${TOKEN}`, 'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219', 'anthropic-version': '2023-06-01' }
  await (await msgs(px.base, ANT, h)).text()
  expect(up.seen[0].headers).toMatchObject(h)
  await px.stop()
  expect(await traces(px.runsDir)).toHaveLength(1)
  await noSecretOnDisk(px.runsDir)
})

test('anthropic: count_tokens and other /v1 paths are forwarded and not recorded', async () => {
  const up = await upstream((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":12}') })
  const px = await proxy(up.url)
  const r = await fetch(`${px.base}/v1/messages/count_tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ANT })
  expect(await r.json()).toEqual({ input_tokens: 12 })
  expect(up.seen[0].url).toBe('/v1/messages/count_tokens')
  expect((await fetch(`${px.base}/v1/models`)).status).toBe(200)
  expect(up.seen[1]).toMatchObject({ method: 'GET', url: '/v1/models' })
  await px.stop()
  expect(await traces(px.runsDir)).toEqual([])
})

test('anthropic: a key split across two deltas of a cut stream reaches no file and no log line', async () => {
  const cut = KEY.length / 2
  const delta = (text: string) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`
  const sse = textReply('x'), head = sse.slice(0, sse.indexOf('event: ping'))
  const up = await upstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(head + delta(`echo ${KEY.slice(0, cut)}`) + delta(KEY.slice(cut)))
    setTimeout(() => req.socket.destroy(), 20)
  })
  const px = await proxy(up.url)
  await expect((await msgs(px.base, ANT, { 'x-api-key': KEY })).text()).rejects.toThrow()
  await px.stop()
  await noSecretOnDisk(px.runsDir)
  for (const f of await readdir(px.runsDir)) expect(await readFile(join(px.runsDir, f), 'utf8')).not.toContain(KEY.slice(cut)) // nor a piece of it
  expect(px.lines.join('\n')).not.toContain(KEY)
  const err = (await traces(px.runsDir))[0].events.find(e => e.type === 'error')
  expect(err).toMatchObject({ message: 'POST /v1/messages: the upstream closed the connection mid-reply', body: 'echo [redacted: x-api-key]' })
})

test('a lowercase bearer scheme is scrubbed, and so is a Bearer key on /chat/completions', async () => {
  const up = await upstream((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sseLines([{ choices: [{ index: 0, delta: { content: `echo ${KEY}` }, finish_reason: 'stop' }] }]))
  })
  const px = await proxy(up.url)
  await (await post(px.base, chat([{ role: 'user', content: `do ${KEY}` }]), { headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } })).text()
  await (await msgs(px.base, JSON.stringify({ ...JSON.parse(ANT), messages: [{ role: 'user', content: `do ${TOKEN}` }] }), { authorization: `bearer ${TOKEN}` })).text()
  expect(up.seen.map(s => s.headers.authorization)).toEqual([`Bearer ${KEY}`, `bearer ${TOKEN}`])
  await px.stop()
  await noSecretOnDisk(px.runsDir)
  expect(px.lines.join('\n')).not.toContain(KEY); expect(px.lines.join('\n')).not.toContain(TOKEN)
  expect(JSON.stringify(await traces(px.runsDir)).split('[redacted: authorization]').length - 1).toBeGreaterThanOrEqual(3)
})

test('anthropic: a title call before the first turn lands in the main run, whose task is the real one; a session of titles only is written at stop', async () => {
  const up = await upstream((_q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(textReply('ok')) })
  const px = await proxy(up.url)
  const cc = (s: string, cls: string) => ({ 'x-claude-code-session-id': s, 'x-claude-code-request-class': cls })
  const title = JSON.stringify({ model: 'claude-haiku-5-5', stream: true, system: 'sys', messages: [{ role: 'user', content: 'title?' }] })
  await (await msgs(px.base, title, cc('sess-a', 'auxiliary'))).text()
  await (await msgs(px.base, ANT, cc('sess-a', 'main'))).text()
  await (await msgs(px.base, title, cc('sess-b', 'auxiliary'))).text()
  await px.stop()
  const ts = await traces(px.runsDir)
  expect(ts.map(t => [t.meta.session, t.meta.task, t.events.map(e => e.type).join(' ')]).sort()).toEqual([
    ['sess-a', 'do it', 'proxy_note llm_request llm_response done'],
    ['sess-b', '', 'proxy_note done'],
  ])
  expect(ts.every(t => t.events.at(-1).reason === 'proxy_stopped')).toBe(true)
})
