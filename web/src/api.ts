import type { HarnessConfig } from '../../src/core/config'
import type { HarnessEvent } from '../../src/core/events'
import type { RunSummary } from '../../src/server/runs'
import type { Delta, ServerInfo } from '../../src/core/backends/types'
import type { BenchFile, BenchResult, BenchHarness, BenchRun, ActiveTrace } from '../../src/core/bench'
import type { AnalysisCells } from '../../src/core/analyze'
import type { Note } from '../../src/core/notes'
export type { HarnessConfig, HarnessEvent, RunSummary, Delta, ServerInfo, BenchFile, BenchResult, BenchHarness, BenchRun, ActiveTrace, AnalysisCells, Note }

/** GET /api/evolve. While `running` is there, `last` may be the job before it. */
export type EvolveStatus = {
  /** A bench started from this page runs: the slot evolve needs is taken. */
  bench?: true
  running?: { harness: string; err: string; round?: [number, number] }
  last?: { harness: string; code: number | null; signal: string | null; err: string; out: string }
}
/** The 409 of an evolve start that needs the user's yes first. */
export type EvolveCheck = {
  mode: string; sets: { train: number; gate: number; test: number }
  declarable: boolean; runs: number; priced: boolean; needed?: number; reference?: string
}
export type EvolveConsent = EvolveCheck & { consent: { text: string; hash: string }; uncommitted: boolean }

async function send(url: string, init?: RequestInit) {
  const r = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init })
  return { r, body: await r.json().catch(() => ({})) }
}
const failed = (r: Response, body: any) => new Error(body.error ?? body.errors?.join('; ') ?? `${r.status}`)
async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const { r, body } = await send(url, init)
  if (!r.ok) throw failed(r, body)
  return body as T
}

export const api = {
  models: (kind: string, baseUrl: string, apiKeyEnv?: string) =>
    j<string[]>('/api/models', { method: 'POST', body: JSON.stringify({ kind, baseUrl, ...(apiKeyEnv ? { apiKeyEnv } : {}) }) }),
  modelInfo: (kind: string, baseUrl: string, model: string, apiKeyEnv?: string) =>
    j<ServerInfo>('/api/model-info', { method: 'POST', body: JSON.stringify({ kind, baseUrl, model, ...(apiKeyEnv ? { apiKeyEnv } : {}) }) }),
  harnesses: () => j<{ name: string; description?: string }[]>('/api/harnesses'),
  harness: (name: string) => j<HarnessConfig>(`/api/harnesses/${name}`),
  saveHarness: (name: string, c: HarnessConfig) => j(`/api/harnesses/${name}`, { method: 'PUT', body: JSON.stringify(c) }),
  /** `example`: the recorded runs shipped with the package, read-only, never mixed into your own. */
  runs: (example?: boolean) => j<RunSummary[]>(`/api/runs${example ? '?example=1' : ''}`),
  dirs: (path: string) => j<{ path: string; parent: string | null; dirs: { name: string; path: string }[] }>(`/api/dirs?path=${encodeURIComponent(path)}`),
  bench: (file?: string, example?: boolean) => j<{ files: BenchFile[]; own?: string; result?: BenchResult; active?: ActiveTrace; analysis?: Record<string, AnalysisCells> }>(
    `/api/bench?${new URLSearchParams({ ...file ? { file } : {}, ...example ? { example: '1' } : {} })}`),
  benchAgain: (file: string) => j<{ file: string }>('/api/bench/again', { method: 'POST', body: JSON.stringify({ file }) }),
  benchNew: (body: { harnesses: string[]; task: string; size?: number; n: number; backend: { kind: string; baseUrl: string; model: string; apiKeyEnv?: string } }) =>
    j<{ file: string }>('/api/bench/new', { method: 'POST', body: JSON.stringify(body) }),
  benchStop: () => j<{ ok: true }>('/api/bench/stop', { method: 'POST' }),
  evolveStatus: () => j<EvolveStatus>('/api/evolve'),
  /** undefined: started. A consent: nothing started, the user has to say yes to it first. */
  evolveStart: async (body: { harness: string; repo: string; mode: string; maxUsd?: number; accept?: string }): Promise<EvolveConsent | undefined> => {
    const { r, body: b } = await send('/api/evolve/start', { method: 'POST', body: JSON.stringify(body) })
    if (r.status === 409 && b.consent) return b as EvolveConsent
    if (!r.ok) throw failed(r, b)
  },
  /** Read-only: the run count and the orientation reason for this harness, repo and mode. */
  evolveCheck: (body: { harness: string; repo: string; mode: string }) => j<EvolveCheck>('/api/evolve/check', { method: 'POST', body: JSON.stringify(body) }),
  evolveStop: () => j<{ ok: true }>('/api/evolve/stop', { method: 'POST' }),
  /** POST, not GET: the server lists and deletes behind the same check. */
  notes: (repo: string, del?: string) => j<{ notes: Note[]; removed?: number }>('/api/notes', { method: 'POST', body: JSON.stringify({ repo, ...del === undefined ? {} : { delete: del } }) }),
  demo: () => j<{ workdir: string }>('/api/demo', { method: 'POST' }),
  demoCheck: (workdir: string, config: HarnessConfig) => j<{ verdict: 'PASS' | 'FAIL' }>('/api/demo/check', { method: 'POST', body: JSON.stringify({ workdir, config }) }),
  startRun: (config: HarnessConfig, task: string, workdir: string) => j<{ runId: string }>('/api/runs', { method: 'POST', body: JSON.stringify({ config, task, workdir }) }),
  approve: (id: string, callId: string, ok: boolean) => j(`/api/runs/${id}/approve`, { method: 'POST', body: JSON.stringify({ callId, ok }) }),
  abort: (id: string) => j(`/api/runs/${id}/abort`, { method: 'POST' }),
  /** Subscribes to a run; browser EventSource handles Last-Event-ID on reconnect. */
  events: (id: string, onEvent: (e: HarnessEvent) => void, onError: (message: string) => void, onDelta?: (d: Delta) => void, example?: boolean): (() => void) => {
    const es = new EventSource(`/api/runs/${id}/events${example ? '?example=1' : ''}`)
    es.onmessage = m => { const e = JSON.parse(m.data) as HarnessEvent; onEvent(e); if (e.type === 'done') es.close() }
    es.addEventListener('delta', m => onDelta?.(JSON.parse((m as MessageEvent).data)))
    // While CONNECTING the browser retries on its own (with Last-Event-ID); CLOSED means it gave up, e.g. on a 404.
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) onError('event stream closed: run not found or server gone') }
    return () => es.close()
  },
}
