import { test, expect, afterAll } from 'vitest'
import { mkdtemp, writeFile, readFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { startServer } from '../src/server/index.js'
import type { Backend, Delta, NormalizedResponse } from '../src/core/backends/types.js'

type Queued = Partial<NormalizedResponse> & { deltas?: Delta[] }
let gate: Promise<void> = Promise.resolve() // a test can hold send() until its SSE client is connected
const fake = (queue: Queued[]): Backend => ({
  async listModels() { return ['fake-model'] },
  buildPayload: r => r,
  async send(_p, _s, onDelta) {
    const r = queue.shift(); if (!r) throw new Error('no more')
    await gate
    const { deltas, ...rest } = r
    for (const d of deltas ?? []) onDelta?.(d)
    return { content: '', toolCalls: [], raw: {}, ...rest }
  },
})
const config = (over = {}) => ({
  name: 'h', backend: { kind: 'openai', baseUrl: 'http://x/v1', model: 'fake-model', temperature: 0 },
  systemPrompt: 's', tools: { enabled: ['bash'], approveBash: true },
  toolCalls: { mode: 'native', enforceSchema: false, promptedTemplate: '{{tools}}', parseErrorHint: 'h' },
  context: { maxToolOutputChars: 100, budgetTokens: 0 }, loop: { maxTurns: 3 }, ...over,
})

const runsDir = await mkdtemp(join(tmpdir(), 'lhb-runs-'))
const harnessesDir = await mkdtemp(join(tmpdir(), 'lhb-h-'))
const workdir = await mkdtemp(join(tmpdir(), 'lhb-wd-'))
let queue: Queued[] = []
const srv = await startServer({ port: 0, runsDir, harnessesDir, backendFactory: () => fake(queue) })
const base = `http://127.0.0.1:${srv.port}`
afterAll(() => srv.close())

// --- bench page: its own runs dir, so hand-written fixtures never mix with the real runs above
const benchDir = await mkdtemp(join(tmpdir(), 'lhb-bench-'))
const bsrv = await startServer({ port: 0, runsDir: benchDir, harnessesDir, backendFactory: () => fake([]) })
const bbase = `http://127.0.0.1:${bsrv.port}`
afterAll(() => bsrv.close())

const benchJson = (over: object = {}) => JSON.stringify({
  version: 1, date: '2026-09-13T10:00:00.000Z', task: 't', n: 2, timeoutS: 60, complete: false,
  harnesses: [{
    name: 'tuned', config: config(), pass: 1, reasons: { final: 1 },
    median: { turns: 2, toolCalls: 1, ms: 100 },
    runs: [{ round: 1, verdict: 'PASS', reason: 'final', turns: 2, toolCalls: 1, parseErrors: 0, ms: 100, workdir: '/tmp/wd', trace: 'aabbccdd' }],
  }],
  ...over,
})
await writeFile(join(benchDir, 'b1.json'), benchJson())
await writeFile(join(benchDir, 'b2.json'), benchJson({ date: '2026-09-13T11:00:00.000Z', complete: true }))
await writeFile(join(benchDir, 'notbench.json'), JSON.stringify({ version: 2 }))
await writeFile(join(benchDir, 'broken.json'), '{oops')
await writeFile(join(benchDir, 'noharnesses.json'), JSON.stringify({ version: 1, date: '2026-09-13T12:00:00.000Z', complete: false }))

const B1_STARTED = Date.parse('2026-09-13T10:05:00Z')
const part = (id: string, meta: object, events: object[]) => writeFile(
  join(benchDir, `${id}.jsonl.part`),
  [JSON.stringify({ meta: { id, harness: 'tuned', task: 't', workdir: '/tmp/wd', started: B1_STARTED, ...meta } }),
   ...events.map(e => JSON.stringify(e))].join('\n') + '\n')

await part('live0001', { bench: { file: 'b1.json', round: 2 } }, [
  { seq: 0, turn: 0, ts: B1_STARTED + 1000, type: 'llm_request', payload: {} },
  { seq: 1, turn: 0, ts: B1_STARTED + 2000, type: 'approval_required', call: { callId: 'c1', name: 'bash', args: { command: 'node --test' } } },
])
// a half-written line: the bench process is appending while we read
await appendFile(join(benchDir, 'live0001.jsonl.part'), '{"seq":2,"turn":0,"ts":')
// an orphan .part left by a bench that was killed before this one started
await part('stale001', { bench: { file: 'b1.json', round: 1 }, started: Date.parse('2026-09-13T09:00:00Z') }, [])
// a .part that belongs to another bench file, and is new enough to pass that file's date floor:
// without the `complete` short-circuit it would surface as b2.json's live run
await part('otherbe1', { bench: { file: 'b2.json', round: 1 }, started: Date.parse('2026-09-13T11:05:00Z') }, [])
// a `run`/`demo` trace: no meta.bench at all
await part('plainrun', { started: B1_STARTED + 60_000 }, [])
// seen between open() and the meta write in execRun
await writeFile(join(benchDir, 'empty000.jsonl.part'), '')

async function sse(id: string, until: (e: any) => boolean, lastId?: number): Promise<any[]> {
  const r = await fetch(`${base}/api/runs/${id}/events`, { headers: lastId !== undefined ? { 'last-event-id': String(lastId) } : {} })
  const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = ''; const out: any[] = []
  while (true) {
    const { value, done } = await reader.read(); if (done) break
    buf += dec.decode(value)
    let i; while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2)
      const data = block.split('\n').find(l => l.startsWith('data: '))?.slice(6)
      if (data) { const e = JSON.parse(data); out.push(e); if (until(e)) { await reader.cancel(); return out } }
    }
  }
  return out
}

// Like `sse` but ignores event content and just reads the stream to its natural end
// (the server always closes the connection after emitting `done`).
async function collectSSE(url: string, headers: Record<string, string> = {}): Promise<any[]> {
  const r = await fetch(url, { headers })
  const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = ''; const out: any[] = []
  while (true) {
    const { value, done } = await reader.read(); if (done) break
    buf += dec.decode(value)
    let i; while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2)
      const data = block.split('\n').find(l => l.startsWith('data: '))?.slice(6)
      if (data) out.push(JSON.parse(data))
    }
  }
  return out
}

test('run with approval over SSE, events persisted to jsonl', async () => {
  queue = [{ toolCalls: [{ name: 'bash', args: { command: 'echo hi' } }] }, { content: 'done' }]
  const r = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: config(), task: 't', workdir }) })
  expect(r.status).toBe(201)
  const { runId } = await r.json()
  const first = await sse(runId, e => e.type === 'approval_required')
  const call = first.at(-1).call
  const a = await fetch(`${base}/api/runs/${runId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: call.callId, ok: true }) })
  expect(a.status).toBe(200)
  const rest = await sse(runId, e => e.type === 'done', first.at(-1).seq)
  expect(rest[0].seq).toBe(first.at(-1).seq + 1)
  expect(rest.find(e => e.type === 'tool_result').output).toContain('hi')
  expect(rest.at(-1)).toMatchObject({ type: 'done', reason: 'final' })
  const lines = (await readFile(join(runsDir, `${runId}.jsonl`), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
  expect(lines[0].meta).toMatchObject({ harness: 'h', task: 't' })
  expect(lines.at(-1)).toMatchObject({ type: 'done' })
  const list = await (await fetch(`${base}/api/runs`)).json()
  expect(list.find((s: any) => s.id === runId)).toMatchObject({ harness: 'h', reason: 'final', toolCallCount: 1 })
})

test('validation: bad config 400, bad workdir 400, busy workdir 409', async () => {
  const bad = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: {}, task: 't', workdir }) })
  expect(bad.status).toBe(400)
  const home = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: config(), task: 't', workdir: '/' }) })
  expect(home.status).toBe(400)
  queue = [{ toolCalls: [{ name: 'bash', args: { command: 'true' } }] }]
  const a = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: config(), task: 't', workdir }) })
  const { runId } = await a.json()
  await sse(runId, e => e.type === 'approval_required')
  const b = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: config(), task: 't', workdir }) })
  expect(b.status).toBe(409)
  await fetch(`${base}/api/runs/${runId}/abort`, { method: 'POST' })
  const ev = await sse(runId, e => e.type === 'done')
  expect(ev.at(-1).reason).toBe('aborted')
})

const rawStatus = (headers: Record<string, string>) => new Promise<number>(resolve => {
  const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/runs', method: 'GET', headers }, res => { res.resume(); resolve(res.statusCode!) })
  req.end()
})
test('host/origin checks', async () => {
  expect(await rawStatus({ host: 'evil.com' })).toBe(403)
  expect(await rawStatus({ host: '127.0.0.1', origin: 'http://evil.com' })).toBe(403)
  expect(await rawStatus({ host: 'localhost:9', origin: 'http://localhost:5173' })).toBe(200)
})

test('harnesses and models', async () => {
  await writeFile(join(harnessesDir, 'x.json'), JSON.stringify(config({ name: 'x' })))
  expect(await (await fetch(`${base}/api/harnesses`)).json()).toEqual([{ name: 'x' }])
  const put = await fetch(`${base}/api/harnesses/y`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config({ name: 'y' })) })
  expect(put.status).toBe(200)
  expect((await (await fetch(`${base}/api/harnesses/y`)).json()).name).toBe('y')
  expect(await (await fetch(`${base}/api/models?kind=openai&baseUrl=http://x/v1`)).json()).toEqual(['fake-model'])
})

test('concurrent POST /api/runs for the same workdir: exactly one 201, one 409', async () => {
  const wd = await mkdtemp(join(tmpdir(), 'lhb-wd-race-'))
  queue = [{ toolCalls: [{ name: 'bash', args: { command: 'true' } }] }]
  const body = JSON.stringify({ config: config(), task: 't', workdir: wd })
  const [r1, r2] = await Promise.all([
    fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
    fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
  ])
  expect([r1.status, r2.status].sort()).toEqual([201, 409])
  const winner = r1.status === 201 ? r1 : r2
  const { runId } = await winner.json()
  await sse(runId, e => e.type === 'approval_required')
  await fetch(`${base}/api/runs/${runId}/abort`, { method: 'POST' })
  const ev = await sse(runId, e => e.type === 'done')
  expect(ev.at(-1).reason).toBe('aborted')
})

test('malformed Last-Event-ID header still replays full history and ends with done', async () => {
  const wd = await mkdtemp(join(tmpdir(), 'lhb-wd-bad-lei-'))
  queue = [{ content: 'done fast' }]
  const r = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: config(), task: 't', workdir: wd }) })
  const { runId } = await r.json()
  await sse(runId, e => e.type === 'done')
  const events = await collectSSE(`${base}/api/runs/${runId}/events`, { 'last-event-id': 'abc' })
  expect(events.length).toBeGreaterThan(0)
  expect(events.at(-1)).toMatchObject({ type: 'done' })
})

test('a stray empty run file does not break the run listing', async () => {
  await writeFile(join(runsDir, 'broken.jsonl'), '')
  const list = await fetch(`${base}/api/runs`)
  expect(list.status).toBe(200)
  const arr = await list.json()
  expect(Array.isArray(arr)).toBe(true)
  expect(arr.length).toBeGreaterThan(0)
})

test('run listing reads only the head and tail of large run files', async () => {
  const id = 'bigfile1'
  const now = Date.now()
  const lines = [
    { meta: { id, harness: 'h', task: 't', workdir, started: now } },
    { seq: 0, turn: 1, ts: now, type: 'tool_result', callId: 'c1', name: 'read_file', output: 'é'.repeat(300_000), truncated: false, error: false },
    { seq: 1, turn: 1, ts: now, type: 'done', reason: 'final', turns: 1, toolCallCount: 1 },
  ]
  await writeFile(join(runsDir, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  const list = await (await fetch(`${base}/api/runs`)).json()
  expect(list.find((s: any) => s.id === id)).toMatchObject({ harness: 'h', reason: 'final', turns: 1, toolCallCount: 1 })
})

test('orphaned run file (no done, process killed mid-run) gets a synthetic aborted done and is listed', async () => {
  const id = 'orphan01'
  const now = Date.now()
  const lines = [
    { meta: { id, harness: 'h', task: 't', workdir, started: now } },
    { seq: 0, turn: 1, ts: now, type: 'context_stats', estimatedTokens: 10, budgetTokens: 0, droppedChars: 0 },
    { seq: 1, turn: 1, ts: now, type: 'llm_request', payload: {} },
    { seq: 2, turn: 1, ts: now, type: 'tool_call', call: { callId: 'c1', name: 'bash', args: {} } },
  ]
  await writeFile(join(runsDir, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')

  const first = await collectSSE(`${base}/api/runs/${id}/events`)
  expect(first.at(-1)).toMatchObject({ type: 'done', reason: 'aborted', toolCallCount: 1 })

  const linesAfterFirst = (await readFile(join(runsDir, `${id}.jsonl`), 'utf8')).trim().split('\n')
  expect(linesAfterFirst.length).toBe(lines.length + 1)

  const second = await collectSSE(`${base}/api/runs/${id}/events`)
  expect(second.at(-1)).toMatchObject({ type: 'done', reason: 'aborted' })
  const linesAfterSecond = (await readFile(join(runsDir, `${id}.jsonl`), 'utf8')).trim().split('\n')
  expect(linesAfterSecond.length).toBe(linesAfterFirst.length)

  const list = await (await fetch(`${base}/api/runs`)).json()
  expect(list.find((s: any) => s.id === id)).toMatchObject({ reason: 'aborted' })
})

test('malformed JSON body returns 400, not 500', async () => {
  const r = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
  expect(r.status).toBe(400)
  const body = await r.json()
  expect(body.error).toMatch(/invalid JSON/)
})

test('PUT harness with a large multi-byte systemPrompt round-trips byte-exact', async () => {
  const systemPrompt = '€'.repeat(20000)
  const put = await fetch(`${base}/api/harnesses/utf8`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config({ name: 'utf8', systemPrompt })) })
  expect(put.status).toBe(200)
  const got = await (await fetch(`${base}/api/harnesses/utf8`)).json()
  expect(got.systemPrompt).toBe(systemPrompt)
})

test('deltas stream live as event: delta and never reach the jsonl or a replay', async () => {
  let open!: () => void; gate = new Promise(r => (open = r))
  queue = [{ deltas: [{ reasoning: 'thinking ' }, { content: 'hi' }], content: 'hi' }]
  const r = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: config(), task: 't', workdir }) })
  const { runId } = await r.json()
  // Release send() only once this client has seen llm_request over SSE: by then its listener is registered and the replay is over.
  const live = await sse(runId, e => { if (e.type === 'llm_request') open(); return e.type === 'done' })
  gate = Promise.resolve()
  const i = live.findIndex(e => e.type === 'delta')
  expect(live.slice(i, i + 3)).toEqual([{ type: 'delta', reasoning: 'thinking ' }, { type: 'delta', content: 'hi' }, expect.objectContaining({ type: 'llm_response', content: 'hi' })])
  expect(await readFile(join(runsDir, `${runId}.jsonl`), 'utf8')).not.toContain('"delta"')
  expect((await collectSSE(`${base}/api/runs/${runId}/events`)).some(e => e.type === 'delta')).toBe(false)
})

test('a run file with a truncated last line still opens instead of 404', async () => {
  const id = 'trunc123'
  await writeFile(join(runsDir, `${id}.jsonl`),
    JSON.stringify({ meta: { id, harness: 'h', task: 't', workdir: '/tmp', started: 1 } }) + '\n' +
    JSON.stringify({ seq: 0, turn: 0, ts: 1, type: 'llm_request', payload: {} }) + '\n' +
    '{"seq":1,"turn":0,"ts":2,"type":"tool_c')
  const events = await collectSSE(`${base}/api/runs/${id}/events`)
  expect(events.map(e => e.type)).toEqual(['llm_request', 'done'])
  expect(events.at(-1).reason).toBe('aborted')
})

test('GET /api/bench lists bench files newest first and skips everything else', async () => {
  const r = await fetch(`${bbase}/api/bench`)
  expect(r.status).toBe(200)
  const { files } = await r.json()
  expect(files.map((f: any) => f.file)).toEqual(['b2.json', 'b1.json'])
  expect(files[0]).toEqual({ file: 'b2.json', date: '2026-09-13T11:00:00.000Z', model: 'fake-model', complete: true })
})

test('GET /api/bench?file= returns the result and the one live trace that belongs to it', async () => {
  const r = await (await fetch(`${bbase}/api/bench?file=b1.json`)).json()
  expect(r.result.n).toBe(2)
  expect(r.files.map((f: any) => f.file)).toEqual(['b2.json', 'b1.json'])
  expect(r.active).toMatchObject({ id: 'live0001', harness: 'tuned', round: 2, started: B1_STARTED })
  // the half-written line is dropped, the meta line never reaches events (it has no `turn` and would break Trace.vue)
  expect(r.active.events.map((e: any) => e.type)).toEqual(['llm_request', 'approval_required'])
})

test('GET /api/bench?file= skips the live-trace lookup once the bench is complete', async () => {
  const r = await (await fetch(`${bbase}/api/bench?file=b2.json`)).json()
  expect(r.result.complete).toBe(true)
  expect(r.active).toBeUndefined()
})

test('GET /api/bench?file= validates the name and 404s on anything that is not a bench', async () => {
  expect((await fetch(`${bbase}/api/bench?file=..`)).status).toBe(400)
  expect((await fetch(`${bbase}/api/bench?file=b1`)).status).toBe(400)
  expect((await fetch(`${bbase}/api/bench?file=nope.json`)).status).toBe(404)
  expect((await fetch(`${bbase}/api/bench?file=notbench.json`)).status).toBe(404)
  expect((await (await fetch(`${bbase}/api/bench?file=nope.json`)).json()).error).toBe('not a bench file')
})
