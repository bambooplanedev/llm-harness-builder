// A stand-in for a hosted OpenAI-compatible API, in the test process: /v1/models and /v1/chat/completions (SSE, with
// OpenRouter's keep-alive comment), replies from a queue, and every request logged with its headers and body. The
// real backend talks to it over HTTP, so a CLI test must spawn the CLI asynchronously.
import http from 'node:http'

export type Seen = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }
export type FakeOpenAI = { baseUrl: string; seen: Seen[]; close(): Promise<void> }

/** `replies`: the SSE chunks of each chat request, in order. `models`: what /v1/models lists. */
export async function fakeOpenAI(replies: object[][], models: object[] = [{ id: 'fake/model', context_length: 32768 }]): Promise<FakeOpenAI> {
  const seen: Seen[] = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]
      seen.push({ method: req.method ?? '', path, headers: req.headers, body })
      if (req.method === 'GET' && path === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({ data: models, total_count: models.length }))
      }
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        const chunks = replies.shift()
        if (!chunks) { res.writeHead(500, { 'content-type': 'application/json' }); return void res.end('{"error":{"message":"fake: no more replies"}}') }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        return void res.end(': OPENROUTER PROCESSING\n\n' + chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n')
      }
      res.writeHead(404); res.end('not here')
    })
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  return {
    baseUrl: `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`, seen,
    close: () => new Promise<void>(r => { srv.closeAllConnections(); srv.close(() => r()) }),
  }
}

/** One assistant turn as SSE chunks: a native tool call. */
export const toolTurn = (name: string, args: object) => [
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
]
/** One assistant turn as SSE chunks: plain text. */
export const textTurn = (text: string) => [
  { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2 } },
]
