import type { HarnessConfig } from './api'
import { PRESETS, DEFAULT_PROMPTED_TEMPLATE, DEFAULT_PARSE_ERROR_HINT } from '../../src/core/prompts'

/** What a new harness starts as. */
export const NEW_HARNESS: HarnessConfig = {
  name: 'new', backend: { kind: 'ollama', baseUrl: 'http://localhost:11434', model: '', numCtx: 8192, temperature: 0.2 },
  systemPrompt: PRESETS.minimal, tools: { enabled: ['list_dir', 'read_file', 'write_file', 'edit_file', 'bash'], approveBash: true },
  toolCalls: { mode: 'native', format: 'json', enforceSchema: false, promptedTemplate: DEFAULT_PROMPTED_TEMPLATE, parseErrorHint: DEFAULT_PARSE_ERROR_HINT },
  context: { maxToolOutputChars: 4000 }, loop: { maxTurns: 15 },
}

/** The Advanced knobs' effective values: absent is the built-in behaviour, so absent and the same-as-built-in compare equal. */
const knobs = (c: HarnessConfig) => [
  !!c.tools.requireReadBeforeEdit, c.tools.editMissEscalation, c.tools.readMaxBytes, c.tools.bashMaxBytes, c.tools.bashTimeoutS,
  c.context?.maxToolOutputChars, c.context?.budgetTokens || undefined,
  c.loop.maxRepeats, c.loop.freshContext, c.loop.repeatTemperature, c.loop.repeatThinkTokens, c.loop.untilBash,
  Object.keys(c.mcpServers ?? {}).length ? JSON.stringify(c.mcpServers) : undefined,
  c.toolCalls.promptedTemplate || DEFAULT_PROMPTED_TEMPLATE, c.toolCalls.parseErrorHint || DEFAULT_PARSE_ERROR_HINT,
]

/** How many Advanced knobs differ from a new harness. */
export const advancedSet = (c: HarnessConfig): number => {
  const a = knobs(c), b = knobs(NEW_HARNESS)
  return a.filter((v, i) => v !== b[i]).length
}
