import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { OpenAIBackend } from '../src/core/backends/openai.js'
import { OllamaBackend } from '../src/core/backends/ollama.js'
import { BackendError, type ChatRequest } from '../src/core/backends/types.js'

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'))
const fakeFetch = (status: number, body: unknown) => (async (_url: string, init?: RequestInit) => {
  ;(fakeFetch as any).last = { url: _url, init }
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}) as unknown as typeof fetch

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
  expect(p.stream).toBe(false)
  expect(p.tools[0]).toEqual({ type: 'function', function: { name: 'bash', description: 'd', parameters: req.tools![0].parameters } })
  expect(p.messages[2].tool_calls[0]).toEqual({ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } })
  expect(p.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'a.txt' })
  expect(p.response_format.type).toBe('json_schema')
  expect(p).not.toHaveProperty('options')
})

test('ollama payload shape', () => {
  const p = new OllamaBackend('http://x').buildPayload(req) as any
  expect(p.stream).toBe(false)
  expect(p.options).toEqual({ temperature: 0.1, num_ctx: 8192 })
  expect(p.messages[2].tool_calls[0]).toEqual({ function: { name: 'bash', arguments: { command: 'ls' } } })
  expect(p.messages[3]).toEqual({ role: 'tool', tool_name: 'bash', content: 'a.txt' })
  expect(p.format).toEqual({ type: 'object' })
})

test('both normalize to the same response', async () => {
  const a = await new OpenAIBackend('http://x/v1', fakeFetch(200, fx('openai-tool-call'))).send({})
  const b = await new OllamaBackend('http://x', fakeFetch(200, fx('ollama-tool-call'))).send({})
  for (const r of [a, b]) {
    expect(r.content).toBe('')
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].name).toBe('read_file')
    expect(r.toolCalls[0].args).toEqual({ path: 'src/slugify.js' })
    expect(r.reasoning).toBeTruthy()
    expect(r.usage!.promptTokens).toBeGreaterThan(500)
  }
  expect(a.toolCalls[0].backendId).toBe('call_9f2a')
  expect(b.toolCalls[0].backendId).toBeUndefined()
})

test('openai invalid arguments json sets argsError', async () => {
  const body = fx('openai-tool-call'); body.choices[0].message.tool_calls[0].function.arguments = '{oops'
  const r = await new OpenAIBackend('http://x/v1', fakeFetch(200, body)).send({})
  expect(r.toolCalls[0].argsError).toBeTruthy(); expect(r.toolCalls[0].args).toEqual({})
})

test('non-2xx throws BackendError with body', async () => {
  await expect(new OpenAIBackend('http://x/v1', fakeFetch(400, { error: 'tools not supported without --jinja' })).send({}))
    .rejects.toSatisfy((e: unknown) => e instanceof BackendError && /jinja/.test(e.body!))
})

test('2xx with a non-JSON body throws BackendError', async () => {
  const html = (async () => new Response('<html>proxy</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
  await expect(new OpenAIBackend('http://x/v1', html).send({})).rejects.toSatisfy((e: unknown) => e instanceof BackendError && /not JSON/.test(e.message) && /proxy/.test(e.body!))
  await expect(new OllamaBackend('http://x', html).send({})).rejects.toBeInstanceOf(BackendError)
})

test('listModels', async () => {
  expect(await new OpenAIBackend('http://x/v1', fakeFetch(200, { data: [{ id: 'a' }, { id: 'b' }] })).listModels()).toEqual(['a', 'b'])
  expect(await new OllamaBackend('http://x', fakeFetch(200, { models: [{ name: 'q:8b' }] })).listModels()).toEqual(['q:8b'])
})
