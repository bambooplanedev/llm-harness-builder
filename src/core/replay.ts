import type { BackendKind } from './config.js'

type Raw = { choices?: { message?: Msg }[]; message?: Msg } | undefined
type Msg = { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] }

/** The recorded request of one turn with the sampling overrides a replay may ask for; nothing else is touched. */
export function replayPayload(payload: unknown, kind: BackendKind, over: { temperature?: number; maxTokens?: number }): unknown {
  const p = payload as Record<string, any>, t = over.temperature, m = over.maxTokens
  if (kind === 'ollama') return { ...p, options: { ...p.options, ...(t !== undefined ? { temperature: t } : {}), ...(m !== undefined ? { num_predict: m } : {}) } }
  return { ...p, ...(t !== undefined ? { temperature: t } : {}), ...(m !== undefined ? { max_tokens: m } : {}) }
}

/** What two replies are compared by: the content and the native tool calls. Not the thinking, which differs between samples that then make the same call, and not the call ids. */
export function replySignature(raw: unknown): string {
  const r = raw as Raw, m = r?.choices?.[0]?.message ?? r?.message ?? {}
  const calls = (m.tool_calls ?? []).map(c => `${c.function?.name} ${typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments)}`)
  return [m.content ?? '', ...calls].join('\n')
}

/** The request the run sent at `turn` and the raw reply it got; `raw` is undefined when the backend failed on that turn. `lines` is a parsed runs/<id>.jsonl, meta line included. */
export function recordedTurn(lines: any[], turn: number): { payload: unknown; raw: unknown } {
  const reqs = lines.filter(e => e.type === 'llm_request'), req = reqs.find(e => e.turn === turn)
  if (!req) throw new Error(`no llm_request at turn ${turn} (the run has turns ${reqs.length ? `${reqs[0].turn}–${reqs.at(-1).turn}` : 'none'})`)
  return { payload: req.payload, raw: lines.find(e => e.type === 'llm_response' && e.turn === turn)?.raw }
}
