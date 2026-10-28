import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { OpenAIBackend, collect, fromJson } from '../src/core/backends/openai.js'
import { OllamaBackend } from '../src/core/backends/ollama.js'
import { AnthropicBackend } from '../src/core/backends/anthropic.js'
import { BackendError, defaultFetch, jsonChunks, type ChatRequest, type Delta, type FetchLike } from '../src/core/backends/types.js'
import { createBackend } from '../src/core/backends/index.js'

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'))
const fakeFetch = (status: number, body: unknown) => (async (_url: string, init?: RequestInit) => {
  ;(fakeFetch as any).last = { url: _url, init }
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}) as unknown as typeof fetch

const sseBody = (chunks: unknown[]) => chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
const ndjsonBody = (chunks: unknown[]) => chunks.map(c => JSON.stringify(c) + '\n').join('')
const fakeStream = (status: number, text: string) => (async () => new Response(text, { status, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch
const openai = (chunks: unknown[] = fx('openai-tool-call')) => new OpenAIBackend('http://x/v1', fakeStream(200, sseBody(chunks)))
const ollama = (chunks: unknown[] = fx('ollama-tool-call')) => new OllamaBackend('http://x', fakeStream(200, ndjsonBody(chunks)))

const req: ChatRequest = {
  model: 'm', temperature: 0.1, numCtx: 8192,
  messages: [
    { role: 'system', content: 's' }, { role: 'user', content: 'u' },
    { role: 'assistant', content: '', toolCalls: [{ backendId: 'call_1', name: 'bash', args: { command: 'ls' } }] },
    { role: 'tool', content: 'a.txt', toolCallId: 'call_1', name: 'bash', isToolResult: true },
  ],
  tools: [{ name: 'bash', description: 'd', parameters: { type: 'object', properties: {}, required: [] } }],
  responseSchema: { type: 'object' },
}

test('openai payload shape', () => {
  const p = new OpenAIBackend('http://x/v1').buildPayload(req) as any
  expect(p.stream).toBe(true); expect(p.stream_options).toEqual({ include_usage: true })
  expect(p.tools[0]).toEqual({ type: 'function', function: { name: 'bash', description: 'd', parameters: req.tools![0].parameters } })
  expect(p.messages[2].tool_calls[0]).toEqual({ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } })
  expect(p.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'a.txt' })
  expect(p.response_format.type).toBe('json_schema')
  expect(p).not.toHaveProperty('options')
})

test('ollama payload shape', () => {
  const p = new OllamaBackend('http://x').buildPayload(req) as any
  expect(p.stream).toBe(true)
  expect(p.options).toEqual({ temperature: 0.1, num_ctx: 8192 })
  expect(p.messages[2].tool_calls[0]).toEqual({ function: { name: 'bash', arguments: { command: 'ls' } } })
  expect(p.messages[3]).toEqual({ role: 'tool', tool_name: 'bash', content: 'a.txt' })
  expect(p.format).toEqual({ type: 'object' })
})

test('both normalize to the same response, streaming reasoning deltas first', async () => {
  const deltas: Record<string, Delta[]> = { a: [], b: [] }
  const a = await openai().send({}, undefined, d => deltas.a.push(d))
  const b = await ollama().send({}, undefined, d => deltas.b.push(d))
  for (const r of [a, b]) {
    expect(r.content).toBe('')
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].name).toBe('read_file')
    expect(r.toolCalls[0].args).toEqual({ path: 'src/slugify.js' })
    expect(r.reasoning).toBeTruthy()
    expect(r.usage!.promptTokens).toBeGreaterThan(500)
    expect(r.truncated).toBeFalsy()
  }
  expect(a.toolCalls[0].backendId).toBe('call_9f2a')
  expect(b.toolCalls[0].backendId).toBeUndefined()
  for (const k of ['a', 'b'] as const) {
    expect(deltas[k].map(d => d.reasoning).join('')).toBe(k === 'a' ? a.reasoning : b.reasoning)
    expect(deltas[k].every(d => d.content === undefined)).toBe(true)
  }
  expect((a.raw as any).choices[0].message.tool_calls[0].function.arguments).toBe('{"path":"src/slugify.js"}')
  expect((a.raw as any).usage.prompt_tokens).toBe(612)
  expect((b.raw as any).message.tool_calls).toHaveLength(1)
  expect((b.raw as any).done_reason).toBe('stop')
})

test('openai invalid arguments json sets argsError', async () => {
  const chunks = fx('openai-tool-call'); const args = ['{oops', '', '']
  for (const c of chunks) for (const tc of c.choices[0]?.delta?.tool_calls ?? []) tc.function.arguments = args.shift()
  const r = await openai(chunks).send({})
  expect(r.toolCalls[0].argsError).toBeTruthy(); expect(r.toolCalls[0].args).toEqual({})
})

test('non-2xx throws BackendError with body', async () => {
  await expect(new OpenAIBackend('http://x/v1', fakeFetch(400, { error: 'tools not supported without --jinja' })).send({}))
    .rejects.toSatisfy((e: unknown) => e instanceof BackendError && /jinja/.test(e.body!))
})

test('2xx with a non-stream body throws BackendError', async () => {
  const html = fakeStream(200, '<html>proxy</html>')
  await expect(new OpenAIBackend('http://x/v1', html).send({})).rejects.toSatisfy((e: unknown) => e instanceof BackendError && /not an event stream/.test(e.message) && /proxy/.test(e.body!))
  await expect(new OllamaBackend('http://x', html).send({})).rejects.toBeInstanceOf(BackendError)
})

test('an error chunk inside a 2xx stream throws BackendError', async () => {
  await expect(openai([{ error: { message: 'context shift is disabled', code: 400 } }]).send({})).rejects.toSatisfy((e: unknown) => e instanceof BackendError && /context shift/.test(e.message + e.body))
  await expect(ollama([{ error: 'model runner has unexpectedly stopped' }]).send({})).rejects.toSatisfy((e: unknown) => e instanceof BackendError && /runner/.test(e.message + e.body))
})

test('a stream that ends before [DONE] yields what was collected, not truncated', async () => {
  const chunks = fx('openai-tool-call').slice(0, 2)
  const r = await new OpenAIBackend('http://x/v1', fakeStream(200, chunks.map((c: unknown) => `data: ${JSON.stringify(c)}\n\n`).join(''))).send({})
  expect(r.reasoning).toBe('I should read the file first.'); expect(r.truncated).toBeFalsy(); expect(r.usage).toBeUndefined()
})

test('listModels', async () => {
  expect(await new OpenAIBackend('http://x/v1', fakeFetch(200, { data: [{ id: 'a' }, { id: 'b' }] })).listModels()).toEqual(['a', 'b'])
  expect(await new OllamaBackend('http://x', fakeFetch(200, { models: [{ name: 'q:8b' }] })).listModels()).toEqual(['q:8b'])
})

test('finish_reason/done_reason length sets truncated', async () => {
  const o = fx('openai-tool-call'); o[5].choices[0].finish_reason = 'length'
  const l = fx('ollama-tool-call'); l[3].done_reason = 'length'
  expect((await openai(o).send({})).truncated).toBe(true)
  expect((await ollama(l).send({})).truncated).toBe(true)
})

test('defaultFetch reaches a local server that delays its headers, and honours abort', async () => {
  const srv = createServer((req, res) => {
    if (req.url === '/slow') return void setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end('{"ok":1}') }, 100)
    setTimeout(() => res.end('{}'), 5000) // /hang: never answers in time
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  try {
    const r = await defaultFetch(`http://127.0.0.1:${port}/slow`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(r.ok).toBe(true); expect(JSON.parse(await r.text())).toEqual({ ok: 1 })
    const ac = new AbortController(); setTimeout(() => ac.abort(), 50)
    await expect(defaultFetch(`http://127.0.0.1:${port}/hang`, { signal: ac.signal })).rejects.toThrow()
  } finally { srv.closeAllConnections(); srv.close() }
})

const routeFetch = (routes: Record<string, unknown>) => {
  const calls: { url: string; body: any }[] = []
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined })
    const path = new URL(url).pathname
    return new Response(JSON.stringify(routes[path] ?? { error: 'no route' }), { status: path in routes ? 200 : 404, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fn, calls }
}

test('openai countTokens: apply-template then tokenize at the server root, exact length', async () => {
  const f = routeFetch({ '/apply-template': { prompt: '<|im_start|>rendered' }, '/tokenize': { tokens: [1, 2, 3, 4, 5] } })
  const be = new OpenAIBackend('http://x:8080/v1', f.fn)
  const payload = be.buildPayload(req)
  expect(await be.countTokens(payload)).toBe(5)
  expect(f.calls.map(c => c.url)).toEqual(['http://x:8080/apply-template', 'http://x:8080/tokenize'])
  expect(f.calls[0].body).toEqual(payload)
  expect(f.calls[1].body).toEqual({ content: '<|im_start|>rendered', add_special: true, model: 'm' })
})

test('openai countTokens: a server without the endpoints yields undefined, no throw', async () => {
  const f = routeFetch({ '/apply-template': {} })
  const be = new OpenAIBackend('http://x:8080/v1', f.fn)
  expect(await be.countTokens(be.buildPayload(req))).toBeUndefined()
  expect(await new OpenAIBackend('http://x:8080/v1', routeFetch({}).fn).countTokens({})).toBeUndefined()
})

const chunked = (parts: string[]) => (async () => new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close() } }), { status: 200 })) as unknown as typeof fetch

test('a line split across body chunks and a trailing line without newline are both parsed', async () => {
  const r = await new OpenAIBackend('http://x/v1', chunked(['data: {"choices":[{"delta":{"con', 'tent":"x"}}]}\n\ndata: {"choices":[{"delta":{"content":"y"}}]}'])).send({})
  expect(r.content).toBe('xy')
})

test('data: without a space is still a chunk', async () => {
  const r = await new OpenAIBackend('http://x/v1', chunked(['data:{"choices":[{"delta":{"content":"z"}}]}\n\ndata:[DONE]\n\n'])).send({})
  expect(r.content).toBe('z')
})

test('not-an-event-stream error carries the body as sent, not duplicated across chunks', async () => {
  await expect(new OpenAIBackend('http://x/v1', chunked(['<html>abc', 'def</html>'])).send({})).rejects.toSatisfy((e: unknown) => (e as BackendError).body === '<html>abcdef</html>')
})

test('think becomes chat_template_kwargs.enable_thinking / think, either value, and is absent from the payload when not set', () => {
  for (const think of [false, true]) {
    expect((new OpenAIBackend('http://x/v1').buildPayload({ ...req, think }) as any).chat_template_kwargs).toEqual({ enable_thinking: think })
    expect((new OllamaBackend('http://x').buildPayload({ ...req, think }) as any).think).toBe(think)
  }
  expect(new OpenAIBackend('http://x/v1').buildPayload(req)).not.toHaveProperty('chat_template_kwargs')
  expect(new OllamaBackend('http://x').buildPayload(req)).not.toHaveProperty('think')
})

test('maxTokens becomes max_tokens / num_predict, and is absent from the payload when not set', () => {
  const capped = { ...req, maxTokens: 512 }
  expect((new OpenAIBackend('http://x/v1').buildPayload(capped) as any).max_tokens).toBe(512)
  expect((new OllamaBackend('http://x').buildPayload(capped) as any).options).toEqual({ temperature: 0.1, num_ctx: 8192, num_predict: 512 })
  expect(new OpenAIBackend('http://x/v1').buildPayload(req)).not.toHaveProperty('max_tokens')
  expect((new OllamaBackend('http://x').buildPayload(req) as any).options).not.toHaveProperty('num_predict')
})

/** Routes by path *and* query, as llama-server's router answers /props and /props?model= differently. */
const urlFetch = (routes: Record<string, [number, unknown]>) => {
  const urls: string[] = []
  const fn = (async (url: string) => {
    urls.push(url)
    const u = new URL(url), [status, body] = routes[u.pathname + u.search] ?? [404, { error: 'no route' }]
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fn, urls }
}

test('openai serverInfo: one-model llama-server — window and build from /props at the server root', async () => {
  const f = urlFetch({ '/props': [200, { default_generation_settings: { n_ctx: 4096 }, build_info: 'b11046-60081bb2b', total_slots: 1 }] })
  expect(await new OpenAIBackend('http://x:8080/v1', f.fn).serverInfo('m')).toEqual({ nCtx: 4096, build: 'b11046-60081bb2b', router: false })
  expect(f.urls).toEqual(['http://x:8080/props'])
})

test('openai serverInfo: llama-server router — the window is the model\'s, from /props?model=', async () => {
  const f = urlFetch({
    '/props': [200, { role: 'router', default_generation_settings: { params: null, n_ctx: 0 }, build_info: 'b11046-60081bb2b' }],
    '/props?model=unsloth%2FQwen3-8B-GGUF%3AQ4_K_M': [200, { default_generation_settings: { n_ctx: 40960 }, build_info: 'b11046-60081bb2b', total_slots: 4 }],
    '/props?model=nope': [400, { error: { code: 400, message: "model 'nope' not found" } }],
  })
  const be = new OpenAIBackend('http://x:8080/v1', f.fn)
  expect(await be.serverInfo('unsloth/Qwen3-8B-GGUF:Q4_K_M')).toEqual({ nCtx: 40960, build: 'b11046-60081bb2b', router: true })
  // a model the router does not have: still a router, window unknown
  expect(await be.serverInfo('nope')).toEqual({ build: 'b11046-60081bb2b', router: true })
})

test('openai serverInfo: a server without /props (LM Studio, vLLM) yields undefined, no throw', async () => {
  expect(await new OpenAIBackend('http://x:1234/v1', urlFetch({}).fn).serverInfo('m')).toBeUndefined()
  expect(await new OpenAIBackend('http://x:1234/v1', (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch).serverInfo('m')).toBeUndefined()
})

test('send reads a non-streamed JSON reply by its content-type', async () => {
  const body = { choices: [{ index: 0, message: { role: 'assistant', content: 'hi', reasoning_content: 'r', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }
  const r = await new OpenAIBackend('http://x/v1', fakeFetch(200, body)).send({ stream: false })
  expect(r).toMatchObject({ content: 'hi', reasoning: 'r', usage: { promptTokens: 7, completionTokens: 3 }, raw: body })
  expect(r.toolCalls).toEqual([{ backendId: 'call_1', name: 'bash', args: { command: 'ls' } }])
  expect(r.truncated).toBeUndefined()
})

test('fromJson: bad arguments, object arguments, null content, length', () => {
  const r = fromJson({ choices: [{ message: { content: null, tool_calls: [{ id: 'a', function: { name: 'x', arguments: '{bad' } }, { function: { name: 'y', arguments: { k: 1 } } }] }, finish_reason: 'length' }] })
  expect(r.content).toBe(''); expect(r.truncated).toBe(true)
  expect(r.toolCalls[0]).toMatchObject({ backendId: 'a', name: 'x', args: {} })
  expect(r.toolCalls[0].argsError).toMatch(/\{bad/)
  expect(r.toolCalls[1]).toEqual({ backendId: undefined, name: 'y', args: { k: 1 } })
})

test('send on a 200 application/json {error} rejects with BackendError, not an empty reply', async () => {
  await expect(new OpenAIBackend('http://x/v1', fakeFetch(200, { error: { message: 'boom' } })).send({}))
    .rejects.toSatisfy((e: unknown) => e instanceof BackendError && /boom/.test(e.message))
})

test('fromJson: a body with only error throws; one with error and choices does not', () => {
  expect(() => fromJson({ error: { message: 'boom' } })).toThrow(/boom/)
  expect(() => fromJson({ error: 'string error' })).toThrow(/string error/)
  expect(fromJson({ error: 'ignored', choices: [{ message: { content: 'ok' } }] }).content).toBe('ok')
})

test('send takes the stream path when the fetch gives no headers', async () => {
  const noHeaders = (async () => {
    const r = new Response(sseBody(fx('openai-tool-call')), { status: 200 })
    return { ok: r.ok, status: r.status, text: () => r.text(), body: r.body }
  }) as any
  const r = await new OpenAIBackend('http://x/v1', noHeaders).send({})
  expect(r.toolCalls.length).toBeGreaterThan(0)
})

test('collect over the same stream gives what send gives', async () => {
  const a = await openai().send({})
  const b = await collect(jsonChunks(new Response(sseBody(fx('openai-tool-call')), { status: 200 }), 'POST /chat/completions', 'data:'))
  expect(b).toEqual(a)
})

test('a server\'s junk reaches nobody raw: usage only from numbers, text only from strings, a tool name as a string', async () => {
  const esc = '\u001b[?7l'
  const deltas: Delta[] = []
  const r = await openai([
    { choices: [{ index: 0, delta: { content: ['not', 'text'], reasoning: { x: 1 } } }] },
    { choices: [{ index: 0, delta: { content: 'ok', tool_calls: [{ index: 0, id: 7, function: { name: 42, arguments: '{}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: esc, completion_tokens: 3 } },
  ]).send({}, undefined, d => deltas.push(d))
  expect(r.content).toBe('ok'); expect(r.reasoning).toBeUndefined(); expect(r.usage).toBeUndefined()
  expect(r.toolCalls).toEqual([{ backendId: '7', name: '42', args: {} }])
  expect(deltas).toEqual([{ content: 'ok' }])

  const j = fromJson({ choices: [{ message: { content: 5, reasoning: ['r'], tool_calls: [{ id: 1, function: { name: 9, arguments: '{}' } }] } }], usage: { prompt_tokens: -1, completion_tokens: 2 } })
  expect(j.content).toBe(''); expect(j.reasoning).toBeUndefined(); expect(j.usage).toBeUndefined()
  expect(j.toolCalls).toEqual([{ backendId: '1', name: '9', args: {} }])

  const o: Delta[] = []
  const ol = await ollama([
    { message: { content: 7, thinking: ['x'] }, done: false },
    { message: { content: 'ok', tool_calls: [{ function: { name: 9, arguments: { a: 1 } } }] }, done: false },
    { message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 'lots', eval_count: 2 },
  ]).send({}, undefined, d => o.push(d))
  expect(ol.content).toBe('ok'); expect(ol.reasoning).toBeUndefined(); expect(ol.usage).toBeUndefined()
  expect(ol.toolCalls).toEqual([{ name: '9', args: { a: 1 } }])
  expect(o).toEqual([{ content: 'ok' }])
})

test('a tool-call index that is not a small integer lands in slot 0 and touches no prototype', async () => {
  const r = await openai([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: '__proto__', id: 'p', function: { name: 'bash', arguments: '{}' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 'constructor', function: { arguments: '' } }] }, finish_reason: 'tool_calls' }] },
  ]).send({})
  expect(r.toolCalls).toEqual([{ backendId: 'p', name: 'bash', args: {} }])
  expect(([] as any).id).toBeUndefined(); expect(([] as any).name).toBeUndefined(); expect(([] as any).args).toBeUndefined()
})

test('a count the server leaves out is 0, as before: only a count that is not a number drops the usage', async () => {
  const r = await openai([{ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5 } }]).send({})
  expect(r.usage).toEqual({ promptTokens: 5, completionTokens: 0 })
  const o = await ollama([{ message: { content: 'x' }, done: true, done_reason: 'stop', prompt_eval_count: 4 }]).send({})
  expect(o.usage).toEqual({ promptTokens: 4, completionTokens: 0 })
})

// The documented OpenRouter chunk for a failure after the 200 (docs: api-reference/errors).
const orError = { id: 'gen-1', object: 'chat.completion.chunk', error: { code: 429, message: 'Rate limit exceeded', metadata: { error_type: 'rate_limit_exceeded' } }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] }

test('a stream that fails after 200 is a BackendError with the provider\'s text, after content and as the only event', async () => {
  for (const chunks of [[{ choices: [{ index: 0, delta: { content: 'Hel' } }] }, orError], [orError]]) {
    await expect(openai(chunks).send({})).rejects.toSatisfy((e: unknown) =>
      e instanceof BackendError && e.message === 'POST /chat/completions: Rate limit exceeded' && JSON.parse(e.body!).error.code === 429)
  }
  await expect(openai([{ choices: [{ index: 0, delta: {}, finish_reason: 'error' }] }]).send({}))
    .rejects.toThrow('POST /chat/completions: stream ended with finish_reason "error"')
})

test('OpenRouter\'s keep-alive comments and the usage chunk that repeats finish_reason make an ordinary reply', async () => {
  const text = ': OPENROUTER PROCESSING\n\n' + sseBody([
    { choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1 } },
  ])
  const r = await new OpenAIBackend('http://x/v1', fakeStream(200, text)).send({})
  expect(r).toMatchObject({ content: 'hi', usage: { promptTokens: 9, completionTokens: 1 } })
  expect(r.truncated).toBeUndefined()
})

test('fromJson: finish_reason "error" in a stream:false body throws with the provider\'s text', () => {
  expect(() => fromJson({ error: { message: 'boom' }, choices: [{ message: { content: '' }, finish_reason: 'error' }] })).toThrow('POST /chat/completions: boom')
})

const KEY = 'sk-or-v1-' + '0'.repeat(32)
type Logged = { url: string; init?: any }
/** A fetch that answers from `respond` and logs every request: method and path, headers, the redirect mode. */
function recorder(respond: (url: string) => Response) {
  const log: Logged[] = []
  const f = (async (url: string, init?: any) => { log.push({ url, init }); return respond(url) }) as unknown as FetchLike
  return { f, log, paths: () => log.map(r => `${r.init?.method ?? 'GET'} ${new URL(r.url).pathname}`) }
}
const modelsBody = { data: [
  { id: 'qwen/qwen3-32b', context_length: 131072, top_provider: { context_length: 40960 } },
  { id: 'qwen/qwen3-coder', context_length: 262144, top_provider: { context_length: 262144 } },
  { id: 'no/window' },
], total_count: 3 }
const jsonRes = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const sseRes = (chunks: unknown[]) => new Response(sseBody(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } })
const listen = async (s: ReturnType<typeof createServer>) => { await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); return (s.address() as { port: number }).port }

test('with a key: the bearer token and no redirects on /models and /chat/completions, and nothing else is asked', async () => {
  const rec = recorder(url => url.endsWith('/models') ? jsonRes(modelsBody) : sseRes([{ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }]))
  const be = new OpenAIBackend('https://openrouter.ai/api/v1/', rec.f, KEY)
  const payload = be.buildPayload(req)
  expect(await be.countTokens(payload)).toBeUndefined()
  await be.send(payload)
  expect(rec.paths()).toEqual(['POST /api/v1/chat/completions'])
  expect(await be.listModels()).toEqual(['qwen/qwen3-32b', 'qwen/qwen3-coder', 'no/window'])
  expect(await be.serverInfo('qwen/qwen3-32b')).toEqual({ nCtx: 40960, router: false })
  expect(rec.paths()).toEqual(['POST /api/v1/chat/completions', 'GET /api/v1/models'])
  for (const r of rec.log) { expect(r.init.headers.authorization).toBe(`Bearer ${KEY}`); expect(r.init.redirect).toBe('manual') }
  expect(be.partialList).toBe(false)
})

test('serverInfo with a key: by id or by id without a routing suffix, with no listModels first; /models read once', async () => {
  const rec = recorder(() => jsonRes(modelsBody))
  const be = new OpenAIBackend('https://or.example/api/v1', rec.f, KEY)
  expect(await be.serverInfo('qwen/qwen3-coder:nitro')).toEqual({ nCtx: 262144, router: false })
  expect(await be.serverInfo('no/window')).toEqual({ router: false })
  expect(await be.serverInfo('absent/model')).toEqual({ router: false })
  expect(rec.paths()).toEqual(['GET /api/v1/models'])
  const partial = recorder(() => jsonRes({ data: [{ id: 'a' }], total_count: 500 }))
  const p = new OpenAIBackend('https://or.example/api/v1', partial.f, KEY)
  await p.listModels()
  expect(p.partialList).toBe(true)
})

test('createBackend: the key from env, trimmed, reaches the server; without a value it throws', async () => {
  const seen: string[] = []
  const srv = createServer((q, s) => { seen.push(String(q.headers.authorization)); s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify({ data: [{ id: 'm' }] })) })
  const port = await listen(srv)
  try {
    const b = { kind: 'openai' as const, baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', temperature: 0, apiKeyEnv: 'LHB_T_API_KEY' }
    expect(await createBackend(b, { LHB_T_API_KEY: `  ${KEY}\n` }).listModels()).toEqual(['m'])
    expect(seen).toEqual([`Bearer ${KEY}`])
    expect(() => createBackend(b, {})).toThrow('backend.apiKeyEnv: LHB_T_API_KEY is not set')
    expect(() => createBackend({ ...b, baseUrl: 'http://10.0.0.2/v1' }, { LHB_T_API_KEY: KEY })).toThrow('backend.apiKeyEnv needs an https baseUrl (http only on localhost, 127.0.0.1 or [::1]): the key would cross the network in clear text')
    expect(() => createBackend({ ...b, baseUrl: 'http://' }, { LHB_T_API_KEY: KEY })).toThrow('backend.baseUrl must be an http(s) URL')
  } finally { srv.close() }
})

test('with a key a 3xx is an error, not a hop: the next server gets nothing', async () => {
  const moved = recorder(() => new Response('moved', { status: 302, headers: { location: 'https://elsewhere.example/v1/models' } }))
  await expect(new OpenAIBackend('https://or.example/v1', moved.f, KEY).listModels())
    .rejects.toThrow('GET /models: 302 (redirect not followed: with a key, requests go only to baseUrl)')
  const hits: string[] = []
  const b = createServer((q, s) => { hits.push(String(q.url)); s.end('{}') })
  const bPort = await listen(b)
  const a = createServer((_q, s) => { s.writeHead(307, { location: `http://127.0.0.1:${bPort}/v1/chat/completions` }); s.end() })
  const aPort = await listen(a)
  try {
    await expect(new OpenAIBackend(`http://127.0.0.1:${aPort}/v1`, defaultFetch, KEY).send({}))
      .rejects.toThrow('POST /chat/completions: 307 (redirect not followed: with a key, requests go only to baseUrl)')
    expect(hits).toEqual([])
  } finally { a.close(); b.close() }
})

test('a 401 to a request that carried no key says how to send one; with a key the status stands alone', async () => {
  const no = recorder(() => jsonRes({ error: { message: 'No auth credentials found', code: 401 } }, 401))
  await expect(new OpenAIBackend('https://or.example/v1', no.f).listModels()).rejects.toThrow('GET /models: 401 (no key was sent: set backend.apiKeyEnv or --api-key-env)')
  await expect(new OpenAIBackend('https://or.example/v1', no.f).send({})).rejects.toThrow('POST /chat/completions: 401 (no key was sent: set backend.apiKeyEnv or --api-key-env)')
  expect(no.log.every(r => r.init?.headers?.authorization === undefined)).toBe(true)
  await expect(new OpenAIBackend('https://or.example/v1', no.f, KEY).send({}))
    .rejects.toSatisfy((e: unknown) => e instanceof BackendError && e.message === 'POST /chat/completions: 401')
})

test('without a key nothing changes: no authorization, no redirect mode, llama-server\'s extras still asked', async () => {
  const rec = recorder(url => url.endsWith('/props') ? jsonRes({ default_generation_settings: { n_ctx: 4096 } }) : jsonRes({ prompt: 'p', tokens: [1, 2] }))
  const be = new OpenAIBackend('http://127.0.0.1:8080/v1', rec.f)
  expect(await be.countTokens({ model: 'm' })).toBe(2)
  expect(await be.serverInfo('m')).toEqual({ nCtx: 4096, router: false })
  expect(rec.paths()).toEqual(['POST /apply-template', 'POST /tokenize', 'GET /props'])
  expect(rec.log.every(r => r.init?.headers?.authorization === undefined && r.init?.redirect === undefined)).toBe(true)
})

test('usage carries cached_tokens as cacheReadTokens, only as a finite non-negative number', async () => {
  const send = (cached: unknown) => new OpenAIBackend('http://x/v1', fakeFetch(200, { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1, prompt_tokens_details: { cached_tokens: cached } } })).send({ stream: false })
  expect((await send(7)).usage).toEqual({ promptTokens: 9, completionTokens: 1, cacheReadTokens: 7 })
  expect((await send('7')).usage).toEqual({ promptTokens: 9, completionTokens: 1 })
})

test('createBackend: kind anthropic never falls through to OpenAIBackend', () => {
  const b = { kind: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', model: 'm', temperature: 0 }
  expect(() => createBackend(b, {})).toThrow('backend.kind anthropic needs backend.apiKeyEnv')
  expect(createBackend({ ...b, apiKeyEnv: 'LHB_T_API_KEY' }, { LHB_T_API_KEY: KEY })).toBeInstanceOf(AnthropicBackend)
})

test('serverInfo with a key: what a model lacks in supported_parameters it does not take; no list, nothing known', async () => {
  const listed = { data: [
    { id: 'plain/model', supported_parameters: ['max_tokens', 'seed'] },
    { id: 'one/schema', supported_parameters: ['temperature', 'max_tokens', 'tools', 'structured_outputs'] },
    { id: 'no/list' },
  ] }
  const be = new OpenAIBackend('https://or.example/api/v1', recorder(() => jsonRes(listed)).f, KEY)
  expect(await be.serverInfo('plain/model')).toEqual({ takes: { temperature: false, tools: false, responseSchema: false }, takesFrom: 'OpenRouter supported_parameters', router: false })
  expect(await be.serverInfo('one/schema')).toEqual({ takes: {}, takesFrom: 'OpenRouter supported_parameters', router: false })
  expect(await be.serverInfo('no/list')).toEqual({ router: false })
})

test('ollama serverInfo: capabilities from POST /api/show; without them nothing is known; a failure is undefined', async () => {
  const rec = recorder(() => jsonRes({ capabilities: ['completion'] }))
  expect(await new OllamaBackend('http://x/', rec.f).serverInfo('q:8b')).toEqual({ takes: { tools: false, think: false }, takesFrom: 'Ollama /api/show', router: false })
  expect(rec.paths()).toEqual(['POST /api/show'])
  expect(JSON.parse(rec.log[0].init.body)).toEqual({ model: 'q:8b' })
  expect(await new OllamaBackend('http://x', recorder(() => jsonRes({ capabilities: ['completion', 'tools', 'thinking'] })).f).serverInfo('q')).toEqual({ takes: {}, takesFrom: 'Ollama /api/show', router: false })
  expect(await new OllamaBackend('http://x', recorder(() => jsonRes({ modelfile: '' })).f).serverInfo('q')).toEqual({ router: false })
  expect(await new OllamaBackend('http://x', recorder(() => jsonRes({ error: 'no' }, 404)).f).serverInfo('q')).toBeUndefined()
  expect(await new OllamaBackend('http://x', (async () => { throw new Error('fetch failed') }) as unknown as FetchLike).serverInfo('q')).toBeUndefined()
})

// ---- BackendError.status / moderated / retryAfter ----
const failWith = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (async () => ({ ok: false, status, text: async () => JSON.stringify(body), headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } })) as unknown as FetchLike

test('a non-2xx carries its HTTP status (and Retry-After) on every adapter', async () => {
  for (const s of [401, 402, 429]) {
    await expect(new OpenAIBackend('http://x/v1', failWith(s, {})).send({})).rejects.toMatchObject({ status: s })
    await expect(new OllamaBackend('http://x', failWith(s, {})).send({})).rejects.toMatchObject({ status: s })
    await expect(new AnthropicBackend('http://x', failWith(s, {}), 'K', 'KEY').send({})).rejects.toMatchObject({ status: s })
  }
  await expect(new OpenAIBackend('http://x/v1', failWith(429, {}, { 'retry-after': '7' })).send({})).rejects.toMatchObject({ status: 429, retryAfter: 7 })
  await expect(new OpenAIBackend('http://x/v1', failWith(429, {})).send({})).rejects.toSatisfy((e: any) => e.retryAfter === undefined)
})

test('a 403 whose body carries metadata.reasons is moderated; one without is not', async () => {
  const mod = { error: { code: 403, message: 'flagged', metadata: { reasons: ['violence'], flagged_input: 'x' } } }
  await expect(new OpenAIBackend('http://x/v1', failWith(403, mod)).send({})).rejects.toMatchObject({ status: 403, moderated: true })
  await expect(new OpenAIBackend('http://x/v1', failWith(403, { error: { message: 'no' } })).send({})).rejects.toSatisfy((e: any) => e.status === 403 && !e.moderated)
})

test('a failed stream takes its status from a numeric error.code, never from text', async () => {
  await expect(openai([orError]).send({})).rejects.toMatchObject({ status: 429 })
  const text = { error: { code: 'rate_limited', message: 'HTTP 429 slow down' }, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] }
  await expect(openai([text]).send({})).rejects.toSatisfy((e: any) => e.status === undefined)
  await expect(openai([{ error: { code: 402, message: 'credits' } }]).send({})).rejects.toMatchObject({ status: 402 })
})
