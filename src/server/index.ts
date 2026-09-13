import http from 'node:http'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { RunStore, WorkdirBusyError, safeName } from './runs.js'
import { validateConfig, type HarnessConfig, type RunParams } from '../core/config.js'
import { validateWorkdir } from '../core/tools/sandbox.js'
import { createBackend, type Backend } from '../core/backends/index.js'
import type { HarnessEvent } from '../core/events.js'

export type ServerOpts = { port: number; runsDir: string; harnessesDir: string; staticDir?: string; backendFactory?: (b: HarnessConfig['backend']) => Backend }

const LOCAL = new Set(['localhost', '127.0.0.1'])
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }
const MAX_BODY_BYTES = 5e6

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
}
const readBody = (req: http.IncomingMessage) => new Promise<any>((resolve, reject) => {
  const chunks: Buffer[] = []
  let bytes = 0
  let settled = false
  const fail = (err: Error) => { if (settled) return; settled = true; chunks.length = 0; reject(err) }
  req.on('data', (c: Buffer) => {
    if (settled) return
    bytes += c.length
    if (bytes > MAX_BODY_BYTES) { req.destroy(); fail(new Error('body too large')); return }
    chunks.push(c)
  })
  req.on('end', () => {
    if (settled) return
    settled = true
    try { const s = Buffer.concat(chunks).toString('utf8'); resolve(s ? JSON.parse(s) : {}) } catch (e) { reject(e) }
  })
  req.on('error', fail)
})

export async function startServer(opts: ServerOpts) {
  const store = new RunStore(opts.runsDir)
  const backendFactory = opts.backendFactory ?? createBackend
  await mkdir(opts.harnessesDir, { recursive: true })

  const server = http.createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').split(':')[0]
      if (!LOCAL.has(host)) return json(res, 403, { error: 'forbidden host' })
      // CSRF: every cross-site request a browser can make to a mutating endpoint (fetch, XHR, form
      // POST) carries Origin, so a missing Origin only means a non-browser client (curl, tests)
      // and is deliberately allowed. `Origin: null` fails the URL parse below and is rejected.
      if (req.headers.origin) {
        let oh = ''; try { oh = new URL(req.headers.origin).hostname } catch {}
        if (!LOCAL.has(oh)) return json(res, 403, { error: 'forbidden origin' })
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const m = (method: string, re: RegExp) => req.method === method ? re.exec(url.pathname) : null
      let mm: RegExpExecArray | null

      if (m('GET', /^\/api\/models$/)) {
        const kind = url.searchParams.get('kind') as HarnessConfig['backend']['kind'], baseUrl = url.searchParams.get('baseUrl') ?? ''
        try { return json(res, 200, await backendFactory({ kind, baseUrl, model: '', temperature: 0 }).listModels()) }
        catch (e) { return json(res, 502, { error: (e as Error).message, body: (e as { body?: string }).body }) }
      }
      if (m('GET', /^\/api\/harnesses$/)) {
        const names = (await readdir(opts.harnessesDir)).filter(f => f.endsWith('.json')).map(f => ({ name: f.slice(0, -5) }))
        return json(res, 200, names)
      }
      if ((mm = m('GET', /^\/api\/harnesses\/([^/]+)$/))) {
        if (!safeName(mm[1])) return json(res, 400, { error: 'bad name' })
        try { return json(res, 200, JSON.parse(await readFile(path.join(opts.harnessesDir, `${mm[1]}.json`), 'utf8'))) }
        catch { return json(res, 404, { error: 'not found' }) }
      }
      if ((mm = m('PUT', /^\/api\/harnesses\/([^/]+)$/))) {
        if (!safeName(mm[1])) return json(res, 400, { error: 'bad name' })
        const body = await readBody(req); const errs = validateConfig(body)
        if (errs.length) return json(res, 400, { errors: errs })
        await writeFile(path.join(opts.harnessesDir, `${mm[1]}.json`), JSON.stringify(body, null, 2) + '\n')
        return json(res, 200, { ok: true })
      }
      if (m('GET', /^\/api\/runs$/)) return json(res, 200, await store.list())
      if (m('GET', /^\/api\/bench$/)) {
        const file = url.searchParams.get('file')
        if (file === null) return json(res, 200, { files: await store.benchList() })
        if (!safeName(file) || !file.endsWith('.json')) return json(res, 400, { error: 'bad name' })
        const opened = await store.benchOpen(file)
        if (!opened) return json(res, 404, { error: 'not a bench file' })
        return json(res, 200, { files: await store.benchList(), ...opened })
      }
      if (m('POST', /^\/api\/runs$/)) {
        const body = await readBody(req) as Partial<RunParams>
        const errs = validateConfig(body.config)
        if (typeof body.task !== 'string' || !body.task.trim()) errs.push('task is required')
        if (typeof body.workdir !== 'string') errs.push('workdir is required')
        else { const w = await validateWorkdir(body.workdir); if (w) errs.push(w) }
        if (errs.length) return json(res, 400, { errors: errs })
        const params = body as RunParams
        try {
          const runId = await store.start(params, backendFactory(params.config.backend))
          return json(res, 201, { runId })
        } catch (e) {
          if (e instanceof WorkdirBusyError) return json(res, 409, { error: e.message })
          throw e
        }
      }
      if ((mm = m('GET', /^\/api\/runs\/([^/]+)\/events$/))) {
        const id = mm[1]
        const rawLastId = Number(req.headers['last-event-id'])
        let sent = Number.isInteger(rawLastId) ? rawLastId : -1
        let ended = false
        const endOnce = () => { if (!ended) { ended = true; res.end() } }
        const emit = (e: HarnessEvent) => {
          if (e.seq <= sent) return
          sent = e.seq
          res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`)
          if (e.type === 'done') endOnce()
        }
        // Subscribe to live events BEFORE reading the on-disk snapshot: any event notified to a
        // listener has already been appended to the file (append happens first, then notify), so
        // subscribing first guarantees the snapshot below can't miss anything. Events are buffered
        // (not emitted) until the snapshot has been fully replayed, so replay order stays intact;
        // duplicates between the snapshot and the buffer are harmless since emit() dedupes on `sent`.
        const buffered: HarnessEvent[] = []
        let replaying = true
        const unsub = store.subscribe(id, e => {
          // Deltas are live-only: no id (Last-Event-ID stays on real events), dropped while replaying (headers not sent yet).
          if (e.type === 'delta') { if (!replaying && !ended) res.write(`event: delta\ndata: ${JSON.stringify(e)}\n\n`) }
          else if (replaying) buffered.push(e); else emit(e)
        })
        req.on('close', unsub) // before the first await: a client that drops mid-read must not leave a listener behind
        let past: HarnessEvent[]
        try { past = await store.read(id) } catch { return json(res, 404, { error: 'not found' }) }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        for (const e of past) emit(e)
        for (const e of buffered) emit(e)
        replaying = false
        if (!store.isActive(id) && !ended) {
          const synthetic = await store.ensureDone(id)
          if (synthetic) emit(synthetic)
          else endOnce()
        }
        return
      }
      if ((mm = m('POST', /^\/api\/runs\/([^/]+)\/approve$/))) {
        const { callId, ok } = await readBody(req)
        return store.approve(mm[1], String(callId), ok === true) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no pending approval' })
      }
      if ((mm = m('POST', /^\/api\/runs\/([^/]+)\/abort$/))) return store.abort(mm[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not active' })

      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' })
      if (opts.staticDir) {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
        const file = path.join(opts.staticDir, path.normalize(rel))
        if (!file.startsWith(path.join(opts.staticDir, path.sep))) return json(res, 403, { error: 'forbidden' })
        try { const data = await readFile(file); res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' }); return res.end(data) }
        catch { const index = await readFile(path.join(opts.staticDir, 'index.html')); res.writeHead(200, { 'content-type': 'text/html' }); return res.end(index) }
      }
      json(res, 404, { error: 'not found' })
    } catch (e) {
      if (res.headersSent) { res.end(); return }
      if (e instanceof SyntaxError) return json(res, 400, { error: 'invalid JSON body' })
      json(res, 500, { error: (e as Error).message })
    }
  })

  await new Promise<void>(r => server.listen(opts.port, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { port, close: () => new Promise<void>(r => { server.close(() => r()); server.closeAllConnections() }) }
}
