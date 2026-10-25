// src/core/preflight.ts — what `bench` asks a server before the first run: does it answer, has it the model, how big is its window.
import { withoutVariant } from './backends/openai.js'
import type { Backend, ServerInfo } from './backends/types.js'
import type { HarnessConfig } from './config.js'

export type PreflightResult = { ok: true; server: Omit<ServerInfo, 'router'> } | { ok: false; message: string }

/** A server that gave no HTTP answer: where, what the network said, and what to start. */
export function unreachable(b: { kind: string; baseUrl: string; apiKeyEnv?: string }, e: unknown): string {
  const cause = (e as any)?.cause?.code ?? (e as any)?.cause?.message
  const next = b.kind === 'ollama' ? '; start Ollama with "ollama serve" (get it at https://ollama.com)'
    : b.kind === 'openai' && b.apiKeyEnv === undefined ? '; check that the server is running at that URL' : ''
  return `${b.baseUrl} (${b.kind}) does not answer: ${(e as Error).message}${cause ? ` (${cause})` : ''}${next}`
}

/**
 * No generation: a list of models and llama-server's /props, nothing that costs model time (a router
 * does load the named model to report its window — the bench would load it anyway). The model name
 * is checked only where the server serves by it: Ollama, and a llama-server router. A one-model
 * llama-server answers any name with the model it has. With a key (a hosted API) the model is
 * checked, by id or by id without a routing suffix, unless the server says its list is partial; the
 * window comes from the list, or on Anthropic from the model's own entry.
 */
export async function preflight(backend: Backend, b: HarnessConfig['backend']): Promise<PreflightResult> {
  const where = `${b.baseUrl} (${b.kind})`
  let models: string[]
  try { models = await backend.listModels() }
  catch (e) { return { ok: false, message: `preflight: ${unreachable(b, e)}` } }
  const info = await backend.serverInfo?.(b.model)
  if (b.apiKeyEnv !== undefined) {
    // A hosted API serves by name. Its list is long, so a refusal counts it instead of printing it.
    const listed = models.includes(b.model) || models.includes(withoutVariant(b.model))
    if (!listed && !backend.partialList) return { ok: false, message: `preflight: model ${b.model} is not among the ${models.length} models ${b.baseUrl} lists` }
  } else if (b.kind === 'ollama' || info?.router) {
    const names = b.kind === 'ollama' && !b.model.includes(':') ? [b.model, `${b.model}:latest`] : [b.model]
    if (!names.some(n => models.includes(n))) return { ok: false, message: `preflight: model ${b.model} is not on ${where}; it has: ${models.join(', ')}${b.kind === 'ollama' ? `; pull it with "ollama pull ${b.model}"` : ''}` }
  }
  // Ollama's window is the num_ctx the harness sends; without one it is Ollama's default, which the harness does not know.
  const { router: _, ...server } = info ?? {}
  if (b.kind === 'ollama') return { ok: true, server: { ...server, ...(b.numCtx ? { nCtx: b.numCtx } : {}) } }
  return { ok: true, server }
}

/** A budget that, with the response cap on top, does not fit the window cannot keep the run inside it. Off budget or unknown window → nothing to say. */
export function windowWarning(c: HarnessConfig, nCtx: number | undefined): string | undefined {
  const budget = c.context?.budgetTokens, cap = c.backend.maxTokens ?? 0
  if (!budget || !nCtx || budget + cap <= nCtx) return undefined
  const sum = cap ? `budgetTokens ${budget} + maxTokens ${cap} = ${budget + cap}` : `budgetTokens ${budget}`
  return `warning: ${c.name}: ${sum} is over the server window ${nCtx}; the budget cannot hold the window`
}
