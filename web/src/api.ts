import type { HarnessConfig } from '../../src/core/config'
import type { HarnessEvent } from '../../src/core/events'
import type { RunSummary } from '../../src/server/runs'
export type { HarnessConfig, HarnessEvent, RunSummary }

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? body.errors?.join('; ') ?? `${r.status}`)
  return body as T
}

export const api = {
  models: (kind: string, baseUrl: string) => j<string[]>(`/api/models?kind=${kind}&baseUrl=${encodeURIComponent(baseUrl)}`),
  harnesses: () => j<{ name: string }[]>('/api/harnesses'),
  harness: (name: string) => j<HarnessConfig>(`/api/harnesses/${name}`),
  saveHarness: (name: string, c: HarnessConfig) => j(`/api/harnesses/${name}`, { method: 'PUT', body: JSON.stringify(c) }),
  runs: () => j<RunSummary[]>('/api/runs'),
  startRun: (config: HarnessConfig, task: string, workdir: string) => j<{ runId: string }>('/api/runs', { method: 'POST', body: JSON.stringify({ config, task, workdir }) }),
  approve: (id: string, callId: string, ok: boolean) => j(`/api/runs/${id}/approve`, { method: 'POST', body: JSON.stringify({ callId, ok }) }),
  abort: (id: string) => j(`/api/runs/${id}/abort`, { method: 'POST' }),
  /** Subscribes to a run; browser EventSource handles Last-Event-ID on reconnect. */
  events: (id: string, onEvent: (e: HarnessEvent) => void, onError: (message: string) => void): (() => void) => {
    const es = new EventSource(`/api/runs/${id}/events`)
    es.onmessage = m => { const e = JSON.parse(m.data) as HarnessEvent; onEvent(e); if (e.type === 'done') es.close() }
    // While CONNECTING the browser retries on its own (with Last-Event-ID); CLOSED means it gave up, e.g. on a 404.
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) onError('event stream closed: run not found or server gone') }
    return () => es.close()
  },
}
