// Spec acceptance 1: a native-mode harness run through the proxy leaves the trace its own run leaves,
// on everything the proxy can see, and differs exactly where the spec says it does.
import { test, expect } from 'vitest'
import http from 'node:http'
import { writeFile, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runAgent } from '../src/core/run.js'
import { startProxy } from '../src/core/proxy/server.js'
import type { HarnessEvent } from '../src/core/events.js'
import { harness, tmp } from './helpers.js'

type Call = { id?: string; name: string; args: object }
const sse = (content: string, calls: Call[]) => [
  { choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
  ...calls.map((c, i) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, ...(c.id ? { id: c.id } : {}), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] }, finish_reason: null }] })),
  { choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] },
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'

/** A llama-server stand-in: plays `replies` on /v1/chat/completions, 404 elsewhere (/apply-template too, so countTokens gives up alike on both sides). */
async function upstream(replies: string[]) {
  const queue = [...replies]
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url !== '/v1/chat/completions') { res.writeHead(404); return void res.end() }
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(queue.shift())
    })
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => { srv.closeAllConnections(); srv.close() } }
}

const script = (ids: boolean) => [
  sse('', [{ id: ids ? 'call_a' : undefined, name: 'list_dir', args: { path: '.' } }]),
  sse('', [{ id: ids ? 'call_b' : undefined, name: 'read_file', args: { path: 'a.txt' } }, { id: ids ? 'call_c' : undefined, name: 'read_file', args: { path: 'b.txt' } }]),
  sse('both read', []),
]

async function agent(baseUrl: string, workdir: string): Promise<HarnessEvent[]> {
  const config = harness({ backend: { kind: 'openai', baseUrl, model: 'm', temperature: 0 }, tools: { enabled: ['list_dir', 'read_file'], approveBash: false } })
  const out: HarnessEvent[] = []
  for await (const e of runAgent({ config, task: 'read both files', workdir })) out.push(e)
  return out
}

/** A trace without what differs between two honest runs of the same script: wall time. */
const timeless = (evs: HarnessEvent[]) => evs.map(({ ts: _ts, ...e }: any) => (e.type === 'llm_response' ? { ...e, latencyMs: 0 } : e))

for (const ids of [true, false]) test(`the proxy trace matches the native trace (${ids ? 'server sends call ids' : 'no call ids'})`, async () => {
  const wd = await tmp('lhb-acc-wd-')
  await writeFile(join(wd, 'a.txt'), 'AAA'); await writeFile(join(wd, 'b.txt'), 'BBB')

  const direct = await upstream(script(ids))
  const native = await agent(`${direct.url}/v1`, wd)
  direct.close()

  const viaUp = await upstream(script(ids))
  const runsDir = await tmp('lhb-acc-runs-')
  const proxy = await startProxy({ upstream: viaUp.url, port: 0, runsDir, harness: 'acc' })
  const proxied = await agent(`http://127.0.0.1:${proxy.port}/v1`, wd)
  await proxy.stop(); viaUp.close()

  // The harness cannot tell it went through the proxy.
  expect(native.at(-1)).toMatchObject({ type: 'done', reason: 'final' })
  expect(timeless(proxied)).toEqual(timeless(native))

  const files = (await readdir(runsDir)).filter(f => f.endsWith('.jsonl'))
  expect(files).toHaveLength(1)
  const [metaLine, ...rec] = (await readFile(join(runsDir, files[0]), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
  expect(metaLine.meta).toMatchObject({ harness: 'acc', task: 'read both files', workdir: '', proxy: { upstream: viaUp.url, pid: process.pid } })

  const turns = (evs: any[]) => evs.filter(e => e.type === 'llm_request').map(e => e.turn)
  expect(turns(rec)).toEqual(turns(native))
  for (const t of turns(native)) {
    const at = (evs: any[], type: string) => evs.filter(e => e.turn === t && e.type === type)
    expect(at(rec, 'llm_request')[0].payload).toEqual(at(native, 'llm_request')[0].payload)
    expect(at(rec, 'llm_response')[0].content).toBe(at(native, 'llm_response')[0].content)
    expect(at(rec, 'tool_call').map(e => [e.call.callId, e.call.name, e.call.args])).toEqual(at(native, 'tool_call').map(e => [e.call.callId, e.call.name, e.call.args]))
    expect(at(rec, 'tool_result').map(e => [e.callId, e.output])).toEqual(at(native, 'tool_result').map(e => [e.callId, e.output]))
  }
  // Where the proxy differs, on purpose.
  for (const type of ['context_stats', 'final_check', 'approval_required', 'parse_error']) expect(rec.filter(e => e.type === type)).toEqual([])
  expect(rec.at(-1)).toMatchObject({ type: 'done', reason: 'aborted', turns: 3, toolCallCount: 3 })
  expect(rec.map(e => e.seq)).toEqual(rec.map((_, i) => i))
}, 30_000)
