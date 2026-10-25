import http from 'node:http'
import { readFile, readdir, writeFile, mkdir, mkdtemp, rm, stat, realpath } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RunStore, WorkdirBusyError, safeName } from './runs.js'
import { refusal } from './origin.js'
import { validateConfig, backendErrors, keyProblem, apiKey, type HarnessConfig, type RunParams } from '../core/config.js'
import { validateWorkdir } from '../core/tools/sandbox.js'
import { createBackend, type Backend } from '../core/backends/index.js'
import { redactor } from '../core/redact.js'
import { unreachable } from '../core/preflight.js'
import type { HarnessEvent } from '../core/events.js'
import { benchFileName } from '../core/bench.js'
import { TASKS, checkSlug } from '../core/tasks.js'
import { childEnv } from '../core/tools/env.js'

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
  /** Stop bench reached `benching` before its JSON existed: the start that waits says so, not a raw 502. */
  let stopping = false
  /** The JSON `benching` writes: GET /api/bench names it while it runs, so a reloaded page still offers Stop. */
  let benchingFile = ''
  const running = () => !!benching && benching.exitCode === null && benching.signalCode === null
  /** Realpaths of the demo projects this server created: Check runs only in one of them, never in a folder the page names. */
  const demoDirs = new Set<string>()

  const exists = (f: string) => stat(f).then(() => true, () => false)
  /** The one bench start: 409 while one runs, else spawns `opts.bench(args + --out)`; 201 once its JSON exists (past preflight), else 502 with its stderr. */
  async function startBench(args: string[], cleanup?: () => void): Promise<{ status: 201 | 409 | 502; body: { file?: string; error?: string } }> {
    if (running()) return { status: 409, body: { error: 'a bench started from this page is still running' } }
    const first = benchFileName(new Date())
    let out = first
    for (let i = 2; await exists(path.join(opts.runsDir, out)); i++) out = first.replace(/\.json$/, `-${i}.json`) // two in one second must not share a JSON
    const outPath = path.join(opts.runsDir, out)
    const i = args.findIndex(a => !a.startsWith('--')) // flags first, then the harness files
    const k2 = i < 0 ? args.length : i
    stopping = false; benchingFile = out
    const child = benching = opts.bench!([...args.slice(0, k2), `--out=${outPath}`, ...args.slice(k2)])
    let tail = ''
    child.stderr?.on('data', (c: Buffer) => { tail = (tail + c).slice(-2000) }) // read to the end, or a full pipe stalls the bench
    if (cleanup) child.once('exit', cleanup)
    // Answered once the JSON exists, that is past preflight; a bench that dies before it (server down, no such model) is its stderr.
    const started = await new Promise<boolean>(resolve => {
      const done = (y: boolean) => { clearInterval(t); resolve(y) }
      const t = setInterval(() => void exists(outPath).then(y => y && done(true)), 200)
      child.once('exit', () => void exists(outPath).then(done))
      child.once('error', () => done(false))
    })
    return started ? { status: 201, body: { file: out } } : { status: 502, body: { error: stopping ? 'stopped before it started' : tail.trim() || 'bench exited before it wrote its JSON' } }
  }

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
          // No body = no HTTP answer at all: say what to start, not just "fetch failed".
          return json(res, 502, { error: redact.text(text === undefined ? unreachable(backend, e) : (e as Error).message), body: text === undefined ? undefined : redact.text(text) })
        }
      }
      if (m('GET', /^\/api\/harnesses$/)) {
        const files = (await readdir(opts.harnessesDir)).filter(f => f.endsWith('.json'))
        // An unreadable file is still listed, by name only.
        const list = await Promise.all(files.map(async f => {
          const name = f.slice(0, -5)
          try { const d = JSON.parse(await readFile(path.join(opts.harnessesDir, f), 'utf8')).description; return typeof d === 'string' ? { name, description: d } : { name } } catch { return { name } }
        }))
        return json(res, 200, list)
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
        const own = running() ? benchingFile : undefined
        if (file === null) return json(res, 200, { files: await store.benchList(), own })
        if (!benchName(file)) return json(res, 400, { error: 'bad name' })
        const opened = await store.benchOpen(file)
        if (!opened) return json(res, 404, { error: 'not a bench file' })
        return json(res, 200, { files: await store.benchList(), own, ...opened, analysis: await store.benchAnalysis(opened.result) })
      }
      if (opts.bench && m('POST', /^\/api\/bench\/again$/)) {
        // The same bench once more, from its own JSON: the harnesses as recorded, the task, size, n and timeout. A new JSON, the old one stays.
        const { file } = await readBody(req)
        if (!benchName(file)) return json(res, 400, { error: 'bad name' })
        const opened = await store.benchOpen(file)
        if (!opened) return json(res, 404, { error: 'not a bench file' })
        const r = opened.result
        const dir = await mkdtemp(path.join(tmpdir(), 'lhb-again-'))
        const harnesses = await Promise.all(r.harnesses.map(async (h, i) => { const f = path.join(dir, `${i}.json`); await writeFile(f, JSON.stringify(h.config)); return f }))
        const cleanup = () => void rm(dir, { recursive: true, force: true })
        // `--x=value`: a value from the file that starts with `-` stays a value. The CLI checks every one of them.
        const { status, body } = await startBench([`--task=${r.taskName ?? 'slug'}`, ...r.size ? [`--size=${r.size}`] : [], `--n=${r.n}`, `--timeout=${r.timeoutS}`, ...harnesses], cleanup)
        if (status === 409) cleanup() // no child, so no exit to clean up on
        return json(res, status, body)
      }
      if (opts.bench && m('POST', /^\/api\/bench\/new$/)) {
        // The bench approves everything it runs: only fields checked here reach its argv, each as `--x=value`.
        const body = await readBody(req) as Record<string, unknown>
        const errors: string[] = []
        const names = Array.isArray(body.harnesses) ? [...new Set(body.harnesses)] : []
        if (names.length < 1 || names.length > 8) errors.push('harnesses: pick 1 to 8')
        const task = typeof body.task === 'string' && Object.hasOwn(TASKS, body.task) ? TASKS[body.task as keyof typeof TASKS] : undefined
        if (!task) errors.push(`task must be one of ${Object.keys(TASKS).join('|')}`)
        const { size, n } = body
        // As the CLI wants it: a task with sizes needs one in range, a task without takes none.
        if (task && (task.max ? !(Number.isInteger(size) && (size as number) >= 1 && (size as number) <= task.max) : size !== undefined))
          errors.push(task.max ? `size must be an integer from 1 to ${task.max} for ${body.task}` : `size: ${body.task} has no sizes`)
        if (!(Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 50)) errors.push('n must be an integer from 1 to 50')
        const f = (body.backend ?? {}) as Record<string, unknown>
        const b = { kind: f.kind, baseUrl: f.baseUrl, model: f.model, temperature: 0, ...(f.apiKeyEnv !== undefined ? { apiKeyEnv: f.apiKeyEnv } : {}) }
        const backErrs = backendErrors(b)
        // An empty --model= would silently keep each harness file's own model.
        if (typeof b.model !== 'string' || !b.model) backErrs.push('backend.model is required')
        const backend = b as unknown as HarnessConfig['backend']
        const missing = backErrs.length ? undefined : keyMissing(backend)
        errors.push(...backErrs, ...missing ? [missing] : [])
        const files: string[] = []
        for (const name of names) {
          if (typeof name !== 'string' || !safeName(name) || name.includes('..')) { errors.push('harnesses: a name is not a plain file name'); continue }
          const file = path.resolve(opts.harnessesDir, `${name}.json`)
          let cfg: { backend?: { apiKeyEnv?: unknown } }
          try { cfg = JSON.parse(await readFile(file, 'utf8')) } catch { errors.push(`${name}: no readable harness file of that name`); continue }
          // loadHarness keeps a file's own apiKeyEnv: its key would go to the form's URL.
          if (cfg?.backend?.apiKeyEnv !== backend.apiKeyEnv) errors.push(`${name}: its backend.apiKeyEnv differs from the form's`)
          files.push(file)
        }
        if (errors.length) return json(res, 400, { errors })
        const { status, body: out } = await startBench([`--task=${body.task}`, ...size !== undefined ? [`--size=${size}`] : [], `--n=${n}`,
          `--model=${backend.model}`, `--base-url=${backend.baseUrl}`, `--kind=${backend.kind}`, ...backend.apiKeyEnv ? [`--api-key-env=${backend.apiKeyEnv}`] : [], ...files])
        return json(res, status, out)
      }
      if (opts.bench && m('POST', /^\/api\/bench\/stop$/)) {
        // Only the child this server holds: no pid or name from the page. SIGINT = Ctrl-C, the finished runs stay in its JSON.
        if (!running()) return json(res, 409, { error: 'no bench started from this page is running' })
        stopping = true
        benching!.kill('SIGINT')
        return json(res, 200, { ok: true })
      }
      if (m('POST', /^\/api\/demo$/)) {
        const dir = await realpath(await TASKS.slug.prepare())
        demoDirs.add(dir)
        return json(res, 201, { workdir: dir })
      }
      if (m('POST', /^\/api\/demo\/check$/)) {
        const body = await readBody(req) as { workdir?: unknown; config?: unknown }
        const errs = validateConfig(body.config)
        if (errs.length) return json(res, 400, { errors: errs })
        const dir = typeof body.workdir === 'string' ? await realpath(body.workdir).catch(() => '') : ''
        if (!demoDirs.has(dir)) return json(res, 404, { error: 'not a demo project this server created' })
        // The model's code runs here: the environment the harness names, never serve's own (keys live there).
        const ok = await checkSlug(dir, childEnv((body.config as HarnessConfig).tools.bashEnv))
        return json(res, 200, { verdict: ok ? 'PASS' : 'FAIL' })
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
