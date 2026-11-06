import { test, expect, afterEach } from 'vitest'
import http from 'node:http'
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOwnConnection, loadOwnDialect, mergeConnections, mergeOwn } from '../src/core/proxy/own.js'
import { loadConnections, pickConnection } from '../src/core/proxy/connections.js'
import { DIALECTS } from '../src/core/proxy/dialects/index.js'
import { startProxy } from '../src/core/proxy/server.js'
import { tmpSync } from './helpers.js'

const NO_MESSAGES = fileURLToPath(new URL('./fixtures/dialects/no-messages.mjs', import.meta.url))
const cleanups: (() => unknown)[] = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

/** `files` written into a fresh tmp dir; returns the dir. */
const dir = (files: Record<string, string | object> = {}) => {
  const d = tmpSync('lhb-own-')
  for (const [f, v] of Object.entries(files)) writeFileSync(join(d, f), typeof v === 'string' ? v : JSON.stringify(v))
  return d
}
/** A dialect module; `over` replaces whole members by their source text. */
const dialectSrc = (over: Record<string, string> = {}) => {
  const m: Record<string, string> = {
    id: "'mine'", label: "'POST /x'", matches: '() => false',
    keyOf: "() => ({ key: 'k', taskText: 't', len: 0, model: '' })", toolResults: '() => []',
    readReply: "async () => ({ content: '', toolCalls: [] })", partial: 'async () => undefined', ...over,
  }
  return `export default { ${Object.entries(m).map(([k, v]) => `${k}: ${v}`).join(', ')} }\n`
}
const conn = (over: object = {}) => ({ name: 'mine', hints: { session: 'x-mine-session' }, taskStrip: [], ...over })

test('path refusals name the file', async () => {
  const d = dir({ 'x.js': dialectSrc(), 'y.txt': dialectSrc(), 'c.json': conn() })
  mkdirSync(join(d, 'sub.mjs'))
  symlinkSync(join(d, 'y.txt'), join(d, 'x.mjs'))
  await expect(loadOwnDialect('relative.mjs')).rejects.toThrow(/^dialect relative\.mjs: .*absolute/)
  for (const f of ['missing.mjs', 'sub.mjs', 'x.js#.mjs', 'x.mjs', 'c.json']) {
    const p = join(d, f)
    await expect(loadOwnDialect(p), f).rejects.toThrow(`dialect ${p}: `)
  }
  expect(() => loadOwnConnection('c.json')).toThrow(/^connection c\.json: .*absolute/)
  expect(() => loadOwnConnection(join(d, 'x.js'))).toThrow(`connection ${join(d, 'x.js')}: `)
})

test('dialect refusals', async () => {
  const d = dir({
    // Neutral names: a reason regex must not pass by matching the path.
    'a.mjs': 'export default {', 'b.mjs': 'export const x = 1\n',
    'c.mjs': dialectSrc({ id: "'Bad_ID'" }), 'd.mjs': dialectSrc({ keyOf: '1' }), 'e.mjs': dialectSrc({ label: '2' }),
  })
  for (const [f, why] of [['a.mjs', /./], ['b.mjs', /default/], ['c.mjs', /id must/], ['d.mjs', /keyOf/], ['e.mjs', /label/]] as const) {
    const p = join(d, f)
    await expect(loadOwnDialect(p), f).rejects.toThrow(`dialect ${p}: `)
    await expect(loadOwnDialect(p), f).rejects.toThrow(why)
  }
})

test('the same dialect file twice is a duplicate id, refused', async () => {
  const p = join(dir({ 'a.mjs': dialectSrc() }), 'a.mjs')
  const own = [{ item: await loadOwnDialect(p), file: p }, { item: await loadOwnDialect(p), file: p }]
  expect(() => mergeOwn(own, [...DIALECTS], d => d.id, 'dialect')).toThrow(`dialect ${p}: `)
  expect(() => mergeOwn(own, [...DIALECTS], d => d.id, 'dialect')).toThrow(/: mine is already loaded/)
})

test('the shape guard: a bad return names the method', async () => {
  const d = dir({
    'async.mjs': dialectSrc({ keyOf: "async () => ({ key: 'k', taskText: 't', len: 0, model: '' })" }),
    'nan.mjs': dialectSrc({ keyOf: "() => ({ key: 'k', taskText: 't', len: NaN, model: '' })" }),
    'reply.mjs': dialectSrc({ readReply: "async () => ({ content: '' })" }),
    'results.mjs': dialectSrc({ toolResults: '() => ({})' }),
    'thrown.mjs': dialectSrc({ keyOf: "() => { throw 'boom' }", readReply: 'async () => { throw undefined }' }),
  })
  const load = (f: string) => loadOwnDialect(join(d, f))
  expect((await load('async.mjs')).keyOf.bind(null, {})).toThrow(/keyOf/)
  expect((await load('nan.mjs')).keyOf.bind(null, {})).toThrow(/keyOf/)
  await expect((await load('reply.mjs')).readReply([], '')).rejects.toThrow(/readReply/)
  expect((await load('results.mjs')).toolResults.bind(null, {}, [])).toThrow(/toolResults/)
  const t = await load('thrown.mjs')
  expect(t.keyOf.bind(null, {})).toThrow(new Error('keyOf: boom'))
  await expect(t.readReply([], '')).rejects.toThrow(new Error('readReply: undefined'))
  // A good one passes its values through.
  const ok = await loadOwnDialect(NO_MESSAGES)
  expect(ok.keyOf({ prompt: 'p', history: ['a'], model: 'm' })).toEqual({ key: 'p', taskText: 'p', len: 1, model: 'm' })
})

test('connection refusals', () => {
  const d = dir({
    'bad.json': '{', 'top.json': conn({ extra: 1 }), 'hint.json': conn({ hints: { foo: 'x-foo' } }),
    'auth.json': conn({ hints: { session: 'authorization' } }), 'strip.json': conn({ taskStrip: [['a']] }),
    'empty.json': conn({ hints: { session: '' } }),
  })
  for (const [f, why] of [['bad.json', /JSON/], ['top.json', /extra/], ['hint.json', /foo/], ['auth.json', /authorization/], ['strip.json', /taskStrip/], ['empty.json', /hint header ""/]] as const) {
    const p = join(d, f)
    expect(() => loadOwnConnection(p), f).toThrow(`connection ${p}: `)
    expect(() => loadOwnConnection(p), f).toThrow(why)
  }
})

test('connections: two own with one name, and a second fallback, are refused at start', async () => {
  const d = dir({ 'a.json': conn(), 'b.json': conn(), 'fb.json': { name: 'mine-fallback', hints: {}, taskStrip: [] } })
  const start = (connectionFiles: string[]) => startProxy({ upstream: 'http://127.0.0.1:9', port: 0, runsDir: d, harness: 't', connectionFiles })
  await expect(start([join(d, 'a.json'), join(d, 'b.json')])).rejects.toThrow(`connection ${join(d, 'b.json')}: `)
  await expect(start([join(d, 'fb.json')])).rejects.toThrow(new RegExp(`^connection ${join(d, 'fb.json')}: .*empty hints`))
})

test('merge: an own openai-chat replaces the built-in, first in order', async () => {
  const p = join(dir({ 'x.mjs': dialectSrc({ id: "'openai-chat'" }) }), 'x.mjs')
  const own = await loadOwnDialect(p)
  const { list, lines } = mergeOwn([{ item: own, file: p }], [...DIALECTS], d => d.id, 'dialect')
  expect(list.map(d => d.id)).toEqual(['openai-chat', 'anthropic'])
  expect(list[0]).toBe(own)
  expect(lines).toEqual([`dialect openai-chat from ${p} (replaces built-in)`])
  expect(mergeOwn([{ item: own, file: '/abs/x.mjs' }], [...DIALECTS], d => d.id, 'dialect').lines).toEqual(['dialect openai-chat from /abs/x.mjs (replaces built-in)'])
})

test('merge: an own claude-code.json replaces the built-in; pick order is own hinted, built-in hinted, fallback', async () => {
  const d = dir({
    'claude-code.json': conn({ name: 'claude-code', hints: { session: 'x-my-cc' } }),
    'other.json': conn({ name: 'other', hints: { session: 'x-other' } }),
  })
  const builtIn = loadConnections()
  builtIn.splice(1, 0, { name: 'zz', hints: { session: 'x-zz' }, taskStrip: [] }) // a second built-in with hints
  const files = [join(d, 'other.json'), join(d, 'claude-code.json')]
  const merged = mergeConnections(files, builtIn)
  expect(merged.list.map(c => c.name)).toEqual(['other', 'claude-code', 'zz', 'generic'])
  expect(merged.list[1].hints).toEqual({ session: 'x-my-cc' })
  const px = await startProxy({ upstream: 'http://127.0.0.1:9', port: 0, runsDir: d, harness: 't', connections: builtIn, connectionFiles: files })
  cleanups.push(() => px.stop())
  expect(px.loaded).toEqual([`connection other from ${join(d, 'other.json')}`, `connection claude-code from ${join(d, 'claude-code.json')} (replaces built-in)`])
})

test('pickConnection over a merged list: own first, then built-in, then the fallback', () => {
  const list = [conn({ name: 'a', hints: { session: 'x-s' } }), conn({ name: 'b', hints: { session: 'x-s' } }), { name: 'generic', hints: {}, taskStrip: [] }] as any
  expect(pickConnection(list, { 'x-s': 'v' }).conn.name).toBe('a')
  expect(pickConnection(list, {}).conn.name).toBe('generic')
})

test('end to end: an own dialect with no messages records a run, and its path stays out of runs/', async () => {
  const replies = ['first', 'second']
  const up = http.createServer((_q, res) => { _q.resume(); _q.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: replies.shift() })) }) })
  await new Promise<void>(r => up.listen(0, '127.0.0.1', r))
  cleanups.push(() => { up.closeAllConnections(); up.close() })
  const runsDir = tmpSync('lhb-own-runs-')
  const px = await startProxy({ upstream: `http://127.0.0.1:${(up.address() as { port: number }).port}`, port: 0, runsDir, harness: 't', dialectFiles: [NO_MESSAGES] })
  expect(px.loaded).toEqual([`dialect no-messages from ${NO_MESSAGES}`])
  const send = (history: string[]) => fetch(`http://127.0.0.1:${px.port}/api/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', prompt: 'write it', history }) }).then(r => r.json())
  expect(await send([])).toEqual({ text: 'first' })
  expect(await send(['write it', 'first'])).toEqual({ text: 'second' })
  await px.stop()
  const files = readdirSync(runsDir).filter(f => f.endsWith('.jsonl'))
  expect(files).toHaveLength(1)
  const text = readFileSync(join(runsDir, files[0]), 'utf8')
  const [meta, ...events] = text.trim().split('\n').map(l => JSON.parse(l))
  expect(meta.meta.task).toBe('write it')
  expect(events.filter(e => e.type === 'llm_response').map(e => e.content)).toEqual(['first', 'second'])
  expect(events.at(-1)).toMatchObject({ type: 'done', turns: 2 })
  expect(text).not.toContain(NO_MESSAGES)
  expect(text).not.toContain('no-messages.mjs')
})

test('an own dialect whose keyOf is async: logged by method, the request still forwarded', async () => {
  const p = join(dir({ 'a.mjs': dialectSrc({ matches: '() => true', keyOf: "async () => ({ key: 'k', taskText: 't', len: 0, model: '' })" }) }), 'a.mjs')
  const up = http.createServer((q, res) => { q.resume(); q.on('end', () => res.end('ok')) })
  await new Promise<void>(r => up.listen(0, '127.0.0.1', r))
  cleanups.push(() => { up.closeAllConnections(); up.close() })
  const lines: string[] = []
  const runsDir = tmpSync('lhb-own-runs-')
  const px = await startProxy({ upstream: `http://127.0.0.1:${(up.address() as { port: number }).port}`, port: 0, runsDir, harness: 't', dialectFiles: [p], log: l => lines.push(l) })
  cleanups.push(() => px.stop())
  const r = await fetch(`http://127.0.0.1:${px.port}/x`, { method: 'POST', body: '{}' })
  expect(await r.text()).toBe('ok')
  expect(lines).toContain('not recorded: dialect mine: keyOf: must return synchronously, not a Promise')
  expect(readdirSync(runsDir)).toEqual([])
})

/** An upstream that answers every request with one OpenAI JSON reply; a proxy over it with `dialectFiles`. */
async function overUpstream(dialectFiles: string[]) {
  const reply = JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'up' }, finish_reason: 'stop' }] })
  const up = http.createServer((q, res) => { q.resume(); q.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(reply) }) })
  await new Promise<void>(r => up.listen(0, '127.0.0.1', r))
  cleanups.push(() => { up.closeAllConnections(); up.close() })
  const lines: string[] = []
  const runsDir = tmpSync('lhb-own-runs-')
  const px = await startProxy({ upstream: `http://127.0.0.1:${(up.address() as { port: number }).port}`, port: 0, runsDir, harness: 't', dialectFiles, log: l => lines.push(l) })
  cleanups.push(() => px.stop())
  const post = () => fetch(`http://127.0.0.1:${px.port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'do it' }] }) }).then(r => r.text())
  return { px, post, reply, lines, runsDir }
}

test('an async keyOf or matches that rejects later: the agent gets the upstream reply, the proxy stays up', async () => {
  const d = dir({
    'k.mjs': dialectSrc({ matches: '() => true', keyOf: "async () => { throw new Error('later') }" }),
    'm.mjs': dialectSrc({ id: "'other'", matches: "async () => { throw new Error('later') }" }),
  })
  for (const f of ['k.mjs', 'm.mjs']) {
    const { post, reply } = await overUpstream([join(d, f)])
    expect(await post(), f).toBe(reply)
    await new Promise(r => setTimeout(r, 20)) // let a stray rejection surface
    expect(await post(), f).toBe(reply)
  }
})

test('an async matches is no match: the built-in openai-chat records the request', async () => {
  const p = join(dir({ 'a.mjs': dialectSrc({ matches: 'async () => true' }), 'b.mjs': dialectSrc({ matches: '() => 1' }) }), 'a.mjs')
  expect((await loadOwnDialect(p.replace(/a\.mjs$/, 'b.mjs'))).matches.bind(null, 'POST', '/')).toThrow(new Error('must return a boolean, synchronously'))
  const { px, post, lines, runsDir } = await overUpstream([p])
  await post()
  await px.stop()
  expect(lines).toContain('not recorded: dialect mine: matches: must return synchronously, not a Promise')
  const files = readdirSync(runsDir).filter(f => f.endsWith('.jsonl'))
  expect(files).toHaveLength(1)
  const events = readFileSync(join(runsDir, files[0]), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(events.find(e => e.type === 'llm_response')).toMatchObject({ content: 'up' })
})

const OLLAMA = fileURLToPath(new URL('../examples-dialects/ollama-chat.mjs', import.meta.url))

test('the Ollama example records a tool round, streamed and not', async () => {
  const ndjson = [
    { model: 'm', message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read', arguments: { path: 'a' } } }] }, done: false },
    { model: 'm', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 7, eval_count: 3 },
  ].map(o => JSON.stringify(o)).join('\n') + '\n'
  const last = { model: 'm', message: { role: 'assistant', content: 'done' }, done: true, done_reason: 'stop', prompt_eval_count: 9, eval_count: 1 }
  const replies = [{ type: 'application/x-ndjson', body: ndjson }, { type: 'application/json', body: JSON.stringify(last) }]
  const up = http.createServer((q, res) => { q.resume(); q.on('end', () => { const r = replies.shift()!; res.writeHead(200, { 'content-type': r.type }); res.end(r.body) }) })
  await new Promise<void>(r => up.listen(0, '127.0.0.1', r))
  cleanups.push(() => { up.closeAllConnections(); up.close() })
  const runsDir = tmpSync('lhb-own-runs-')
  const px = await startProxy({ upstream: `http://127.0.0.1:${(up.address() as { port: number }).port}`, port: 0, runsDir, harness: 't', dialectFiles: [OLLAMA] })
  const send = (messages: object[], stream: boolean) => fetch(`http://127.0.0.1:${px.port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages, stream }) }).then(r => r.text())
  const user = { role: 'user', content: 'read a' }
  await send([user], true)
  await send([user, { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read', arguments: { path: 'a' } } }] }, { role: 'tool', tool_name: 'read', content: 'x' }], false)
  await px.stop()
  const files = readdirSync(runsDir).filter(f => f.endsWith('.jsonl'))
  expect(files).toHaveLength(1)
  const [meta, ...events] = readFileSync(join(runsDir, files[0]), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(meta.meta.task).toBe('read a')
  expect(events.find(e => e.type === 'tool_call')).toMatchObject({ call: { name: 'read', args: { path: 'a' } } })
  expect(events.find(e => e.type === 'tool_result')).toMatchObject({ name: 'read', output: 'x' })
  expect(events.filter(e => e.type === 'llm_response').map(e => e.content)).toEqual(['', 'done'])
  expect(events.at(-1)).toMatchObject({ type: 'done', turns: 2 })
})

test('the examples are self-contained, and my-harness.json passes the strict check', () => {
  expect(/\bfrom\s+['"][^'"]*(dist|src)|\bimport\s*\(|require\(/.test(readFileSync(OLLAMA, 'utf8'))).toBe(false)
  const c = loadOwnConnection(fileURLToPath(new URL('../examples-dialects/my-harness.json', import.meta.url)))
  expect(c.name).not.toBe('generic')
  expect(Object.keys(c.hints).length).toBeGreaterThan(0)
})

const KEY = "({ key: 'k', taskText: 't', len: 1, model: '' })"
const events = (runsDir: string) => readdirSync(runsDir).filter(f => f.endsWith('.jsonl')).flatMap(f => readFileSync(join(runsDir, f), 'utf8').trim().split('\n').map(l => JSON.parse(l)))

test('I1: an Error from keyOf is logged with the method', async () => {
  const p = join(dir({ 'a.mjs': dialectSrc({ matches: '() => true', keyOf: "() => { throw new Error('boom') }" }) }), 'a.mjs')
  const { post, reply, lines } = await overUpstream([p])
  expect(await post()).toBe(reply)
  expect(lines).toContain('not recorded: dialect mine: keyOf: boom')
})

test('I2: a readReply with a bad tool call is an error event, with no gap in seq', async () => {
  for (const bad of ['[null]', "[{ name: 5, args: {} }]", "[{ name: 'x' }]"]) {
    const p = join(dir({ 'a.mjs': dialectSrc({ matches: '() => true', readReply: `async () => ({ content: 'c', toolCalls: ${bad} })` }) }), 'a.mjs')
    const { px, post, reply, runsDir } = await overUpstream([p])
    expect(await post(), bad).toBe(reply)
    await px.stop()
    const ev = events(runsDir).slice(1)
    expect(ev.map(e => e.type), bad).toEqual(['llm_request', 'error', 'done'])
    expect(ev[1].message, bad).toMatch(/readReply/)
    expect(ev.map(e => e.seq), bad).toEqual([0, 1, 2])
  }
})

test('I2: a toolResults with a bad item writes nothing and leaves the session as it was', async () => {
  const bads = ['[{}]', '[null]', "[{ call: { callId: 'other', name: 'n', args: {} }, output: 'x' }]", '[{ call: calls[0], output: 5 }]', "[{ call: calls[0], output: 'x', error: 1 }]"]
  for (const bad of bads) {
    const readReply = "async () => ({ content: '', toolCalls: [{ name: 'n', args: {} }] })"
    const p = join(dir({ 'a.mjs': dialectSrc({ matches: '() => true', keyOf: `() => ${KEY}`, readReply, toolResults: `(p, calls) => ${bad}` }) }), 'a.mjs')
    const { px, post, lines, runsDir } = await overUpstream([p])
    for (let i = 0; i < 3; i++) { await post(); await new Promise(r => setTimeout(r, 50)) } // the reply is recorded just after the agent has it
    await px.stop()
    expect(lines.filter(l => l.startsWith('not recorded: dialect mine: toolResults')), bad).toHaveLength(2)
    const ev = events(runsDir)
    expect(ev.filter(e => e.type === 'tool_result'), bad).toEqual([])
    expect(ev.filter(e => e.meta), bad).toHaveLength(1) // one run: the unrecorded requests did not touch it
    expect(ev.filter(e => e.type === 'llm_request'), bad).toHaveLength(1)
  }
})

test('M1: a readReply result is plain data before it is scrubbed (a toJSON cannot carry a key past the scrubber)', async () => {
  const SECRET = 'sk-secret-value-123456'
  const readReply = `async () => ({ content: 'c', toolCalls: [], raw: { toJSON: () => ({ echo: '${SECRET}' }) } })`
  const p = join(dir({ 'a.mjs': dialectSrc({ matches: '() => true', readReply }) }), 'a.mjs')
  const { px, runsDir } = await overUpstream([p])
  await fetch(`http://127.0.0.1:${px.port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'do it' }] }) }).then(r => r.text())
  await px.stop()
  const files = readdirSync(runsDir)
  expect(files.length).toBeGreaterThan(0)
  for (const f of files) expect(readFileSync(join(runsDir, f), 'utf8')).not.toContain(SECRET)
})

test('M3: an own openai-chat and an own claude-code.json replace the built-ins in a real request', async () => {
  const d = dir({
    'oc.mjs': dialectSrc({ id: "'openai-chat'", matches: '() => true', keyOf: "() => ({ key: 'k', taskText: 'MARKER', len: 0, model: '' })" }),
    'claude-code.json': conn({ name: 'claude-code', hints: { session: 'x-my-cc' }, taskStrip: [['<a>', '</a>']] }),
  })
  const reply = JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'up' }, finish_reason: 'stop' }] })
  const up = http.createServer((q, res) => { q.resume(); q.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(reply) }) })
  await new Promise<void>(r => up.listen(0, '127.0.0.1', r))
  cleanups.push(() => { up.closeAllConnections(); up.close() })
  const runsDir = tmpSync('lhb-own-runs-')
  const px = await startProxy({ upstream: `http://127.0.0.1:${(up.address() as { port: number }).port}`, port: 0, runsDir, harness: 't', dialectFiles: [join(d, 'oc.mjs')], connectionFiles: [join(d, 'claude-code.json')] })
  const body = (text: string) => JSON.stringify({ model: 'm', messages: [{ role: 'user', content: text }] })
  await fetch(`http://127.0.0.1:${px.port}/v1/chat/completions`, { method: 'POST', body: body('plain') }).then(r => r.text())
  await px.stop()
  expect(events(runsDir)[0].meta.task).toBe('MARKER')
  // the connection: its hint header is the own one, and its taskStrip shows in the task
  const px2Dir = tmpSync('lhb-own-runs-')
  const px2 = await startProxy({ upstream: `http://127.0.0.1:${(up.address() as { port: number }).port}`, port: 0, runsDir: px2Dir, harness: 't', connectionFiles: [join(d, 'claude-code.json')] })
  await fetch(`http://127.0.0.1:${px2.port}/v1/chat/completions`, { method: 'POST', headers: { 'x-my-cc': 's1' }, body: body('keep<a>cut</a> this') }).then(r => r.text())
  await px2.stop()
  expect(events(px2Dir)[0].meta.task).toBe('keep this')
})
