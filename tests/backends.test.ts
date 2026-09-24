import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { OpenAIBackend, collect, fromJson } from '../src/core/backends/openai.js'
import { OllamaBackend } from '../src/core/backends/ollama.js'
import { BackendError, defaultFetch, jsonChunks, type ChatRequest, type Delta } from '../src/core/backends/types.js'

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
