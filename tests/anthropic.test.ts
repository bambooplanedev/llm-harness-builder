import { test, expect } from 'vitest'
import { AnthropicBackend, collectAnthropic } from '../src/core/backends/anthropic.js'
import { BackendError, jsonChunks, type ChatRequest, type Delta, type FetchLike } from '../src/core/backends/types.js'

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
