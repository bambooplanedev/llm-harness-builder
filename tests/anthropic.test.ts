import { test, expect } from 'vitest'
import { AnthropicBackend, collectAnthropic, fromAnthropicJson } from '../src/core/backends/anthropic.js'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { BackendError, defaultFetch, jsonChunks, type ChatRequest, type Delta, type FetchLike } from '../src/core/backends/types.js'

const backend = new AnthropicBackend('https://api.anthropic.com', (async () => { throw new Error('no network') }) as unknown as FetchLike, 'k', 'ANTHROPIC_API_KEY')
const base: ChatRequest = { model: 'claude-haiku-5-5', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], maxTokens: 1000 }
const body = (r: Partial<ChatRequest> = {}) => backend.buildPayload({ ...base, ...r }) as any

test('buildPayload: system on top, no temperature, max_tokens, stream, cache', () => {
  const p = body({ temperature: 0.2 })
  expect(p.system).toBe('s')
  expect(p.messages).toEqual([{ role: 'user', content: 'u' }])
  expect('temperature' in p).toBe(false)
  expect(p).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 1000, stream: true, cache_control: { type: 'ephemeral' } })
})

test('buildPayload: thinking adaptive unless think is false', () => {
  for (const think of [true, undefined]) {
    const t = body({ think }).thinking
    expect(t).toEqual({ type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } })
  }
  expect(body({ think: false }).thinking).toEqual({ type: 'disabled' })
})

test('buildPayload: an assistant with native goes back verbatim', () => {
  const native = [{ type: 'thinking', thinking: 't', signature: 'sig' }, { type: 'text', text: 'x' }, { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } }]
  const p = body({ messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'x', native }] })
  expect(p.messages[1]).toEqual({ role: 'assistant', content: native })
})

test('buildPayload: an empty assistant gets a marker; calls become tool_use', () => {
  const empty = body({ messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: '' }, { role: 'user', content: 'again' }] })
  expect(empty.messages[1].content).toEqual([{ type: 'text', text: '(empty reply)' }])
  const calls = body({ messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'ok', toolCalls: [{ backendId: 'tu_1', name: 'bash', args: { command: 'ls' } }] }] })
  expect(calls.messages[1].content).toEqual([{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } }])
})

test('buildPayload: consecutive tool results become one user message, in order', () => {
  const tool = (id: string, isError?: boolean) => ({ role: 'tool' as const, content: id, toolCallId: id, name: 'bash', isToolResult: true as const, ...(isError ? { isError } : {}) })
  const p = body({ messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: '' }, tool('a'), tool('b', true), tool('c')] })
  expect(p.messages).toHaveLength(3)
  expect(p.messages[2]).toEqual({ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'a', content: 'a' },
    { type: 'tool_result', tool_use_id: 'b', content: 'b', is_error: true },
    { type: 'tool_result', tool_use_id: 'c', content: 'c' },
  ] })
})

test('buildPayload: tools and responseSchema', () => {
  const schema = { type: 'object', properties: {}, additionalProperties: false }
  const p = body({ tools: [{ name: 'bash', description: 'd', parameters: schema }], responseSchema: schema })
  expect(p.tools).toEqual([{ name: 'bash', description: 'd', input_schema: schema }])
  expect(p.output_config).toEqual({ format: { type: 'json_schema', schema } })
})

// --- the stream ---
const sse = (events: unknown[]) => events.map(e => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const start = (usage: object = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, extra: object = {}) =>
  ({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage, ...extra } })
const end = (stop_reason = 'end_turn', output_tokens = 5, delta: object = {}) =>
  [{ type: 'message_delta', delta: { stop_reason, ...delta }, usage: { output_tokens } }, { type: 'message_stop' }]
const block = (index: number, content_block: object, deltas: object[]) => [
  { type: 'content_block_start', index, content_block },
  ...deltas.map(delta => ({ type: 'content_block_delta', index, delta })),
  { type: 'content_block_stop', index },
]
const read = (events: unknown[], onDelta?: (d: Delta) => void) =>
  collectAnthropic(jsonChunks(new Response(sse(events)), 'POST /v1/messages', 'data:'), onDelta)

test('collectAnthropic: text with a ping inside, streamed through onDelta', async () => {
  const deltas: Delta[] = []
  const r = await read([start(), { type: 'ping' }, ...block(0, { type: 'text', text: '' }, [{ type: 'text_delta', text: 'Hel' }, { type: 'text_delta', text: 'lo' }]), { type: 'ping' }, ...end()], d => deltas.push(d))
  expect(r.content).toBe('Hello')
  expect(deltas).toEqual([{ content: 'Hel' }, { content: 'lo' }])
  expect(r.native).toEqual([{ type: 'text', text: 'Hello' }])
  expect(r.toolCalls).toEqual([])
})

test('collectAnthropic: thinking with its signature; redacted thinking from the block start', async () => {
  const r = await read([start(),
    ...block(0, { type: 'thinking', thinking: '', signature: '' }, [{ type: 'thinking_delta', thinking: 'hmm' }, { type: 'signature_delta', signature: 'SIG' }]),
    ...block(1, { type: 'redacted_thinking', data: 'ENC' }, []),
    ...end()])
  expect(r.reasoning).toBe('hmm')
  expect(r.native).toEqual([{ type: 'thinking', thinking: 'hmm', signature: 'SIG' }, { type: 'redacted_thinking', data: 'ENC' }])
})

test('collectAnthropic: thinking, tool_use, thinking, tool_use keep their order; calls have no holes', async () => {
  const r = await read([start(),
    ...block(0, { type: 'thinking', thinking: '', signature: '' }, [{ type: 'thinking_delta', thinking: 'a' }, { type: 'signature_delta', signature: 's1' }]),
    ...block(1, { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }, [{ type: 'input_json_delta', partial_json: '{"command":' }, { type: 'input_json_delta', partial_json: '"ls"}' }]),
    ...block(2, { type: 'thinking', thinking: '', signature: '' }, [{ type: 'thinking_delta', thinking: 'b' }, { type: 'signature_delta', signature: 's2' }]),
    ...block(3, { type: 'tool_use', id: 'tu_2', name: 'list', input: {} }, []),
    ...end('tool_use')])
  expect(r.native!.map((b: any) => b.type)).toEqual(['thinking', 'tool_use', 'thinking', 'tool_use'])
  expect(r.native![1]).toEqual({ type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } })
  expect(r.toolCalls).toEqual([{ backendId: 'tu_1', name: 'bash', args: { command: 'ls' } }, { backendId: 'tu_2', name: 'list', args: {} }])
})

test('collectAnthropic: arguments that are not JSON become argsError', async () => {
  const r = await read([start(), ...block(0, { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }, [{ type: 'input_json_delta', partial_json: '{"command"' }]), ...end('tool_use')])
  expect(r.toolCalls[0]).toMatchObject({ backendId: 'tu_1', name: 'bash', args: {} })
  expect(r.toolCalls[0].argsError).toMatch(/\{"command"/)
})

test('collectAnthropic: usage is the whole prompt, the cache parts and the output', async () => {
  const r = await read([start({ input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 1 }), ...block(0, { type: 'text', text: '' }, [{ type: 'text_delta', text: 'x' }]), ...end('end_turn', 42)])
  expect(r.usage).toEqual({ promptTokens: 240, completionTokens: 42, cacheReadTokens: 200, cacheWriteTokens: 30 })
})

test('collectAnthropic: no usage in either event is no usage, not zero', async () => {
  const r = await read([{ type: 'message_start', message: { id: 'm', role: 'assistant', model: 'x' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }])
  expect(r.usage).toBeUndefined()
})

test('collectAnthropic: max_tokens is truncated; pause_turn is not', async () => {
  const text = block(0, { type: 'text', text: '' }, [{ type: 'text_delta', text: 'x' }])
  expect((await read([start(), ...text, ...end('max_tokens')])).truncated).toBe(true)
  expect((await read([start(), ...text, ...end('pause_turn')])).truncated).toBeUndefined()
})

test('collectAnthropic: a refusal is a BackendError with its category', async () => {
  const p = read([start(), ...end('refusal', 0, { stop_details: { type: 'refusal', category: 'cyber' } })])
  await expect(p).rejects.toBeInstanceOf(BackendError)
  await expect(read([start(), ...end('refusal', 0, { stop_details: { category: 'cyber' } })])).rejects.toThrow('refused: cyber')
  await expect(read([start(), ...end('refusal', 0, { stop_details: { category: 'x'.repeat(500) } })])).rejects.toThrow(/^refused: x{100}$/)
  await expect(read([start(), ...end('refusal', 0, { stop_details: { category: { a: 1 } } })])).rejects.toThrow(/^refused$/)
})

test('collectAnthropic: an error event mid-stream is a BackendError with its message', async () => {
  const p = read([start(), ...block(0, { type: 'text', text: '' }, [{ type: 'text_delta', text: 'x' }]), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])
  await expect(p).rejects.toThrow(BackendError)
  await expect(read([start(), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])).rejects.toThrow('Overloaded')
})

test('collectAnthropic: a body that ends before message_stop is a BackendError', async () => {
  const p = read([start(), ...block(0, { type: 'text', text: '' }, [{ type: 'text_delta', text: 'x' }])])
  await expect(p).rejects.toThrow(new BackendError('POST /v1/messages: stream ended before message_stop'))
})

test('collectAnthropic: an index that is not a small integer is ignored on every event', async () => {
  const bad = ['__proto__', 1e9, -1, 1.5, 'constructor']
  const junk = bad.flatMap(index => [
    { type: 'content_block_start', index, content_block: { type: 'text', text: 'evil', polluted: true } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text: 'evil' } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"polluted":1}' } },
    { type: 'content_block_stop', index },
  ])
  junk.push({ type: 'content_block_start', content_block: { type: 'text', text: '' } } as any, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'no index' } } as any)
  const r = await read([start(), ...junk, ...block(0, { type: 'text', text: '' }, [{ type: 'text_delta', text: 'ok' }]), ...end()])
  expect(r.content).toBe('ok')
  expect(r.native).toEqual([{ type: 'text', text: 'ok' }])
  expect(({} as any).polluted).toBeUndefined()
  expect(({} as any).text).toBeUndefined()
})

test('collectAnthropic: raw is the reply as one message, input_transformations included', async () => {
  const r = await read([start(undefined, { input_transformations: [{ type: 'x' }] }), ...block(0, { type: 'text', text: '' }, [{ type: 'text_delta', text: 'hi' }]), ...end()])
  expect(r.raw).toEqual({
    id: 'msg_1', model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn',
    usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 },
    input_transformations: [{ type: 'x' }],
  })
})

test('buildPayload: an empty native takes the marker; blank text with calls is the calls alone', () => {
  const p = body({ messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: '', native: [] }, { role: 'user', content: 'again' }] })
  expect(p.messages[1].content).toEqual([{ type: 'text', text: '(empty reply)' }])
  const calls = body({ messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: '  ', toolCalls: [{ backendId: 'tu_1', name: 'bash', args: {} }] }] })
  expect(calls.messages[1].content).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }])
})

test('collectAnthropic: a text block that got no deltas is left out of native', async () => {
  const r = await read([start(), ...block(0, { type: 'text', text: '' }, []), ...block(1, { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }, []), ...end('tool_use')])
  expect(r.native).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }])
})

// --- the network ---
type Sent = { url: string; init: any }
/** A fetch that records every request and answers each with `answer(url)`. */
const recording = (answer: (url: string) => Response) => {
  const sent: Sent[] = []
  const fetchFn = (async (url: string, init: any) => { sent.push({ url, init }); return answer(url) }) as unknown as FetchLike
  return { sent, net: new AnthropicBackend('https://api.anthropic.com/', fetchFn, 'sk-ant-test', 'ANTHROPIC_API_KEY') }
}
const ok = (events: unknown[]) => new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } })
const failure = (status: number, type: string, message: string) => new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status })

test('send: x-api-key and anthropic-version on the request, no authorization; the beta only with adaptive thinking', async () => {
  const { sent, net } = recording(() => ok([start(), ...block(0, { type: 'text', text: '' }, [{ type: 'text_delta', text: 'hi' }]), ...end()]))
  expect((await net.send(body())).content).toBe('hi')
  await net.send(body({ think: false }))
  expect(sent.map(s => s.url)).toEqual(['https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/messages'])
  for (const s of sent) {
    expect(s.init).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2026-10-21', 'content-type': 'application/json' } })
    expect('authorization' in s.init.headers).toBe(false)
  }
  expect(sent[0].init.headers['anthropic-beta']).toBe('thinking-binding-controls-2026-08-01')
  expect('anthropic-beta' in sent[1].init.headers).toBe(false)
})

test('send: a non-2xx is a BackendError with the status and the error type, the body kept; a 401 names the variable', async () => {
  const cases: [number, string, string, string][] = [
    [401, 'authentication_error', 'invalid x-api-key', 'POST /v1/messages: 401 (the key in ANTHROPIC_API_KEY was refused)'],
    [429, 'rate_limit_error', 'slow down', 'POST /v1/messages: 429 rate_limit_error: slow down'],
    [529, 'overloaded_error', 'Overloaded', 'POST /v1/messages: 529 overloaded_error: Overloaded'],
    [400, 'invalid_request_error', 'max_tokens: Field required', 'POST /v1/messages: 400 invalid_request_error: max_tokens: Field required'],
  ]
  for (const [status, type, message, words] of cases) {
    const { net } = recording(() => failure(status, type, message))
    const e = await net.send(body()).catch(e => e)
    expect(e).toBeInstanceOf(BackendError)
    expect(e.message).toBe(words)
    expect(e.body).toContain(message)
  }
  const { net } = recording(() => new Response('<html>bad gateway</html>', { status: 502 }))
  expect((await net.send(body()).catch(e => e)).message).toBe('POST /v1/messages: 502')
})

test('listModels: one page of 1000, keyed; has_more makes the list partial', async () => {
  const { sent, net } = recording(() => Response.json({ data: [{ id: 'claude-haiku-5-5' }, { id: 'claude-opus-5-5' }], has_more: true, last_id: 'claude-opus-5-5' }))
  expect(await net.listModels()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
  expect(net.partialList).toBe(true)
  expect(sent[0].url).toBe('https://api.anthropic.com/v1/models?limit=1000')
  expect(sent[0].init).toMatchObject({ redirect: 'manual', headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2026-10-21' } })
  const full = recording(() => Response.json({ data: [{ id: 'a' }], has_more: false }))
  await full.net.listModels()
  expect(full.net.partialList).toBe(false)
  const refused = recording(() => failure(401, 'authentication_error', 'no'))
  expect((await refused.net.listModels().catch(e => e)).message).toBe('GET /v1/models: 401 (the key in ANTHROPIC_API_KEY was refused)')
})

test('serverInfo: the window and the output cap of one model, keyed; any failure is undefined', async () => {
  const { sent, net } = recording(() => Response.json({ id: 'claude-haiku-5-5', max_input_tokens: 200000, max_tokens: 64000 }))
  expect(await net.serverInfo('claude-haiku-5-5')).toEqual({ nCtx: 200000, maxOutput: 64000, takes: { temperature: false }, takesFrom: 'Anthropic API 2026-10-21', router: false })
  expect(sent[0].url).toBe('https://api.anthropic.com/v1/models/claude-haiku-5-5')
  expect(sent[0].init).toMatchObject({ redirect: 'manual', headers: { 'x-api-key': 'sk-ant-test' } })
  await net.serverInfo('a/b?c')
  expect(sent[1].url).toBe('https://api.anthropic.com/v1/models/a%2Fb%3Fc')
  expect(await recording(() => failure(404, 'not_found_error', 'no')).net.serverInfo('x')).toBeUndefined()
  expect(await recording(() => new Response('not json')).net.serverInfo('x')).toBeUndefined()
  expect(await recording(() => { throw new Error('fetch failed') }).net.serverInfo('x')).toBeUndefined()
  // counts that are not counts are left out, not passed on
  expect(await recording(() => Response.json({ max_input_tokens: '9', max_tokens: -1 })).net.serverInfo('x')).toEqual({ takes: { temperature: false }, takesFrom: 'Anthropic API 2026-10-21', router: false })
})

test('serverInfo: no model takes a temperature; one without structured outputs takes no response schema', async () => {
  const info = await recording(() => Response.json({ id: 'x', capabilities: { structured_outputs: { supported: false } } })).net.serverInfo('x')
  expect(info?.takes).toEqual({ temperature: false, responseSchema: false })
  const yes = await recording(() => Response.json({ id: 'x', capabilities: { structured_outputs: { supported: true } } })).net.serverInfo('x')
  expect(yes?.takes).toEqual({ temperature: false })
})

test('a 307 from any keyed request is not followed: no second address is asked', async () => {
  const hits: string[] = []
  const srv = http.createServer((req, res) => { hits.push(req.url ?? ''); res.writeHead(307, { location: '/elsewhere' }); res.end() })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  try {
    const net = new AnthropicBackend(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, defaultFetch, 'sk-ant-test', 'ANTHROPIC_API_KEY')
    const e = await net.send(body()).catch(e => e)
    expect(e.message).toBe('POST /v1/messages: 307 (redirect not followed: with a key, requests go only to baseUrl)')
    await expect(net.listModels()).rejects.toThrow('GET /v1/models: 307')
    expect(await net.serverInfo('claude-haiku-5-5')).toBeUndefined()
    expect(hits).toEqual(['/v1/messages', '/v1/models?limit=1000', '/v1/models/claude-haiku-5-5'])
  } finally { await new Promise<void>(r => { srv.closeAllConnections(); srv.close(() => r()) }) }
})

test('fromAnthropicJson: an error body without type or message reads "error", not "undefined: undefined"', async () => {
  await expect(async () => fromAnthropicJson({ type: 'error', error: {} })).rejects.toThrow(/^POST \/v1\/messages: error$/)
  await expect(async () => fromAnthropicJson({ type: 'error', error: { message: 'busy' } })).rejects.toThrow(/^POST \/v1\/messages: busy$/)
})
