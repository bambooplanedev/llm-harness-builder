export type ToolName = 'list_dir' | 'read_file' | 'write_file' | 'edit_file' | 'bash'
export const TOOL_NAMES: ToolName[] = ['list_dir', 'read_file', 'write_file', 'edit_file', 'bash']

export type BackendKind = 'openai' | 'ollama'

export type ToolCallFormat = 'json' | 'hermes'
export const TOOL_CALL_FORMATS: ToolCallFormat[] = ['json', 'hermes']

export type HarnessConfig = {
  name: string
  backend: { kind: BackendKind; baseUrl: string; model: string; numCtx?: number; temperature: number }
  systemPrompt: string
  tools: { enabled: ToolName[]; approveBash: boolean }
  toolCalls: { mode: 'native' | 'prompted'; format?: ToolCallFormat; enforceSchema: boolean; promptedTemplate: string; parseErrorHint: string }
  context: { maxToolOutputChars: number; budgetTokens: number }
  loop: { maxTurns: number }
}

export type RunParams = { config: HarnessConfig; task: string; workdir: string }

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null

/** Returns a list of human-readable errors; empty list means valid. */
export function validateConfig(c: unknown): string[] {
  if (!isObj(c)) return ['config must be an object']
  const e: string[] = []
  if (typeof c.name !== 'string' || !c.name) e.push('name is required')
  const b = c.backend
  if (!isObj(b)) e.push('backend is required')
  else {
    if (b.kind !== 'openai' && b.kind !== 'ollama') e.push('backend.kind must be openai|ollama')
    if (typeof b.baseUrl !== 'string' || !/^https?:\/\//.test(b.baseUrl)) e.push('backend.baseUrl must be an http(s) URL')
    if (typeof b.model !== 'string' || !b.model) e.push('backend.model is required')
    if (typeof b.temperature !== 'number') e.push('backend.temperature must be a number')
    if (b.numCtx !== undefined && !(Number.isInteger(b.numCtx) && b.numCtx > 0)) e.push('backend.numCtx must be a positive integer')
  }
  if (typeof c.systemPrompt !== 'string') e.push('systemPrompt must be a string')
  const t = c.tools
  if (!isObj(t) || !Array.isArray(t.enabled)) e.push('tools.enabled must be an array')
  else {
    for (const n of t.enabled) if (!TOOL_NAMES.includes(n)) e.push(`unknown tool: ${n}`)
    if (typeof t.approveBash !== 'boolean') e.push('tools.approveBash must be boolean')
  }
  const tc = c.toolCalls
  if (!isObj(tc)) e.push('toolCalls is required')
  else {
    if (tc.mode !== 'native' && tc.mode !== 'prompted') e.push('toolCalls.mode must be native|prompted')
    if (tc.format !== undefined && !TOOL_CALL_FORMATS.includes(tc.format)) e.push('toolCalls.format must be json|hermes')
    if (typeof tc.enforceSchema !== 'boolean') e.push('toolCalls.enforceSchema must be boolean')
    if (typeof tc.promptedTemplate !== 'string') e.push('toolCalls.promptedTemplate must be a string')
    if (tc.mode === 'prompted' && !String(tc.promptedTemplate ?? '').includes('{{tools}}')) e.push('toolCalls.promptedTemplate must contain {{tools}} in prompted mode')
    if (typeof tc.parseErrorHint !== 'string') e.push('toolCalls.parseErrorHint must be a string')
  }
  const cx = c.context
  if (!isObj(cx) || !(cx.maxToolOutputChars > 0) || !(cx.budgetTokens >= 0)) e.push('context.maxToolOutputChars > 0 and budgetTokens >= 0 required')
  if (!isObj(c.loop) || !(Number.isInteger(c.loop.maxTurns) && c.loop.maxTurns > 0)) e.push('loop.maxTurns must be a positive integer')
  return e
}
