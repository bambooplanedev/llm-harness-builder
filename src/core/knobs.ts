// src/core/knobs.ts — which of a harness's knobs a model does not take. Types only: the form runs this in the browser.
import type { HarnessConfig } from './config.js'
import type { ServerInfo } from './backends/types.js'
import type { KnobOff } from './events.js'

/**
 * `off`: soft knobs the harness sets and the server says the model does not take; they are not sent, and the file keeps
 * them, so another model gets them back. `refuse`: a knob without which the harness would silently be another one, so the
 * run does not start. No `takes` is unknown, and everything is sent as before. `answerSchema`: the run's, as run.ts gets it.
 */
export function knobsOff(c: HarnessConfig, info: ServerInfo | undefined, answerSchema?: unknown): { off: KnobOff[]; refuse?: string; refuseKind?: 'tools' | 'schema' | 'maxTokens' } {
  const takes = info?.takes ?? {}, model = c.backend.model
  const why = (what: string) => `${model} takes no ${what}${info?.takesFrom ? ` (${info.takesFrom})` : ''}`
  const off: KnobOff[] = []
  if (takes.temperature === false) {
    off.push({ knob: 'temperature', value: c.backend.temperature, reason: why('temperature') })
    if (c.loop.repeatTemperature !== undefined) off.push({ knob: 'repeatTemperature', value: c.loop.repeatTemperature, reason: why('temperature') })
  }
  if (takes.maxTokens === false && c.backend.maxTokens !== undefined) off.push({ knob: 'maxTokens', value: c.backend.maxTokens, reason: why('max_tokens') })
  if (takes.think === false && c.backend.think !== undefined) off.push({ knob: 'think', value: c.backend.think, reason: why('thinking switch') })
  if (takes.reasoningEffort === false && c.backend.reasoningEffort !== undefined) off.push({ knob: 'reasoningEffort', value: c.backend.reasoningEffort, reason: why('reasoning effort') })
  // repeatThinkTokens is a thinking turn with its own max_tokens: without either it does nothing.
  const tt = c.loop.repeatThinkTokens
  if (tt !== undefined && (takes.think === false || takes.maxTokens === false))
    off.push({ knob: 'repeatThinkTokens', value: tt, reason: why(takes.think === false ? 'thinking switch' : 'max_tokens') })

  const native = c.toolCalls.mode === 'native'
  const hasTools = c.tools.enabled.length > 0 || Object.keys(c.mcpServers ?? {}).length > 0
  // Where run.ts sends a schema: prompted JSON (not hermes), or a native run with no tools and an answer schema.
  const sendsSchema = c.toolCalls.enforceSchema && (native ? !hasTools && answerSchema !== undefined : c.toolCalls.format !== 'hermes')
  if (takes.tools === false && native && hasTools) return { off, refuse: `${why('tools')}: set toolCalls.mode: "prompted"`, refuseKind: 'tools' }
  if (takes.responseSchema === false && sendsSchema) return { off, refuse: `${why('response schema')}: set toolCalls.enforceSchema: false`, refuseKind: 'schema' }
  if (c.backend.kind === 'anthropic' && c.backend.maxTokens === undefined && !info?.maxOutput)
    return { off, refuse: `${model}: the server did not say this model's max_tokens (GET /v1/models/${model} failed or the model is unknown), and the API needs a number: set backend.maxTokens`, refuseKind: 'maxTokens' }
  return { off }
}
