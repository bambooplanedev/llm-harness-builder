import type { HarnessConfig } from '../../src/core/config'
import type { HarnessEvent } from '../../src/core/events'
import type { RunSummary } from '../../src/server/runs'
import type { Delta, ServerInfo } from '../../src/core/backends/types'
import type { BenchFile, BenchResult, BenchHarness, BenchRun, ActiveTrace } from '../../src/core/bench'
import type { AnalysisCells } from '../../src/core/analyze'
export type { HarnessConfig, HarnessEvent, RunSummary, Delta, ServerInfo, BenchFile, BenchResult, BenchHarness, BenchRun, ActiveTrace, AnalysisCells }

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? body.errors?.join('; ') ?? `${r.status}`)
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
  runs: () => j<RunSummary[]>('/api/runs'),
  dirs: (path: string) => j<{ path: string; parent: string | null; dirs: { name: string; path: string }[] }>(`/api/dirs?path=${encodeURIComponent(path)}`),
  bench: (file?: string) => j<{ files: BenchFile[]; result?: BenchResult; active?: ActiveTrace; analysis?: Record<string, AnalysisCells> }>(
    `/api/bench${file ? `?file=${encodeURIComponent(file)}` : ''}`),
  benchAgain: (file: string) => j<{ file: string }>('/api/bench/again', { method: 'POST', body: JSON.stringify({ file }) }),
  demo: () => j<{ workdir: string }>('/api/demo', { method: 'POST' }),
  demoCheck: (workdir: string, config: HarnessConfig) => j<{ verdict: 'PASS' | 'FAIL' }>('/api/demo/check', { method: 'POST', body: JSON.stringify({ workdir, config }) }),
  startRun: (config: HarnessConfig, task: string, workdir: string) => j<{ runId: string }>('/api/runs', { method: 'POST', body: JSON.stringify({ config, task, workdir }) }),
  approve: (id: string, callId: string, ok: boolean) => j(`/api/runs/${id}/approve`, { method: 'POST', body: JSON.stringify({ callId, ok }) }),
  abort: (id: string) => j(`/api/runs/${id}/abort`, { method: 'POST' }),
  /** Subscribes to a run; browser EventSource handles Last-Event-ID on reconnect. */
  events: (id: string, onEvent: (e: HarnessEvent) => void, onError: (message: string) => void, onDelta?: (d: Delta) => void): (() => void) => {
    const es = new EventSource(`/api/runs/${id}/events`)
    es.onmessage = m => { const e = JSON.parse(m.data) as HarnessEvent; onEvent(e); if (e.type === 'done') es.close() }
    es.addEventListener('delta', m => onDelta?.(JSON.parse((m as MessageEvent).data)))
    // While CONNECTING the browser retries on its own (with Last-Event-ID); CLOSED means it gave up, e.g. on a 404.
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) onError('event stream closed: run not found or server gone') }
    return () => es.close()
  },
}
