import http from 'node:http'
import { readFile, readdir, writeFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RunStore, WorkdirBusyError, safeName } from './runs.js'
import { refusal } from './origin.js'
import { validateConfig, backendErrors, keyProblem, apiKey, type HarnessConfig, type RunParams } from '../core/config.js'
import { validateWorkdir } from '../core/tools/sandbox.js'
import { createBackend, type Backend } from '../core/backends/index.js'
import { redactor } from '../core/redact.js'
import type { HarnessEvent } from '../core/events.js'
import { benchFileName } from '../core/bench.js'

/** `bench` starts `llm-harness-builder bench <args>` with its stderr piped; without it the page cannot start one. */
export type ServerOpts = { port: number; runsDir: string; harnessesDir: string; staticDir?: string; backendFactory?: (b: HarnessConfig['backend']) => Backend; bench?: (args: string[]) => ChildProcess }

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }
const MAX_BODY_BYTES = 5e6

/** A bench JSON the page may name: one plain segment ending in .json. */
const benchName = (f: unknown): f is string => typeof f === 'string' && safeName(f) && f.endsWith('.json')
/** The words for a key the environment of serve does not hold, or undefined. */
const keyMissing = (b: HarnessConfig['backend']) => {
  const problem = keyProblem(b, process.env)
  return problem && `backend.apiKeyEnv: ${problem} in the environment serve was started from`
}

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
  /** The bench this server started: one at a time, both would share one model server. */
  let benching: ChildProcess | undefined

  const server = http.createServer(async (req, res) => {
    try {
      // DNS rebinding (a foreign Host) and CSRF (a page of another origin, other localhost ports included): refused.
      // No Origin is a client that is not a browser (curl, tests) or a browser GET (this page's own, or a simple one from
      // elsewhere that cannot read the answer), and is allowed. A POST or PUT from a page always carries Origin, so a GET
      // route must never send a key, and writes only housekeeping: the runs directory, a missing `done` on a trace.
      const no = refusal(req)
      if (no) return json(res, 403, { error: no })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const m = (method: string, re: RegExp) => req.method === method ? re.exec(url.pathname) : null
      let mm: RegExpExecArray | null

      const info = m('POST', /^\/api\/model-info$/)
      if (info || m('POST', /^\/api\/models$/)) {
        // POST, not GET: a GET from another page carries no Origin, and this request may send a key.
        const body = await readBody(req) as Record<string, unknown>
        const b = { kind: body.kind, baseUrl: body.baseUrl, model: info ? body.model : '', temperature: 0, ...(body.apiKeyEnv !== undefined ? { apiKeyEnv: body.apiKeyEnv } : {}) }
        const errors = backendErrors(b)
        if (info && (typeof b.model !== 'string' || !b.model)) errors.push('backend.model is required')
        // Past backendErrors the fields are what a backend config holds; only model-info asks for a model.
        const backend = b as unknown as HarnessConfig['backend']
        const missing = errors.length ? undefined : keyMissing(backend)
        if (missing) errors.push(missing)
        if (errors.length) return json(res, 400, { errors })
        const redact = redactor(apiKey(backend, process.env), backend.apiKeyEnv ?? '')
        try {
          if (!info) return json(res, 200, await backendFactory(backend).listModels())
          // Only what the form shows: undefined fields drop out of the JSON.
          const { nCtx, maxOutput, takes, takesFrom } = await backendFactory(backend).serverInfo?.(backend.model) ?? {}
          return json(res, 200, { nCtx, maxOutput, takes, takesFrom })
        }
        catch (e) {
          const text = (e as { body?: string }).body
          return json(res, 502, { error: redact.text((e as Error).message), body: text === undefined ? undefined : redact.text(text) })
        }
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
      if (m('GET', /^\/api\/dirs$/)) {
        // The page's folder picker: names of subfolders only, never file contents. A browser cannot hand a page an absolute path.
        const dir = path.resolve(url.searchParams.get('path') || process.cwd())
        let entries
        try { entries = await readdir(dir, { withFileTypes: true }) } catch (e) { return json(res, 400, { error: (e as Error).message }) }
        const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => ({ name: e.name, path: path.join(dir, e.name) })).sort((a, b) => a.name.localeCompare(b.name))
        return json(res, 200, { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), dirs })
      }
      if (m('GET', /^\/api\/runs$/)) return json(res, 200, await store.list())
      if (m('GET', /^\/api\/bench$/)) {
        const file = url.searchParams.get('file')
        if (file === null) return json(res, 200, { files: await store.benchList() })
        if (!benchName(file)) return json(res, 400, { error: 'bad name' })
        const opened = await store.benchOpen(file)
        if (!opened) return json(res, 404, { error: 'not a bench file' })
        return json(res, 200, { files: await store.benchList(), ...opened, analysis: await store.benchAnalysis(opened.result) })
      }
      if (opts.bench && m('POST', /^\/api\/bench\/again$/)) {
        // The same bench once more, from its own JSON: the harnesses as recorded, the task, size, n and timeout. A new JSON, the old one stays.
        const { file } = await readBody(req)
        if (!benchName(file)) return json(res, 400, { error: 'bad name' })
        const opened = await store.benchOpen(file)
        if (!opened) return json(res, 404, { error: 'not a bench file' })
        if (benching && benching.exitCode === null && benching.signalCode === null) return json(res, 409, { error: 'a bench started from this page is still running' })
        const r = opened.result
        const dir = await mkdtemp(path.join(tmpdir(), 'lhb-again-'))
        const harnesses = await Promise.all(r.harnesses.map(async (h, i) => { const f = path.join(dir, `${i}.json`); await writeFile(f, JSON.stringify(h.config)); return f }))
        const exists = (f: string) => stat(f).then(() => true, () => false)
        const first = benchFileName(new Date())
        let out = first
        for (let i = 2; await exists(path.join(opts.runsDir, out)); i++) out = first.replace(/\.json$/, `-${i}.json`) // two in one second must not share a JSON
        const outPath = path.join(opts.runsDir, out)
        // `--x=value`: a value from the file that starts with `-` stays a value. The CLI checks every one of them.
        const child = benching = opts.bench([`--task=${r.taskName ?? 'slug'}`, ...r.size ? [`--size=${r.size}`] : [], `--n=${r.n}`, `--timeout=${r.timeoutS}`, `--out=${outPath}`, ...harnesses])
        let tail = ''
        child.stderr?.on('data', (c: Buffer) => { tail = (tail + c).slice(-2000) }) // read to the end, or a full pipe stalls the bench
        child.once('exit', () => void rm(dir, { recursive: true, force: true }))
        // Answered once the JSON exists, that is past preflight; a bench that dies before it (server down, no such model) is its stderr.
        const started = await new Promise<boolean>(resolve => {
          const done = (y: boolean) => { clearInterval(t); resolve(y) }
          const t = setInterval(() => void exists(outPath).then(y => y && done(true)), 200)
          child.once('exit', () => void exists(outPath).then(done))
          child.once('error', () => done(false))
        })
        if (!started) return json(res, 502, { error: tail.trim() || 'bench exited before it wrote its JSON' })
        return json(res, 201, { file: out })
      }
      if (m('POST', /^\/api\/runs$/)) {
        const body = await readBody(req) as Partial<RunParams>
        const errs = validateConfig(body.config)
        const missing = errs.length ? undefined : keyMissing((body.config as HarnessConfig).backend)
        if (missing) errs.push(missing)
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
  return { port, close: () => new Promise<void>(r => { benching?.kill(); server.close(() => r()); server.closeAllConnections() }) }
}
