// A stand-in for the Anthropic API, in the test process: GET /v1/models, GET /v1/models/{id} and POST /v1/messages (SSE),
// replies from a queue, and every request logged with its headers and body. `baseUrl` is the root, as a harness names it.
import http from 'node:http'
import type { Seen } from './fake-openai.js'

export type FakeAnthropic = { baseUrl: string; seen: Seen[]; close(): Promise<void> }

const MODELS = [{ type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', max_input_tokens: 200000, max_tokens: 64000 }]

/** `replies`: the SSE text of each POST /v1/messages, in order. `models`: what /v1/models lists and /v1/models/{id} finds. */
export async function fakeAnthropic(replies: string[], models: object[] = MODELS): Promise<FakeAnthropic> {
  const seen: Seen[] = []
  const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]
      seen.push({ method: req.method ?? '', path, headers: req.headers, body })
      if (req.method === 'GET' && path === '/v1/models') return json(res, 200, { data: models, has_more: false, first_id: null, last_id: null })
      if (req.method === 'GET' && path.startsWith('/v1/models/')) {
        const m = models.find(x => (x as { id?: string }).id === decodeURIComponent(path.slice('/v1/models/'.length)))
        return m ? json(res, 200, m) : json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'model not found' } })
      }
      if (req.method === 'POST' && path === '/v1/messages') {
        const sse = replies.shift()
        if (sse === undefined) return json(res, 500, { type: 'error', error: { type: 'api_error', message: 'fake: no more replies' } })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        return void res.end(sse)
      }
      json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'not here' } })
    })
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  return {
    baseUrl: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, seen,
    close: () => new Promise<void>(r => { srv.closeAllConnections(); srv.close(() => r()) }),
  }
}

const sse = (events: object[]) => events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const reply = (block: object, delta: object, stop_reason: string) => sse([
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: block },
  { type: 'ping' },
  { type: 'content_block_delta', index: 0, delta },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
])
/** One assistant turn as SSE text: plain text. */
export const textReply = (text: string) => reply({ type: 'text', text: '' }, { type: 'text_delta', text }, 'end_turn')
/** One assistant turn as SSE text: one tool call. */
export const toolReply = (name: string, args: object) =>
  reply({ type: 'tool_use', id: 'toolu_1', name, input: {} }, { type: 'input_json_delta', partial_json: JSON.stringify(args) }, 'tool_use')
