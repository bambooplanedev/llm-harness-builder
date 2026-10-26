import { test, expect, afterAll } from 'vitest'
import { writeFile, readFile, appendFile, realpath, stat, cp, chmod, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { startServer } from '../src/server/index.js'
import viteConfig from '../web/vite.config.js'
import type { HarnessConfig } from '../src/core/config.js'
import { fakeBackend, harness, tmp, type FakeResponse } from './helpers.js'
import { notesKey, notesPath, readNotes } from '../src/core/notes.js'

const fake = fakeBackend
// Every run here goes through bash with an approval; maxTurns 3 keeps a runaway test short.
const config = (over: Partial<HarnessConfig> = {}) =>
  harness({ tools: { enabled: ['bash'], approveBash: true }, context: { maxToolOutputChars: 100, budgetTokens: 0 }, loop: { maxTurns: 3 }, ...over })

const runsDir = await tmp('lhb-runs-')
process.env.LHB_NOTES_DIR = await tmp('lhb-notes-')
const harnessesDir = await tmp('lhb-h-')
const workdir = await tmp('lhb-wd-')
let queue: FakeResponse[] = []
const srv = await startServer({ port: 0, runsDir, harnessesDir, backendFactory: () => fake(queue) })
const base = `http://127.0.0.1:${srv.port}`
afterAll(() => srv.close())

// --- bench page: its own runs dir, so hand-written fixtures never mix with the real runs above
const benchDir = await tmp('lhb-bench-')
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
// isolates the date-floor clause: its only .part is a stale orphan, started before b3.json's own date
await writeFile(join(benchDir, 'b3.json'), benchJson({ date: '2026-09-13T13:00:00.000Z', complete: false }))
// a harness entry with no config is garbage, not a bench: skipped silently like every other malformed file
await writeFile(join(benchDir, 'emptyharness.json'), JSON.stringify({ version: 1, date: '2026-09-13T09:00:00.000Z', complete: false, harnesses: [{}] }))
// a name safeName rejects (space): newest date of all, so it would sort first if it were listed at all
await writeFile(join(benchDir, 'bad name.json'), benchJson({ date: '2026-09-13T15:00:00.000Z' }))

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
// b3.json's only .part: a stale orphan started before the bench's own date, testing the floor in isolation
await part('stale003', { bench: { file: 'b3.json', round: 1 }, started: Date.parse('2026-09-13T12:00:00Z') }, [])

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
  // Parked on the approval: the UI's Abort must work here even if the page reloaded and lost
  // track of which run it started itself, so /api/runs must say this one is still active.
  const parked = await (await fetch(`${base}/api/runs`)).json()
  expect(parked.find((s: any) => s.id === runId)).toMatchObject({ active: true })
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
  expect(list.find((s: any) => s.id === runId)).toMatchObject({ harness: 'h', reason: 'final', toolCallCount: 1, active: false })
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
test('host/origin checks: a local Host, and from a browser only a page of this same server', async () => {
  expect(await rawStatus({ host: 'evil.com' })).toBe(403)
  expect(await rawStatus({ host: '127.0.0.1', origin: 'http://evil.com' })).toBe(403)
  // another port of localhost is another origin: a dev server or any local app could otherwise drive serve
  expect(await rawStatus({ host: `localhost:${srv.port}`, origin: 'http://localhost:5173' })).toBe(403)
  expect(await rawStatus({ host: `127.0.0.1:${srv.port}`, origin: `http://localhost:${srv.port}` })).toBe(403)
  expect(await rawStatus({ host: `localhost:${srv.port}`, origin: `https://localhost:${srv.port}` })).toBe(403)
  expect(await rawStatus({ host: `localhost:${srv.port}`, origin: 'null' })).toBe(403)
  expect(await rawStatus({ host: `localhost:${srv.port}`, origin: `http://localhost:${srv.port}` })).toBe(200)
  // the Vite dev proxy keeps the browser's Host, so its Origin matches it
  expect(await rawStatus({ host: 'localhost:5173', origin: 'http://localhost:5173' })).toBe(200)
  expect(await rawStatus({ host: 'localhost:9' })).toBe(200)
})

/** A request with headers fetch would not let us set: Host and Origin. */
const rawReq = (method: string, path: string, headers: Record<string, string>, body = '', port = srv.port) => new Promise<number>(resolve => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => { res.resume(); resolve(res.statusCode!) })
  req.end(body)
})

test('a page on another localhost port cannot PUT a harness or start a run, not even with a text/plain body', async () => {
  const headers = { host: `localhost:${srv.port}`, origin: 'http://localhost:9999', 'content-type': 'text/plain' }
  expect(await rawReq('PUT', '/api/harnesses/csrf', headers, JSON.stringify(config({ name: 'csrf' })))).toBe(403)
  expect(await rawReq('POST', '/api/runs', headers, JSON.stringify({ config: config(), task: 't', workdir }))).toBe(403)
})

// Vite's string form ('/api': url) sets changeOrigin and rewrites Host to the target, so the dev UI's Origin never
// matched it and every POST from the dev UI was refused: the object form below keeps the browser's Host.
test('the Vite dev proxy keeps the browser\'s Host, or serve would refuse every POST from the dev UI', () => {
  expect(viteConfig.server?.proxy?.['/api']).toMatchObject({ target: 'http://127.0.0.1:7331', changeOrigin: false })
})

test('harnesses and models', async () => {
  await writeFile(join(harnessesDir, 'x.json'), JSON.stringify(config({ name: 'x' })))
  expect(await (await fetch(`${base}/api/harnesses`)).json()).toEqual([{ name: 'x' }])
  await writeFile(join(harnessesDir, 'z.json'), JSON.stringify(config({ name: 'z', description: 'says what it is for' })))
  await writeFile(join(harnessesDir, 'broken.json'), '{')
  const listing = await (await fetch(`${base}/api/harnesses`)).json()
  expect(listing).toContainEqual({ name: 'z', description: 'says what it is for' })
  expect(listing).toContainEqual({ name: 'broken' })
  const put = await fetch(`${base}/api/harnesses/y`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config({ name: 'y' })) })
  expect(put.status).toBe(200)
  expect((await (await fetch(`${base}/api/harnesses/y`)).json()).name).toBe('y')
  const listed = await fetch(`${base}/api/models`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'openai', baseUrl: 'http://x/v1' }) })
  expect(await listed.json()).toEqual(['fake-model'])
})

test('/api/models on a server that does not answer says what to do', async () => {
  const real = await startServer({ port: 0, runsDir, harnessesDir })
  try {
    const r = await fetch(`http://127.0.0.1:${real.port}/api/models`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ollama', baseUrl: 'http://127.0.0.1:1' }) })
    expect(r.status).toBe(502)
    const { error } = await r.json()
    expect(error).toContain('does not answer'); expect(error).toContain('ollama serve')
  } finally { await real.close() }
})

test('concurrent POST /api/runs for the same workdir: exactly one 201, one 409', async () => {
  const wd = await tmp('lhb-wd-race-')
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
  const wd = await tmp('lhb-wd-bad-lei-')
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
  let open!: () => void
  queue = [{ deltas: [{ reasoning: 'thinking ' }, { content: 'hi' }], content: 'hi', wait: new Promise(r => (open = r)) }]
  const r = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: config(), task: 't', workdir }) })
  const { runId } = await r.json()
  // Release send() only once this client has seen llm_request over SSE: by then its listener is registered and the replay is over.
  const live = await sse(runId, e => { if (e.type === 'llm_request') open(); return e.type === 'done' })
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
  expect(files.map((f: any) => f.file)).toEqual(['b3.json', 'b2.json', 'b1.json'])
  expect(files[1]).toEqual({ file: 'b2.json', date: '2026-09-13T11:00:00.000Z', model: 'fake-model', complete: true })
})

test('GET /api/bench?file= on a version:1 file whose harness has no config is a 404, not a listed file', async () => {
  const r = await fetch(`${bbase}/api/bench?file=emptyharness.json`)
  expect(r.status).toBe(404)
})

test('GET /api/bench on a runs dir that does not exist yet returns 200 with no files', async () => {
  const fresh = await startServer({ port: 0, runsDir: join(tmpdir(), 'nope-' + Date.now()), harnessesDir, backendFactory: () => fake([]) })
  expect(await (await fetch(`http://127.0.0.1:${fresh.port}/api/bench`)).json()).toEqual({ files: [] })
  await fresh.close()
})

test('GET /api/bench?file= returns the result and the one live trace that belongs to it', async () => {
  const r = await (await fetch(`${bbase}/api/bench?file=b1.json`)).json()
  expect(r.result.n).toBe(2)
  expect(r.files.map((f: any) => f.file)).toEqual(['b3.json', 'b2.json', 'b1.json'])
  expect(r.active).toMatchObject({ id: 'live0001', harness: 'tuned', round: 2, started: B1_STARTED })
  // the half-written line is dropped, the meta line never reaches events (it has no `turn` and would break Trace.vue)
  expect(r.active.events.map((e: any) => e.type)).toEqual(['llm_request', 'approval_required'])
})

test('GET /api/bench reads a bench JSON again once it changed on disk, a file that was not a bench included', async () => {
  const dir = await tmp('lhb-bench-cache-')
  const s = await startServer({ port: 0, runsDir: dir, harnessesDir, backendFactory: () => fake([]) })
  const get = async (q = '') => (await fetch(`http://127.0.0.1:${s.port}/api/bench${q}`)).json()
  await writeFile(join(dir, 'c.json'), benchJson())
  await writeFile(join(dir, 'later.json'), '{half')
  expect((await get('?file=c.json')).result.n).toBe(2)
  expect((await get()).files.map((f: any) => f.file)).toEqual(['c.json'])
  await writeFile(join(dir, 'c.json'), benchJson({ n: 3, complete: true }))
  await writeFile(join(dir, 'later.json'), benchJson({ date: '2026-09-14T10:00:00.000Z' }))
  expect((await get('?file=c.json')).result).toMatchObject({ n: 3, complete: true })
  expect((await get()).files.map((f: any) => f.file)).toEqual(['later.json', 'c.json'])
  await s.close()
})

test('GET /api/bench?file= ignores a .part started before the bench (the date floor)', async () => {
  const r = await (await fetch(`${bbase}/api/bench?file=b3.json`)).json()
  expect(r.result).toBeDefined()
  expect(r.active).toBeUndefined()
})

test('GET /api/bench?file= skips the live-trace lookup once the bench is complete', async () => {
  const r = await (await fetch(`${bbase}/api/bench?file=b2.json`)).json()
  expect(r.result.complete).toBe(true)
  expect(r.active).toBeUndefined()
})

test('GET /api/bench?file= validates the name and 404s on anything that is not a bench', async () => {
  expect((await fetch(`${bbase}/api/bench?file=..`)).status).toBe(400)
  expect((await fetch(`${bbase}/api/bench?file=b1`)).status).toBe(400)
  expect((await fetch(`${bbase}/api/bench?file=${encodeURIComponent('../b.json')}`)).status).toBe(400)
  expect((await fetch(`${bbase}/api/bench?file=nope.json`)).status).toBe(404)
  expect((await fetch(`${bbase}/api/bench?file=notbench.json`)).status).toBe(404)
  expect((await (await fetch(`${bbase}/api/bench?file=nope.json`)).json()).error).toBe('not a bench file')
})

test('GET /api/bench?file= carries an analysis per finished trace, keyed by trace id; a hostile trace id is never read', async () => {
  const line = (o: object) => JSON.stringify(o)
  const traceLines = [
    line({ meta: { id: 'anal0001', harness: 'tuned', task: 't', workdir: '/w', started: 1 } }),
    line({ seq: 0, turn: 1, ts: 0, type: 'llm_request', payload: { messages: [{ role: 'user', content: 'do' }] } }),
    line({ seq: 1, turn: 1, ts: 0, type: 'tool_call', call: { callId: 'c1', name: 'edit_file', args: { path: 'a.txt' } } }),
    line({ seq: 2, turn: 1, ts: 0, type: 'tool_result', callId: 'c1', name: 'edit_file', output: 'edited a.txt' }),
    line({ seq: 3, turn: 1, ts: 0, type: 'done', reason: 'final', turns: 1, toolCallCount: 1 }),
  ]
  await writeFile(join(benchDir, 'anal0001.jsonl'), traceLines.join('\n') + '\n')
  const b = JSON.parse(benchJson({ date: '2026-09-13T16:00:00.000Z', complete: true }))
  const run = { round: 1, verdict: 'PASS', reason: 'final', turns: 1, toolCalls: 1, parseErrors: 0, ms: 1, workdir: '/w' }
  b.harnesses[0].runs = [{ ...run, trace: 'anal0001' }, { ...run, round: 2, trace: '../../etc/passwd' }, { ...run, round: 3, trace: 'missing1' }]
  await writeFile(join(benchDir, 'banal.json'), JSON.stringify(b))
  const r = await (await fetch(`${bbase}/api/bench?file=banal.json`)).json()
  expect(r.analysis).toEqual({ anal0001: { stub: '—', ate: '—', edit: 't1', loop: '—', reread: '—' } })
})

test('the analysis cache is keyed by size: same size is not re-read, a grown trace is', async () => {
  const get = async () => (await (await fetch(`${bbase}/api/bench?file=banal.json`)).json()).analysis.anal0001
  const file = join(benchDir, 'anal0001.jsonl')
  const text = await readFile(file, 'utf8')
  await writeFile(file, text.replace('"turn":1,"ts":0,"type":"tool_result"', '"turn":2,"ts":0,"type":"tool_result"')) // same length
  expect((await get()).edit).toBe('t1')   // cached
  await appendFile(file, JSON.stringify({ seq: 9, turn: 3, ts: 0, type: 'tool_call', call: { callId: 'c9', name: 'read_file', args: { path: 'x' } } }) + '\n')
  expect((await get()).edit).toBe('t2')   // re-read after it grew
})

// Final review: an untrusted bench JSON with a non-string trace or a null run must not take the whole file down.
test('GET /api/bench?file= with a malformed run still opens the bench; the bad rows get no analysis', async () => {
  const b = JSON.parse(benchJson({ date: '2026-09-13T08:00:00.000Z', complete: true }))
  const run = { round: 1, verdict: 'PASS', reason: 'final', turns: 1, toolCalls: 1, parseErrors: 0, ms: 1, workdir: '/w' }
  b.harnesses[0].runs = [{ ...run, trace: 5 }, null, { ...run, trace: true }]
  await writeFile(join(benchDir, 'bweird.json'), JSON.stringify(b))
  const r = await fetch(`${bbase}/api/bench?file=bweird.json`)
  expect(r.status).toBe(200)
  expect((await r.json()).analysis).toEqual({})
})

test('PUT of a harness with tools.bashEnv is accepted and comes back as it was', async () => {
  const c = config({ name: 'envy', tools: { enabled: ['bash'], approveBash: true, bashEnv: ['GITHUB_TOKEN'] } })
  const put = await fetch(`${base}/api/harnesses/envy`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
  expect(put.status).toBe(200)
  expect((await (await fetch(`${base}/api/harnesses/envy`)).json()).tools.bashEnv).toEqual(['GITHUB_TOKEN'])
})

const postJson = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('models: POST with the backend fields, the factory gets apiKeyEnv, a missing variable or a bad name is a 400, GET is gone', async () => {
  const got: HarnessConfig['backend'][] = []
  const s = await startServer({ port: 0, runsDir, harnessesDir, backendFactory: b => { got.push(b); return fake([]) } })
  const u = `http://127.0.0.1:${s.port}`
  const body = { kind: 'openai', baseUrl: 'https://or.example/v1', apiKeyEnv: 'LHB_SRV_TEST_API_KEY' }
  try {
    process.env.LHB_SRV_TEST_API_KEY = 'sk-or-v1-' + '9'.repeat(32)
    const ok = await postJson(`${u}/api/models`, body)
    expect(ok.status).toBe(200); expect(await ok.json()).toEqual(['fake-model'])
    expect(got[0]).toMatchObject(body)
    delete process.env.LHB_SRV_TEST_API_KEY
    const unset = await postJson(`${u}/api/models`, body)
    expect(unset.status).toBe(400)
    expect(await unset.json()).toEqual({ errors: ['backend.apiKeyEnv: LHB_SRV_TEST_API_KEY is not set in the environment serve was started from'] })
    const badName = await postJson(`${u}/api/models`, { ...body, apiKeyEnv: 'GITHUB_TOKEN' })
    expect(await badName.json()).toEqual({ errors: ['backend.apiKeyEnv must be an upper-case variable name ending in _API_KEY (like OPENROUTER_API_KEY)'] })
    expect((await fetch(`${u}/api/models?kind=openai&baseUrl=http://x/v1`)).status).toBe(404)
    // a page on another localhost port: refused before anything is asked of the factory
    const foreign = await rawReq('POST', '/api/models', { host: `localhost:${s.port}`, origin: 'http://localhost:9999', 'content-type': 'text/plain' }, JSON.stringify({ ...body, baseUrl: 'https://evil.example/v1' }), s.port)
    expect(foreign).toBe(403); expect(got).toHaveLength(1)
  } finally { await s.close(); delete process.env.LHB_SRV_TEST_API_KEY }
})

test('models through the real backend: the upstream sees the bearer token; a failing upstream\'s body comes back with the key redacted', async () => {
  const KEYV = 'sk-or-v1-' + '7'.repeat(32)
  const seen: string[] = []
  let fail = false
  const up = http.createServer((q, r) => {
    seen.push(String(q.headers.authorization))
    if (fail) { r.writeHead(500); return void r.end(`echo ${q.headers.authorization}`) }
    r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ data: [{ id: 'm1' }] }))
  })
  await new Promise<void>(r => up.listen(0, '127.0.0.1', r))
  const s = await startServer({ port: 0, runsDir, harnessesDir })
  process.env.LHB_SRV_REAL_API_KEY = KEYV
  try {
    const body = { kind: 'openai', baseUrl: `http://127.0.0.1:${(up.address() as { port: number }).port}/v1`, apiKeyEnv: 'LHB_SRV_REAL_API_KEY' }
    expect(await (await postJson(`http://127.0.0.1:${s.port}/api/models`, body)).json()).toEqual(['m1'])
    expect(seen).toEqual([`Bearer ${KEYV}`])
    fail = true
    const bad = await postJson(`http://127.0.0.1:${s.port}/api/models`, body)
    expect(bad.status).toBe(502)
    const j = await bad.json()
    expect(j.body).toBe('echo Bearer [redacted: LHB_SRV_REAL_API_KEY]')
    expect(JSON.stringify(j)).not.toContain(KEYV)
  } finally { await s.close(); up.close(); delete process.env.LHB_SRV_REAL_API_KEY }
})

test('a run whose key variable is not set in serve\'s environment is a 400 that says so; set, it starts; a harness with a key saves either way', async () => {
  const keyedCfg = config({ backend: { ...harness().backend, baseUrl: 'https://or.example/v1', apiKeyEnv: 'LHB_SRV_RUN_API_KEY' } })
  const put = await fetch(`${base}/api/harnesses/keyed`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(keyedCfg) })
  expect(put.status).toBe(200)
  const start = async () => postJson(`${base}/api/runs`, { config: keyedCfg, task: 't', workdir: await tmp('lhb-wd-key-') })
  const refused = await start()
  expect(refused.status).toBe(400)
  expect(await refused.json()).toEqual({ errors: ['backend.apiKeyEnv: LHB_SRV_RUN_API_KEY is not set in the environment serve was started from'] })
  process.env.LHB_SRV_RUN_API_KEY = 'sk-or-v1-' + '5'.repeat(32)
  try {
    queue = [{ content: 'fin' }]
    const ok = await start()
    expect(ok.status).toBe(201)
    const { runId } = await ok.json()
    expect((await collectSSE(`${base}/api/runs/${runId}/events`)).at(-1)).toMatchObject({ type: 'done', reason: 'final' })
  } finally { delete process.env.LHB_SRV_RUN_API_KEY }
})

test('a throw that escapes the run is recorded with the key redacted', async () => {
  const KEYV = 'sk-or-v1-' + '3'.repeat(32)
  process.env.LHB_SRV_THROW_API_KEY = KEYV
  const s = await startServer({ port: 0, runsDir, harnessesDir, backendFactory: () => ({ ...fake([]), buildPayload: () => { throw new Error(`boom ${KEYV}`) } }) })
  try {
    const cfg = config({ backend: { ...harness().backend, baseUrl: 'https://or.example/v1', apiKeyEnv: 'LHB_SRV_THROW_API_KEY' } })
    const r = await postJson(`http://127.0.0.1:${s.port}/api/runs`, { config: cfg, task: 't', workdir: await tmp('lhb-wd-throw-') })
    const { runId } = await r.json()
    const events = await collectSSE(`http://127.0.0.1:${s.port}/api/runs/${runId}/events`)
    expect(events.find(e => e.type === 'error')).toMatchObject({ message: 'boom [redacted: LHB_SRV_THROW_API_KEY]' })
    expect(JSON.stringify(events)).not.toContain(KEYV)
  } finally { await s.close(); delete process.env.LHB_SRV_THROW_API_KEY }
})

test('a key typed into the task is redacted in the run file\'s first line and in the run listing', async () => {
  const KEYV = 'sk-or-v1-' + '4'.repeat(31) // 40 characters, made up
  process.env.LHB_SRV_TASK_API_KEY = KEYV
  try {
    const cfg = config({ backend: { ...harness().backend, baseUrl: 'https://or.example/v1', apiKeyEnv: 'LHB_SRV_TASK_API_KEY' } })
    queue = [{ content: 'fin' }]
    const r = await postJson(`${base}/api/runs`, { config: cfg, task: `use ${KEYV}`, workdir: await tmp('lhb-wd-task-') })
    expect(r.status).toBe(201)
    const { runId } = await r.json()
    expect((await collectSSE(`${base}/api/runs/${runId}/events`)).at(-1)).toMatchObject({ type: 'done', reason: 'final' })
    const first = (await readFile(join(runsDir, `${runId}.jsonl`), 'utf8')).split('\n')[0]
    expect(first).toContain('[redacted: LHB_SRV_TASK_API_KEY]'); expect(first).not.toContain(KEYV)
    expect(JSON.parse(first).meta.task).toBe('use [redacted: LHB_SRV_TASK_API_KEY]')
    const listed = await (await fetch(`${base}/api/runs`)).text()
    expect(listed).toContain('use [redacted: LHB_SRV_TASK_API_KEY]'); expect(listed).not.toContain(KEYV)
  } finally { delete process.env.LHB_SRV_TASK_API_KEY }
})

test('model-info: POST with the backend fields and a model gives what the server says the model takes; a missing variable is a 400; a failing backend is a 502 with the key redacted', async () => {
  const KEYV = 'sk-ant-' + '3'.repeat(32)
  const asked: string[] = []
  let fail = false
  const s = await startServer({ port: 0, runsDir, harnessesDir, backendFactory: () => ({
    ...fake([]),
    serverInfo: async (model: string) => {
      asked.push(model)
      if (fail) throw new Error(`upstream echoed ${KEYV}`)
      return { nCtx: 200000, maxOutput: 64000, build: 'b', takes: { temperature: false }, takesFrom: 'anthropic models list' }
    },
  }) })
  const u = `http://127.0.0.1:${s.port}`
  const body = { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-x', apiKeyEnv: 'LHB_SRV_INFO_API_KEY' }
  try {
    const unset = await postJson(`${u}/api/model-info`, body)
    expect(unset.status).toBe(400)
    expect(await unset.json()).toEqual({ errors: ['backend.apiKeyEnv: LHB_SRV_INFO_API_KEY is not set in the environment serve was started from'] })
    expect((await postJson(`${u}/api/model-info`, { ...body, model: '' })).status).toBe(400)
    process.env.LHB_SRV_INFO_API_KEY = KEYV
    const ok = await postJson(`${u}/api/model-info`, body)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ nCtx: 200000, maxOutput: 64000, takes: { temperature: false }, takesFrom: 'anthropic models list' })
    expect(asked).toEqual(['claude-x'])
    fail = true
    const bad = await postJson(`${u}/api/model-info`, body)
    expect(bad.status).toBe(502)
    const j = JSON.stringify(await bad.json())
    expect(j).toContain('[redacted: LHB_SRV_INFO_API_KEY]'); expect(j).not.toContain(KEYV)
    expect((await fetch(`${u}/api/model-info`)).status).toBe(404)
  } finally { await s.close(); delete process.env.LHB_SRV_INFO_API_KEY }
})

test('GET /api/dirs lists subfolders by name and full path, no files, no dot folders', async () => {
  const { mkdir } = await import('node:fs/promises')
  const d = await tmp('lhb-dirs-')
  await mkdir(join(d, 'b')); await mkdir(join(d, 'a')); await mkdir(join(d, '.git')); await writeFile(join(d, 'f.txt'), '')
  const r = await (await fetch(`${base}/api/dirs?path=${encodeURIComponent(d)}`)).json()
  expect(r.path).toBe(d)
  expect(r.dirs).toEqual([{ name: 'a', path: join(d, 'a') }, { name: 'b', path: join(d, 'b') }])
  expect(r.parent).toBe(join(d, '..'))
  expect((await fetch(`${base}/api/dirs?path=${encodeURIComponent(join(d, 'nope'))}`)).status).toBe(400)
})

test('POST /api/bench/again starts bench from the JSON\'s own harnesses and answers once the new JSON exists; a bench that dies first is its stderr', async () => {
  const { spawn } = await import('node:child_process')
  const got: { args: string[]; configs: unknown[] }[] = []
  let script = ''
  const s = await startServer({ port: 0, runsDir: benchDir, harnessesDir, backendFactory: () => fake([]), bench: args => {
    // the harness files go away once the bench exits: read them now
    got.push({ args, configs: args.filter(a => !a.startsWith('--')).map(f => JSON.parse(require('node:fs').readFileSync(f, 'utf8'))) })
    const out = args.find(a => a.startsWith('--out='))!.slice(6)
    return spawn(process.execPath, ['-e', script.replace('OUT', JSON.stringify(out))], { stdio: ['ignore', 'ignore', 'pipe'] })
  } })
  const u = `http://127.0.0.1:${s.port}`
  try {
    script = `require('fs').writeFileSync(OUT, '{}'); setTimeout(() => {}, 300)`
    const ok = await postJson(`${u}/api/bench/again`, { file: 'b1.json' })
    expect(ok.status).toBe(201)
    const { file } = await ok.json()
    expect(file).toMatch(/^bench-\d{8}-\d{6}(-\d+)?\.json$/)
    expect(got[0].args.slice(0, 4)).toEqual(['--task=slug', '--n=2', '--timeout=60', `--out=${join(benchDir, file)}`])
    expect(got[0].configs).toEqual([config()])
    // one at a time: the first one still runs
    expect((await postJson(`${u}/api/bench/again`, { file: 'b1.json' })).status).toBe(409)
    await new Promise(r => setTimeout(r, 400))
    script = `console.error('preflight: http://x: connection refused'); process.exit(2)`
    const bad = await postJson(`${u}/api/bench/again`, { file: 'b1.json' })
    expect(bad.status).toBe(502)
    expect((await bad.json()).error).toBe('preflight: http://x: connection refused')
    expect((await postJson(`${u}/api/bench/again`, { file: '../b1.json' })).status).toBe(400)
    expect((await postJson(`${u}/api/bench/again`, { file: 'notbench.json' })).status).toBe(404)
    // a server that was not given a way to start one has no such route
    expect((await postJson(`${base}/api/bench/again`, { file: 'b1.json' })).status).toBe(404)
  } finally { await s.close() }
})

test('Create demo project: a slug workdir under tmp, and Check runs its tests only there', async () => {
  const r = await fetch(`${base}/api/demo`, { method: 'POST' })
  expect(r.status).toBe(201)
  const { workdir: demo } = await r.json()
  expect(demo.startsWith(await realpath(tmpdir()))).toBe(true)
  expect((await stat(join(demo, 'data', 'app.log'))).isFile()).toBe(true)
  const check = (wd: unknown, c: unknown = config()) => postJson(`${base}/api/demo/check`, { workdir: wd, config: c })
  const fail = await check(demo)
  expect(fail.status).toBe(200)
  expect(await fail.json()).toEqual({ verdict: 'FAIL' }) // the shipped bug is still there
  const other = await check(workdir)
  expect(other.status).toBe(404)
  expect(await other.json()).toEqual({ error: 'not a demo project this server created' })
  expect((await check(join(demo, 'missing'))).status).toBe(404)
  expect((await check(demo, {})).status).toBe(400)
})

test('a page of another origin can neither create a demo project nor run Check', async () => {
  const headers = { host: `localhost:${srv.port}`, origin: 'http://evil.example', 'content-type': 'text/plain' }
  expect(await rawReq('POST', '/api/demo', headers)).toBe(403)
  expect(await rawReq('POST', '/api/demo/check', headers, JSON.stringify({ workdir, config: config() }))).toBe(403)
})

/** A server whose bench is `node -e <script>`, OUT = its --out; `children` holds every one it started. */
async function benchServer(script: () => string) {
  const { spawn } = await import('node:child_process')
  const runs = await tmp('lhb-new-runs-'), hdir = await tmp('lhb-new-h-')
  const got: string[][] = [], children: import('node:child_process').ChildProcess[] = []
  const s = await startServer({ port: 0, runsDir: runs, harnessesDir: hdir, backendFactory: () => fake([]), bench: args => {
    got.push(args)
    const out = args.find(a => a.startsWith('--out='))!.slice(6)
    const c = spawn(process.execPath, ['-e', script().replace('OUT', JSON.stringify(out))], { stdio: ['ignore', 'ignore', 'pipe'] })
    children.push(c); return c
  } })
  return { s, u: `http://127.0.0.1:${s.port}`, runs, hdir, got, children }
}
const exited = (c: import('node:child_process').ChildProcess) => c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise(r => c.once('exit', r))
const form = { kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }

test('POST /api/bench/new validates and passes only what it checked', async () => {
  const b = await benchServer(() => `require('fs').writeFileSync(OUT, '{}'); setTimeout(() => {}, 200)`)
  await writeFile(join(b.hdir, 'tuned.json'), JSON.stringify(config({ name: 'tuned' })))
  await writeFile(join(b.hdir, 'keyed.json'), JSON.stringify(config({ name: 'keyed', backend: { ...config().backend, apiKeyEnv: 'X_API_KEY' } })))
  const ok = { harnesses: ['tuned'], task: 'slug', n: 2, backend: form }
  const post = (over: object) => postJson(`${b.u}/api/bench/new`, { ...ok, ...over })
  process.env.LHB_NEW_SET_API_KEY = 'k'.repeat(24)
  try {
    for (const bad of [{ harnesses: ['../x'] }, { harnesses: [5] }, { harnesses: ['nope'] }, { harnesses: [] }, { task: 'nope' }, { size: 2 }, { n: 0 }, { n: 51 }, { n: 1.5 },
      { task: 'pool', size: 0 }, { task: 'polyglot' }, { task: 'polyglot', size: 49 }, { backend: { ...form, kind: 'x' } }, { backend: { ...form, model: '' } }, { backend: { ...form, apiKeyEnv: 'LHB_NEW_UNSET_API_KEY' } }]) {
      const r = await post(bad)
      expect(r.status, JSON.stringify(bad)).toBe(400)
      expect((await r.json()).errors.length).toBeGreaterThan(0)
    }
    const keyed = await post({ harnesses: ['keyed'] })
    expect(keyed.status).toBe(400)
    expect((await keyed.json()).errors).toEqual(["keyed: its backend.apiKeyEnv differs from the form's"])
    expect(b.got).toEqual([])
    const r = await post({ harnesses: ['tuned', 'tuned'], evil: '--yes', backend: { ...form, extra: '--out=/x' } })
    expect(r.status).toBe(201)
    const { file } = await r.json()
    expect(b.got).toEqual([['--task=slug', '--n=2', '--model=m', '--base-url=http://127.0.0.1:9/v1', '--kind=openai', `--out=${join(b.runs, file)}`, join(b.hdir, 'tuned.json')]])
    await exited(b.children[0])
    // the form's key overrides the file's (--api-key-env), whether the file has none or another
    expect((await post({ task: 'pool', size: 3, backend: { ...form, apiKeyEnv: 'LHB_NEW_SET_API_KEY' } })).status).toBe(201)
    await exited(b.children[1])
    expect((await post({ harnesses: ['keyed'], backend: { ...form, apiKeyEnv: 'LHB_NEW_SET_API_KEY' } })).status).toBe(201)
    expect(b.got[1].slice(0, 7)).toEqual(['--task=pool', '--size=3', '--n=2', '--model=m', '--base-url=http://127.0.0.1:9/v1', '--kind=openai', '--api-key-env=LHB_NEW_SET_API_KEY'])
    await exited(b.children[2])
    expect((await post({ task: 'polyglot', size: 5 })).status).toBe(201)
    expect(b.got[3].slice(0, 2)).toEqual(['--task=polyglot', '--size=5'])
    await exited(b.children[3])
    const headers = { host: `localhost:${b.s.port}`, origin: 'http://evil.example', 'content-type': 'text/plain' }
    expect(await rawReq('POST', '/api/bench/new', headers, JSON.stringify(ok), b.s.port)).toBe(403)
    expect(b.got[2]).toContain('--api-key-env=LHB_NEW_SET_API_KEY')
    expect(b.got).toHaveLength(4)
  } finally { await b.s.close(); delete process.env.LHB_NEW_SET_API_KEY }
})

test('POST /api/bench/stop signals only the bench this server started', async () => {
  const marker = join(await tmp('lhb-stop-'), 'got-sigint')
  let script = `require('fs').writeFileSync(OUT, '{}'); process.on('SIGINT', () => { require('fs').writeFileSync(${JSON.stringify(marker)}, ''); process.exit(130) }); setInterval(() => {}, 1000)`
  const b = await benchServer(() => script)
  await writeFile(join(b.hdir, 'tuned.json'), JSON.stringify(config({ name: 'tuned' })))
  const stop = () => fetch(`${b.u}/api/bench/stop`, { method: 'POST' })
  try {
    const none = await stop()
    expect(none.status).toBe(409)
    expect(await none.json()).toEqual({ error: 'no bench started from this page is running' })
    expect((await postJson(`${b.u}/api/bench/new`, { harnesses: ['tuned'], task: 'slug', n: 1, backend: form })).status).toBe(201)
    const headers = { host: `localhost:${b.s.port}`, origin: 'http://evil.example' }
    expect(await rawReq('POST', '/api/bench/stop', headers, '', b.s.port)).toBe(403)
    expect(b.children[0].exitCode).toBe(null)
    const r = await stop()
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ ok: true })
    await exited(b.children[0])
    expect(b.children[0].exitCode).toBe(130)
    expect((await stat(marker)).isFile()).toBe(true)
    expect((await stop()).status).toBe(409)
    // Stop while the start still waits for its JSON (preflight): a plain answer, not a raw 502
    script = `process.on('SIGINT', () => process.exit(130)); setInterval(() => {}, 1000)`
    const waiting = postJson(`${b.u}/api/bench/new`, { harnesses: ['tuned'], task: 'slug', n: 1, backend: form })
    while (b.children.length < 2) await new Promise(r => setTimeout(r, 20))
    expect((await stop()).status).toBe(200)
    const w = await waiting
    expect(w.status).toBe(502)
    expect(await w.json()).toEqual({ error: 'stopped before it started' })
  } finally { for (const c of b.children) c.kill('SIGKILL'); await b.s.close() }
})

test('GET /api/bench?file= on a stopped bench shows no live run, though its .part is still there', async () => {
  const dir = await tmp('lhb-stopped-')
  const s = await startServer({ port: 0, runsDir: dir, harnessesDir, backendFactory: () => fake([]) })
  try {
    await writeFile(join(dir, 'b4.json'), benchJson({ stopped: true }))
    await writeFile(join(dir, 'live0004.jsonl.part'), [JSON.stringify({ meta: { id: 'live0004', harness: 'tuned', task: 't', workdir: '/tmp/wd', started: B1_STARTED, bench: { file: 'b4.json', round: 1 } } }),
      JSON.stringify({ seq: 0, turn: 0, ts: B1_STARTED + 1000, type: 'llm_request', payload: {} })].join('\n') + '\n')
    const r = await (await fetch(`http://127.0.0.1:${s.port}/api/bench?file=b4.json`)).json()
    expect(r.result.stopped).toBe(true)
    expect(r.active).toBeUndefined()
  } finally { await s.close() }
})

test('GET /api/bench names the bench this server started while it runs, so a reloaded page can still stop it', async () => {
  const b = await benchServer(() => `require('fs').writeFileSync(OUT, ${JSON.stringify(benchJson({ date: new Date().toISOString() }))}); process.on('SIGINT', () => process.exit(130)); setInterval(() => {}, 1000)`)
  await writeFile(join(b.hdir, 'tuned.json'), JSON.stringify(config({ name: 'tuned' })))
  try {
    expect((await (await fetch(`${b.u}/api/bench`)).json()).own).toBeUndefined()
    const { file } = await (await postJson(`${b.u}/api/bench/new`, { harnesses: ['tuned'], task: 'slug', n: 1, backend: form })).json()
    expect((await (await fetch(`${b.u}/api/bench`)).json()).own).toBe(file)
    expect((await (await fetch(`${b.u}/api/bench?file=${file}`)).json()).own).toBe(file)
    b.children[0].kill('SIGINT'); await exited(b.children[0])
    expect((await (await fetch(`${b.u}/api/bench`)).json()).own).toBeUndefined()
  } finally { for (const c of b.children) c.kill('SIGKILL'); await b.s.close() }
})

test('examples are served read-only', async () => {
  const ex = await tmp('lhb-ex-'), dir = await tmp('lhb-exruns-')
  await cp(fileURLToPath(new URL('../example-runs/', import.meta.url)), ex, { recursive: true })
  const snap = async () => Promise.all((await readdir(ex)).sort().map(async f => [f, (await stat(join(ex, f))).mtimeMs]))
  const files = (await readdir(ex)).map(f => join(ex, f))
  for (const f of files) await chmod(f, 0o444)
  await chmod(ex, 0o555)
  const before = await snap()
  const s = await startServer({ port: 0, runsDir: dir, harnessesDir, examplesDir: ex, backendFactory: () => fake([]) })
  const u = `http://127.0.0.1:${s.port}`
  try {
    const ids = ((await (await fetch(`${u}/api/runs?example=1`)).json()) as { id: string }[]).map(r => r.id).sort()
    expect(ids).toEqual(['059867d3', '590eb245', '6f1fb37b', 'd63e9548'])
    expect(await (await fetch(`${u}/api/runs`)).json()).toEqual([])
    const b = await (await fetch(`${u}/api/bench?example=1&file=bench-example.json`)).json()
    expect(b.result.harnesses.map((h: { name: string }) => h.name)).toEqual(['bare', 'tuned-nothink'])
    expect(Object.keys(b.analysis).sort()).toEqual(ids)
    expect((await (await fetch(`${u}/api/bench`)).json()).files).toEqual([])
    const events = await collectSSE(`${u}/api/runs/d63e9548/events?example=1`)
    expect(events.at(-1).type).toBe('done')
    expect((await fetch(`${u}/api/runs/d63e9548/events`)).status).toBe(404)
    expect(await snap()).toEqual(before)
    expect(await readdir(dir)).toEqual([])
  } finally { await s.close(); await chmod(ex, 0o755); for (const f of files) await chmod(f, 0o644) }
  // A trace with no done line at the end: opening it must not write one (ensureDone is for live runs only).
  const cut = await tmp('lhb-excut-'), cutFile = join(cut, 'd63e9548.jsonl')
  const lines = (await readFile(join(ex, 'd63e9548.jsonl'), 'utf8')).trimEnd().split('\n')
  expect(JSON.parse(lines.at(-1)!).type).toBe('done')
  await writeFile(cutFile, lines.slice(0, -1).join('\n') + '\n')
  await chmod(cutFile, 0o444); await chmod(cut, 0o555)
  const before2 = await stat(cutFile)
  const s2 = await startServer({ port: 0, runsDir: dir, harnessesDir, examplesDir: cut, backendFactory: () => fake([]) })
  try {
    await collectSSE(`http://127.0.0.1:${s2.port}/api/runs/d63e9548/events?example=1`)
    const after2 = await stat(cutFile)
    expect([after2.size, after2.mtimeMs]).toEqual([before2.size, before2.mtimeMs])
  } finally { await s2.close(); await chmod(cut, 0o755); await chmod(cutFile, 0o644) }
  // No examples folder given: the switch is a 404, never the runs dir.
  expect((await fetch(`${base}/api/runs?example=1`)).status).toBe(404)
})

test('a run with notes on: note_written comes over SSE before done, and the note is saved by folder', async () => {
  const wd = await tmp('lhb-wd-')
  queue = [{ content: 'done' }, { content: JSON.stringify({ notes: ['use npm test'] }) }]
  const r = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: config({ notes: { enabled: true, maxTokens: 400 } }), task: 't', workdir: wd }) })
  expect(r.status).toBe(201)
  const { runId } = await r.json()
  const all = await collectSSE(`${base}/api/runs/${runId}/events`)
  expect(all.map(e => e.type).slice(-2)).toEqual(['note_written', 'done'])
  const saved = await readNotes(notesPath(await notesKey(wd)))
  expect(saved.map(n => [n.text, n.run])).toEqual([['use npm test', runId]])
})

test('bench again refuses a bench on your own tasks', async () => {
  const dir = await tmp('lhb-bench-t-')
  await writeFile(join(dir, 'tasksbench.json'), benchJson({ taskName: 'tasks', tasksRepo: '/r' }))
  let started = false
  const s = await startServer({ port: 0, runsDir: dir, harnessesDir, backendFactory: () => fake([]), bench: () => { started = true; throw new Error('must not start') } })
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/api/bench/again`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: 'tasksbench.json' }) })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toBe('a bench on your own tasks runs again from the CLI: bench --tasks <repo>')
    expect(started).toBe(false)
  } finally { s.close() }
})
