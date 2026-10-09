// src/core/preflight.ts — what `bench` asks a server before the first run: does it answer, has it the model, how big is its window.
import type { Backend, ServerInfo } from './backends/types.js'
import type { HarnessConfig } from './config.js'

export type PreflightResult = { ok: true; server: Omit<ServerInfo, 'router'> } | { ok: false; message: string }

/**
 * No generation: a list of models and llama-server's /props, nothing that costs model time (a router
 * does load the named model to report its window — the bench would load it anyway). The model name
 * is checked only where the server serves by it: Ollama, and a llama-server router. A one-model
 * llama-server answers any name with the model it has.
 */
export async function preflight(backend: Backend, b: HarnessConfig['backend']): Promise<PreflightResult> {
  const where = `${b.baseUrl} (${b.kind})`
  let models: string[]
  try { models = await backend.listModels() }
  catch (e) { return { ok: false, message: `preflight: ${where} does not answer: ${(e as Error).message}` } }
  const info = b.kind === 'openai' ? await backend.serverInfo?.(b.model) : undefined
  if (b.kind === 'ollama' || info?.router) {
    const names = b.kind === 'ollama' && !b.model.includes(':') ? [b.model, `${b.model}:latest`] : [b.model]
    if (!names.some(n => models.includes(n))) return { ok: false, message: `preflight: model ${b.model} is not on ${where}; it has: ${models.join(', ')}` }
  }
  // Ollama's window is the num_ctx the harness sends; without one it is Ollama's default, which the harness does not know.
  if (b.kind === 'ollama') return { ok: true, server: b.numCtx ? { nCtx: b.numCtx } : {} }
  const { router: _, ...server } = info ?? {}
  return { ok: true, server }
}

/** A budget that, with the response cap on top, does not fit the window cannot keep the run inside it. Off budget or unknown window → nothing to say. */
export function windowWarning(c: HarnessConfig, nCtx: number | undefined): string | undefined {
  const budget = c.context.budgetTokens, cap = c.backend.maxTokens ?? 0
  if (!budget || !nCtx || budget + cap <= nCtx) return undefined
  const sum = cap ? `budgetTokens ${budget} + maxTokens ${cap} = ${budget + cap}` : `budgetTokens ${budget}`
  return `warning: ${c.name}: ${sum} is over the server window ${nCtx}; the budget cannot hold the window`
}
