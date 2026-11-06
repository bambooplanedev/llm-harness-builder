import { test, expect } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { startServer, type ServerOpts } from '../src/server/index.js'
import { tmp, spawnCli } from './helpers.js'

const runsDir = await tmp('lhb-proxies-runs-')
const harnessesDir = await tmp('lhb-proxies-h-')

/** A fake proxy: prints the ready line for --port (or `port`), then `after` lines; ignores SIGINT when `stubborn`. */
type Script = { ready?: string; after?: string[]; exit?: number; stubborn?: boolean; later?: string[] }
const fakeChild = (args: string[], s: Script) => {
  const flag = (f: string) => args.find(a => a.startsWith(`--${f}=`))?.slice(f.length + 3)
  const port = Number(flag('port')) || 40000 + Math.floor(Math.random() * 1000)
  const ready = s.ready ?? `proxy on http://127.0.0.1:${port}/v1 -> ${flag('upstream')}  (runs: /x/runs); give the agent that base URL`
  const code = `
    ${s.stubborn ? "process.on('SIGINT', () => {})" : ''}
    process.stderr.write(${JSON.stringify([ready, ...s.after ?? []].map(l => l + '\n').join(''))})
    ${s.later ? `setTimeout(() => process.stderr.write(${JSON.stringify(s.later.map(l => l + '\n').join(''))}), 500)` : ''}
    ${s.exit !== undefined ? `setTimeout(() => process.exit(${s.exit}), 50)` : 'setInterval(() => {}, 1000)'}`
  return spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
}

async function serve(script: (args: string[]) => Script | ChildProcess, over: Partial<ServerOpts> = {}) {
  const calls: string[][] = []
  const srv = await startServer({ port: 0, runsDir, harnessesDir, proxyKillMs: 200, ...over, cli: args => {
    calls.push(args)
    const s = script(args)
    return 'pid' in s ? s : fakeChild(args, s)
  } })
  const u = `http://127.0.0.1:${srv.port}`
  const origin = u
  const start = (body: object, headers: Record<string, string> = { origin }) =>
    fetch(`${u}/api/proxies`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const list = async () => (await (await fetch(`${u}/api/proxies`)).json()) as any[]
  const stop = (id: string) => fetch(`${u}/api/proxies/${id}/stop`, { method: 'POST', headers: { origin } })
  return { srv, u, calls, start, list, stop }
}
const ok = { upstream: 'http://127.0.0.1:9', port: 0, name: 'a', dialects: [], connections: [] }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const waitFor = async (f: () => boolean | Promise<boolean>, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 20))) if (await f()) return
  throw new Error('timed out')
}

test('two proxies run side by side, each with the port from its ready line; Stop of one leaves the other running', async () => {
  const { srv, start, list, stop } = await serve(() => ({ after: ['hint: one', 'dialect x from /abs/x.mjs'] }))
  try {
    const a = await start({ ...ok, name: 'a', port: 41001 })
    expect(a.status).toBe(201)
    const ai = await a.json()
    expect(ai).toMatchObject({ name: 'a', upstream: ok.upstream, port: 41001, lines: ['hint: one', 'dialect x from /abs/x.mjs'] })
    expect(typeof ai.id).toBe('string')
    expect(Date.parse(ai.started)).not.toBeNaN()
    expect(ai.exit).toBeUndefined()
    const b = await start({ ...ok, name: 'b', port: 41002 })
    expect(b.status).toBe(201)
    const bi = await b.json()
    expect((await list()).map(p => [p.name, p.port])).toEqual([['a', 41001], ['b', 41002]])
    const s = await stop(ai.id)
    expect(s.status).toBe(200)
    expect((await s.json()).exit.signal).toBe('SIGINT')
    const left = await list()
    expect(left.map(p => p.id)).toEqual([bi.id])
    expect(left[0].exit).toBeUndefined()
    expect((await stop('nope')).status).toBe(404)
  } finally { await srv.close() }
})

test('starting a proxy needs this page\'s own Origin: a foreign one and none at all are 403, and nothing is spawned', async () => {
  const { srv, u, calls, start } = await serve(() => ({}))
  try {
    expect((await start(ok, { origin: 'http://evil.example' })).status).toBe(403)
    expect((await start(ok, {})).status).toBe(403) // Node's fetch sends no Origin
    expect((await start(ok, { origin: u.replace('127.0.0.1', 'localhost') })).status).toBe(403) // Host is 127.0.0.1
    expect(calls).toHaveLength(0)
  } finally { await srv.close() }
})

test('bad input is 400 before any spawn; good input goes over as --flag=value only', async () => {
  const { srv, calls, start } = await serve(() => ({}))
  try {
    for (const bad of [{ name: 'Bad Name' }, { name: '' }, { port: 70000 }, { port: 1.5 }, { port: '80' }, { upstream: 'http://x\n' },
      { dialects: ['/abs/a\n.mjs'] }, { dialects: ['rel/a.mjs'] }, { connections: ['c.json'] }, { connections: [7] }, { dialects: '/abs/a.mjs' }]) {
      const r = await start({ ...ok, ...bad })
      expect(r.status, JSON.stringify(bad)).toBe(400)
      expect((await r.json()).error).toBeTruthy()
    }
    expect(calls).toHaveLength(0)
    const r = await start({ upstream: 'http://127.0.0.1:9', port: 0, name: 'n-1', dialects: ['/d/a.mjs', '/d/--port=1.mjs'], connections: ['/c/x.json'] })
    expect(r.status).toBe(201)
    expect(calls).toEqual([['proxy', '--upstream=http://127.0.0.1:9', '--port=0', '--name=n-1', '--dialect=/d/a.mjs', '--dialect=/d/--port=1.mjs', '--connection=/c/x.json']])
  } finally { await srv.close() }
})

test('at most 8 live proxies, and no two live ones share a name', async () => {
  const { srv, start } = await serve(() => ({}))
  try {
    for (let i = 1; i <= 8; i++) expect((await start({ ...ok, name: `p${i}` })).status).toBe(201)
    const ninth = await start({ ...ok, name: 'p9' })
    expect(ninth.status).toBe(409)
    expect((await ninth.json()).error).toMatch(/8/)
  } finally { await srv.close() }
  const s2 = await serve(() => ({}))
  try {
    expect((await s2.start(ok)).status).toBe(201)
    const dup = await s2.start(ok)
    expect(dup.status).toBe(409)
    expect((await dup.json()).error).toMatch(/"a"/)
    expect(s2.calls).toHaveLength(1)
  } finally { await s2.srv.close() }
})

test('a child that exits before its ready line, or prints something else first, is 502 with its stderr and is not listed', async () => {
  const { srv, start, list } = await serve(args => args.includes('--name=early')
    ? { ready: 'proxy: dialect x: no default export', exit: 1 }
    : { ready: 'warning: something', after: ['proxy on http://127.0.0.1:5/v1 -> x'] })
  try {
    const r = await start({ ...ok, name: 'early' })
    expect(r.status).toBe(502)
    expect((await r.json()).error).toBe('proxy: dialect x: no default export')
    const r2 = await start({ ...ok, name: 'other' })
    expect(r2.status).toBe(502)
    expect((await r2.json()).error).toMatch(/^warning: something/)
    expect(await list()).toEqual([])
  } finally { await srv.close() }
})

test('a ready-looking line after the first one never changes the port; it only goes to the tail', async () => {
  const { srv, start, list } = await serve(() => ({ later: ['proxy on http://127.0.0.1:1/v1 -> evil', 'record: problem'] }))
  try {
    const r = await start({ ...ok, port: 41003 })
    expect((await r.json()).lines).toEqual([])
    await waitFor(async () => (await list())[0].tail.includes('record: problem'))
    const [p] = await list()
    expect(p.port).toBe(41003)
    expect(p.lines).toEqual([])
    expect(p.tail).toBe('proxy on http://127.0.0.1:1/v1 -> evil\nrecord: problem\n')
  } finally { await srv.close() }
})

test('Stop of a proxy that ignores SIGINT kills it after proxyKillMs', async () => {
  const { srv, start, stop, list } = await serve(() => ({ stubborn: true }))
  try {
    const { id } = await (await start(ok)).json()
    const t = Date.now()
    const r = await stop(id)
    expect(r.status).toBe(200)
    expect((await r.json()).exit).toEqual({ code: null, signal: 'SIGKILL' })
    expect(Date.now() - t).toBeGreaterThanOrEqual(190)
    expect(await list()).toEqual([])
  } finally { await srv.close() }
})

test('a proxy that crashes after it was ready stays listed with its exit and tail until Stop removes it', async () => {
  const d = await serve(() => fakeCrash())
  try {
    const r = await d.start(ok)
    expect(r.status).toBe(201)
    const { id } = await r.json()
    await waitFor(async () => (await d.list())[0].exit !== undefined)
    const [p] = await d.list()
    expect(p.exit).toEqual({ code: 3, signal: null })
    expect(p.tail).toContain('crashed: boom')
    const s2 = await d.stop(id)
    expect(s2.status).toBe(200)
    expect(await d.list()).toEqual([])
  } finally { await d.srv.close() }
})
const fakeCrash = () => spawn(process.execPath, ['-e', `process.stderr.write('proxy on http://127.0.0.1:41004/v1 -> x  (runs: r)\\n'); setTimeout(() => { process.stderr.write('crashed: boom\\n'); process.exit(3) }, 400)`], { stdio: ['ignore', 'pipe', 'pipe'] })

test('close() stops every proxy, the stubborn ones too', async () => {
  const children: ChildProcess[] = []
  const { srv, start } = await serve(args => { const c = fakeChild(args, { stubborn: args.includes('--name=b') }); children.push(c); return c })
  expect((await start({ ...ok, name: 'a' })).status).toBe(201)
  expect((await start({ ...ok, name: 'b' })).status).toBe(201)
  await srv.close()
  await waitFor(() => children.every(c => !alive(c.pid!)))
})

test('a server without a way to start the CLI has no proxy routes', async () => {
  const srv = await startServer({ port: 0, runsDir, harnessesDir })
  const u = `http://127.0.0.1:${srv.port}`
  try {
    expect((await fetch(`${u}/api/proxies`)).status).toBe(404)
    expect((await fetch(`${u}/api/proxies`, { method: 'POST', headers: { origin: u }, body: JSON.stringify(ok) })).status).toBe(404)
  } finally { await srv.close() }
})

test('the real CLI: runs in the given cwd, refuses a plain-http remote upstream and a port in use, each as 502 with its stderr', async () => {
  const cwd = await tmp('lhb-proxies-cwd-')
  const up = http.createServer((_q, s) => s.end('{}')).listen(0, '127.0.0.1')
  await new Promise(r => up.once('listening', r))
  const upUrl = `http://127.0.0.1:${(up.address() as { port: number }).port}`
  const { srv, start, list, stop } = await serve(args => spawnCli(args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }), { proxyKillMs: 5000 })
  try {
    const remote = await start({ ...ok, upstream: 'http://example.com' })
    expect(remote.status).toBe(502)
    expect((await remote.json()).error).toMatch(/over http must be a loopback/)
    const r = await start({ ...ok, upstream: upUrl, name: 'real' })
    expect(r.status).toBe(201)
    const p = await r.json()
    expect(p.port).toBeGreaterThan(0)
    const busy = await start({ ...ok, upstream: upUrl, name: 'busy', port: p.port })
    expect(busy.status).toBe(502)
    expect((await busy.json()).error).toMatch(/EADDRINUSE/)
    expect((await list()).map(x => x.name)).toEqual(['real'])
    const s = await stop(p.id)
    expect(s.status).toBe(200)
    expect((await s.json()).exit.code).toBe(0)
  } finally { await srv.close(); up.close() }
}, 30000)

