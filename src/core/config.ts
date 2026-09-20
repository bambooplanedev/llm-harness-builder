export type ToolName = 'list_dir' | 'read_file' | 'write_file' | 'edit_file' | 'bash'
export const TOOL_NAMES: ToolName[] = ['list_dir', 'read_file', 'write_file', 'edit_file', 'bash']

export type BackendKind = 'openai' | 'ollama'

export type ToolCallFormat = 'json' | 'hermes'
export const TOOL_CALL_FORMATS: ToolCallFormat[] = ['json', 'hermes']

export type McpServerConfig = { command: string; args?: string[]; tools?: string[] }

export type HarnessConfig = {
  name: string
  backend: { kind: BackendKind; baseUrl: string; model: string; numCtx?: number; maxTokens?: number; temperature: number }
  systemPrompt: string
  tools: { enabled: ToolName[]; approveBash: boolean; requireReadBeforeEdit?: boolean; explainEditMiss?: boolean }
  toolCalls: { mode: 'native' | 'prompted'; format?: ToolCallFormat; enforceSchema: boolean; promptedTemplate: string; parseErrorHint: string }
  context: { maxToolOutputChars: number; budgetTokens: number }
  loop: { maxTurns: number; maxRepeats?: number; repeatTemperature?: number; freshContext?: number; untilBash?: string }
  mcpServers?: Record<string, McpServerConfig>
}

export type RunParams = { config: HarnessConfig; task: string; workdir: string }

// A misspelt key would be silently off, and every optional knob is off when absent. '' is the top level.
const KEYS: Record<string, string[]> = {
  '': ['name', 'backend', 'systemPrompt', 'tools', 'toolCalls', 'context', 'loop', 'mcpServers'],
  backend: ['kind', 'baseUrl', 'model', 'numCtx', 'maxTokens', 'temperature'],
  tools: ['enabled', 'approveBash', 'requireReadBeforeEdit', 'explainEditMiss'],
  toolCalls: ['mode', 'format', 'enforceSchema', 'promptedTemplate', 'parseErrorHint'],
  context: ['maxToolOutputChars', 'budgetTokens'],
  loop: ['maxTurns', 'maxRepeats', 'repeatTemperature', 'freshContext', 'untilBash'],
}
const MCP_SERVER_KEYS = ['command', 'args', 'tools']
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null

/** Returns a list of human-readable errors; empty list means valid. */
export function validateConfig(c: unknown): string[] {
  if (!isObj(c)) return ['config must be an object']
  const e: string[] = []
  const unknown = (o: unknown, known: string[], at: string) => { if (isObj(o) && !Array.isArray(o)) for (const k of Object.keys(o)) if (!known.includes(k)) e.push(`${at}${k} is not a known key`) }
  for (const [s, known] of Object.entries(KEYS)) unknown(s ? c[s] : c, known, s && s + '.')
  if (typeof c.name !== 'string' || !c.name) e.push('name is required')
  const b = c.backend
  if (!isObj(b)) e.push('backend is required')
  else {
    if (b.kind !== 'openai' && b.kind !== 'ollama') e.push('backend.kind must be openai|ollama')
    if (typeof b.baseUrl !== 'string' || !/^https?:\/\//.test(b.baseUrl)) e.push('backend.baseUrl must be an http(s) URL')
    if (typeof b.model !== 'string' || !b.model) e.push('backend.model is required')
    if (typeof b.temperature !== 'number') e.push('backend.temperature must be a number')
    if (b.numCtx !== undefined && !(Number.isInteger(b.numCtx) && b.numCtx > 0)) e.push('backend.numCtx must be a positive integer')
    if (b.maxTokens !== undefined && !(Number.isInteger(b.maxTokens) && b.maxTokens > 0)) e.push('backend.maxTokens must be a positive integer')
  }
  if (typeof c.systemPrompt !== 'string') e.push('systemPrompt must be a string')
  const t = c.tools
  if (!isObj(t) || !Array.isArray(t.enabled)) e.push('tools.enabled must be an array')
  else {
    for (const n of t.enabled) if (!TOOL_NAMES.includes(n)) e.push(`unknown tool: ${n}`)
    if (typeof t.approveBash !== 'boolean') e.push('tools.approveBash must be boolean')
    for (const k of ['requireReadBeforeEdit', 'explainEditMiss'] as const)
      if (t[k] !== undefined && typeof t[k] !== 'boolean') e.push(`tools.${k} must be boolean`)
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
  else {
    const l = c.loop
    if (l.maxRepeats !== undefined && !(Number.isInteger(l.maxRepeats) && l.maxRepeats >= 0)) e.push('loop.maxRepeats must be a non-negative integer')
    if (l.repeatTemperature !== undefined) {
      if (!(typeof l.repeatTemperature === 'number' && l.repeatTemperature >= 0 && l.repeatTemperature <= 2)) e.push('loop.repeatTemperature must be a number from 0 to 2')
      if (l.maxRepeats === undefined) e.push('loop.repeatTemperature needs loop.maxRepeats: a repeat is what that detector counts')
    }
    // Blank is not harmless: `sh -c "  "` exits 0, so the check would pass the first time the model says it is done.
    if (l.untilBash !== undefined && !(typeof l.untilBash === 'string' && l.untilBash.trim())) e.push('loop.untilBash must be a non-blank shell command')
    if (l.freshContext !== undefined) {
      if (l.maxRepeats === undefined) e.push('loop.freshContext needs loop.maxRepeats: a repeat is what that detector counts')
      // Above maxRepeats the run has already ended repeat_loop; with maxRepeats 0 no value fits.
      else if (!(Number.isInteger(l.freshContext) && l.freshContext >= 1 && l.freshContext <= l.maxRepeats)) e.push('loop.freshContext must be an integer from 1 to loop.maxRepeats')
    }
  }
  const ms = c.mcpServers
  if (ms !== undefined) {
    if (!isObj(ms) || Array.isArray(ms)) e.push('mcpServers must be an object')
    else for (const [k, v] of Object.entries(ms)) {
      if (!k) { e.push('mcpServers key must be a non-empty string'); continue }
      if (!isObj(v) || Array.isArray(v)) { e.push(`mcpServers.${k} must be an object`); continue }
      unknown(v, MCP_SERVER_KEYS, `mcpServers.${k}.`)
      if (typeof v.command !== 'string' || !v.command) e.push(`mcpServers.${k}.command must be a non-empty string`)
      const strs = (x: unknown) => Array.isArray(x) && x.every(s => typeof s === 'string')
      if (v.args !== undefined && !strs(v.args)) e.push(`mcpServers.${k}.args must be an array of strings`)
      if (v.tools !== undefined && !strs(v.tools)) e.push(`mcpServers.${k}.tools must be an array of strings`)
    }
  }
  return e
}
