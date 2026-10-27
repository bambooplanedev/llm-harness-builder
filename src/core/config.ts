import { isShowable } from './events.js'
import type { Note } from './notes.js'

export type ToolName = 'list_dir' | 'read_file' | 'write_file' | 'edit_file' | 'bash'
export const TOOL_NAMES: ToolName[] = ['list_dir', 'read_file', 'write_file', 'edit_file', 'bash']

export type BackendKind = 'openai' | 'ollama' | 'anthropic'

export type ToolCallFormat = 'json' | 'hermes'
const TOOL_CALL_FORMATS: ToolCallFormat[] = ['json', 'hermes']

/** A name `tools.bashEnv` may hold: a shell variable name. The value always comes from the user's environment. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** What `backend.apiKeyEnv` may name: an upper-case variable whose name says it holds an API key. A harness file from
 *  someone else picks the variable and the host it goes to; this keeps GITHUB_TOKEN and AWS_* out of its reach, and a
 *  key pasted in place of the name never matches, so it is never printed back. */
export const KEY_ENV = /^[A-Z][A-Z0-9_]*_API_KEY$/
/** A key shorter than this is not redacted: replacing a short value would rewrite ordinary words in what a model reads. */
export const REDACT_MIN = 20
/** The hosts a key may reach over plain http: this machine. Compared with URL's normalised hostname, never the string. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** How the key's rules name the fields: the harness file's names, or replay's flags. */
export type KeyWords = { key: string; kind: string; url: string }
const FILE_WORDS: KeyWords = { key: 'backend.apiKeyEnv', kind: 'kind openai or anthropic', url: 'an https baseUrl' }
export const FLAG_WORDS: KeyWords = { key: '--api-key-env', kind: '--kind openai or anthropic', url: 'an https --base-url' }
export const keyNameMessage = (field: string) => `${field} must be an upper-case variable name ending in _API_KEY (like OPENROUTER_API_KEY)`

/** An http(s) URL that URL can parse: the prefix alone lets `https://` and `http://[::1` through, to fail later with a stack. */
export function isHttpUrl(s: unknown): s is string {
  if (typeof s !== 'string' || !/^https?:\/\//.test(s)) return false
  try { new URL(s); return true } catch { return false }
}

type KeyFields = { kind?: unknown; baseUrl?: unknown; apiKeyEnv?: unknown; think?: unknown }

/** The rules a key brings: its name, the kind it goes to, a URL it may cross the network to, and no `think`. A backend
 *  with a key is a hosted API; `think` is barred only for openai, whose API defines nothing of it. An unparsable URL is backendErrors' to say. */
export function keyErrors(b: KeyFields, w: KeyWords = FILE_WORDS): string[] {
  if (b.apiKeyEnv === undefined) return []
  const e: string[] = []
  if (typeof b.apiKeyEnv !== 'string' || !KEY_ENV.test(b.apiKeyEnv)) e.push(keyNameMessage(w.key))
  if (b.kind !== 'openai' && b.kind !== 'anthropic') e.push(`${w.key} needs ${w.kind}: a key goes only to an OpenAI-compatible or the Anthropic API`)
  if (isHttpUrl(b.baseUrl)) {
    const u = new URL(b.baseUrl)
    if (u.protocol !== 'https:' && !LOOPBACK.has(u.hostname))
      e.push(`${w.key} needs ${w.url} (http only on localhost, 127.0.0.1 or [::1]): the key would cross the network in clear text`)
  }
  if (b.think !== undefined && b.kind === 'openai') e.push(`backend.think cannot go with ${w.key}: a hosted API gets only what the OpenAI API defines`)
  return e
}

/** Whether a URL points at this machine: a list from a server elsewhere — a hosted API above all — is never auto-picked from. */
export const isLoopbackUrl = (s: unknown): boolean => isHttpUrl(s) && LOOPBACK.has(new URL(s).hostname)

/** Whether the form may ask serve for the model list by itself. Never with a key: that request carries the key to
 *  baseUrl, and opening someone else's harness or a bench run must not send it anywhere. With a key the list comes
 *  on the refresh button. */
export const listsModelsByItself = (b: { apiKeyEnv?: unknown }): boolean => b.apiKeyEnv === undefined

/** The checks of `backend` that need no model: kind, URL and the key's rules. POST /api/models runs these alone. */
export function backendErrors(b: Record<string, unknown>): string[] {
  const e: string[] = []
  if (b.kind !== 'openai' && b.kind !== 'ollama' && b.kind !== 'anthropic') e.push('backend.kind must be openai|ollama|anthropic')
  if (!isHttpUrl(b.baseUrl)) e.push('backend.baseUrl must be an http(s) URL')
  return [...e, ...keyErrors(b)]
}

/** The value of a variable the environment itself holds: `toString` and the other names every object inherits are not
 *  variables, though a name pattern may let them through. */
const own = (env: Record<string, string | undefined>, name: string): string | undefined =>
  Object.hasOwn(env, name) && typeof env[name] === 'string' ? env[name] : undefined

/** What is wrong with the value `apiKeyEnv` names, if anything — never the value itself. Called once keyErrors is clean. */
export function keyProblem(b: { apiKeyEnv?: string }, env: Record<string, string | undefined>): string | undefined {
  const name = b.apiKeyEnv
  if (name === undefined) return undefined
  const raw = own(env, name)
  if (raw === undefined) return `${name} is not set`
  const v = raw.trim()
  if (!v) return `${name} is empty`
  // undici repeats a header value it refuses, whole, in its error message: such a value must never reach a request.
  if (!/^[\x21-\x7e]+$/.test(v)) return `${name} holds characters an API key cannot have (spaces, control characters or non-ASCII)`
  return undefined
}

/** The key itself: the trimmed value, once keyProblem has nothing to say. */
export function apiKey(b: { apiKeyEnv?: string }, env: Record<string, string | undefined>): string | undefined {
  if (b.apiKeyEnv === undefined || keyProblem(b, env)) return undefined
  return own(env, b.apiKeyEnv)!.trim()
}

/** The line run, demo, bench and replay print before the first request, and the UI shows under the backend: which
 *  variable goes to which host. Nothing without a key, or for a name validation would refuse or a URL that does not
 *  parse — a key pasted in place of the name is never printed back. With `env`, a value too short to redact says so. */
export function keyNote(b: { apiKeyEnv?: unknown; baseUrl?: unknown }, env?: Record<string, string | undefined>): string | undefined {
  if (typeof b.apiKeyEnv !== 'string' || !KEY_ENV.test(b.apiKeyEnv) || !isHttpUrl(b.baseUrl)) return undefined
  const v = env ? own(env, b.apiKeyEnv)?.trim() : undefined
  const short = v && v.length < REDACT_MIN ? ` (shorter than ${REDACT_MIN} characters, so it is not redacted)` : ''
  return `the key in ${b.apiKeyEnv} goes to ${new URL(b.baseUrl).host}${short}`
}

/** Dollars per million tokens; cache prices default to input's. */
export type Price = { input: number; output: number; cacheRead?: number; cacheWrite?: number }

/** A hosted reasoning model's effort setting; OpenRouter and OpenAI define exactly these three. */
export type ReasoningEffort = 'low' | 'medium' | 'high'
export const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high']

export type McpServerConfig = { command: string; args?: string[]; tools?: string[] }

export type HarnessConfig = {
  name: string
  /** One line on what the harness is for; a label, so a diff ignores it. */
  description?: string
  backend: { kind: BackendKind; baseUrl: string; model: string; numCtx?: number; maxTokens?: number; think?: boolean; reasoningEffort?: ReasoningEffort; temperature: number; apiKeyEnv?: string; pricePerMTok?: Price }
  systemPrompt: string
  tools: { enabled: ToolName[]; approveBash: boolean; requireReadBeforeEdit?: boolean; explainEditMiss?: boolean; editMissEscalation?: number; bashEnv?: string[]; readMaxBytes?: number; bashMaxBytes?: number; bashTimeoutS?: number }
  toolCalls: { mode: 'native' | 'prompted'; format?: ToolCallFormat; enforceSchema: boolean; promptedTemplate: string; parseErrorHint: string }
  /** Both limits are off when absent; budgetTokens 0 is off too. */
  context?: { maxToolOutputChars?: number; budgetTokens?: number }
  loop: { maxTurns: number; maxRepeats?: number; repeatTemperature?: number; repeatThinkTokens?: number; freshContext?: number; untilBash?: string }
  mcpServers?: Record<string, McpServerConfig>
  /** Notes from earlier runs; see src/core/notes.ts. Absent = off. No path or command in it, on purpose. */
  notes?: { enabled: boolean; maxTokens: number }
}

/** `answerSchema`: the JSON form of the final answer, when the task has one. It is enforced only by a harness with no tools at all and `toolCalls.enforceSchema` on.
 *  `notes`: already selected (notes.ts selectNotes), sent after the task. */
export type RunParams = { config: HarnessConfig; task: string; workdir: string; answerSchema?: Record<string, unknown>; notes?: Note[] }

/** Whether a run of this harness sends `answerSchema` at all — what `run --answer-schema` asks before any model time. The run itself looks at the tools it ended up with. */
export const sendsAnswerSchema = (c: HarnessConfig): boolean =>
  c.toolCalls.mode === 'native' && c.toolCalls.enforceSchema && !c.tools.enabled.length && !Object.keys(c.mcpServers ?? {}).length

// A misspelt key would be silently off, and every optional knob is off when absent. '' is the top level.
const KEYS: Record<string, string[]> = {
  '': ['name', 'description', 'backend', 'systemPrompt', 'tools', 'toolCalls', 'context', 'loop', 'mcpServers', 'notes'],
  backend: ['kind', 'baseUrl', 'model', 'numCtx', 'maxTokens', 'think', 'reasoningEffort', 'temperature', 'apiKeyEnv', 'pricePerMTok'],
  tools: ['enabled', 'approveBash', 'requireReadBeforeEdit', 'explainEditMiss', 'editMissEscalation', 'bashEnv', 'readMaxBytes', 'bashMaxBytes', 'bashTimeoutS'],
  toolCalls: ['mode', 'format', 'enforceSchema', 'promptedTemplate', 'parseErrorHint'],
  context: ['maxToolOutputChars', 'budgetTokens'],
  loop: ['maxTurns', 'maxRepeats', 'repeatTemperature', 'repeatThinkTokens', 'freshContext', 'untilBash'],
  notes: ['enabled', 'maxTokens'],
}
const MCP_SERVER_KEYS = ['command', 'args', 'tools']
const PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite']
/** The thinking switch `loop.repeatThinkTokens` flips: a line of its own, which is how the qwen3 family writes it. */
export const NO_THINK_LINE = /^\/no_think$/m
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null

/** Returns a list of human-readable errors; empty list means valid. */
export function validateConfig(c: unknown): string[] {
  if (!isObj(c)) return ['config must be an object']
  const e: string[] = []
  const unknown = (o: unknown, known: string[], at: string) => { if (isObj(o) && !Array.isArray(o)) for (const k of Object.keys(o)) if (!known.includes(k)) e.push(`${at}${k} is not a known key`) }
  for (const [s, known] of Object.entries(KEYS)) unknown(s ? c[s] : c, known, s && s + '.')
  if (typeof c.name !== 'string' || !c.name) e.push('name is required')
  // The name is printed on the terminal (bench's progress lines and table); this message does not print it back.
  else if (!isShowable(c.name)) e.push('name must not contain control or format characters')
  if (c.description !== undefined && typeof c.description !== 'string') e.push('description must be a string')
  const b = c.backend
  if (!isObj(b)) e.push('backend is required')
  else {
    e.push(...backendErrors(b))
    // Not in backendErrors: POST /api/models runs those alone, and the form has no key yet while it is being filled in.
    if (b.kind === 'anthropic' && b.apiKeyEnv === undefined) e.push('backend.kind anthropic needs backend.apiKeyEnv')
    if (typeof b.model !== 'string' || !b.model) e.push('backend.model is required')
    if (typeof b.temperature !== 'number') e.push('backend.temperature must be a number')
    if (b.numCtx !== undefined && !(Number.isInteger(b.numCtx) && b.numCtx > 0)) e.push('backend.numCtx must be a positive integer')
    if (b.maxTokens !== undefined && !(Number.isInteger(b.maxTokens) && b.maxTokens > 0)) e.push('backend.maxTokens must be a positive integer')
    if (b.think !== undefined && typeof b.think !== 'boolean') e.push('backend.think must be true or false')
    if (b.reasoningEffort !== undefined) {
      if (!REASONING_EFFORTS.includes(b.reasoningEffort)) e.push('backend.reasoningEffort must be low|medium|high')
      if (b.kind !== 'openai') e.push('backend.reasoningEffort goes only with kind openai')
    }
    const pr = b.pricePerMTok
    if (pr !== undefined) {
      if (!isObj(pr) || Array.isArray(pr)) e.push('backend.pricePerMTok must be an object')
      else {
        unknown(pr, PRICE_KEYS, 'backend.pricePerMTok.')
        for (const k of PRICE_KEYS) {
          const v = pr[k], ok = typeof v === 'number' && Number.isFinite(v) && v >= 0
          if (v === undefined ? k === 'input' || k === 'output' : !ok) e.push(`backend.pricePerMTok.${k} must be a finite non-negative number${k === 'input' || k === 'output' ? '' : ' or absent'}`)
        }
      }
    }
  }
  if (typeof c.systemPrompt !== 'string') e.push('systemPrompt must be a string')
  const t = c.tools
  if (!isObj(t) || !Array.isArray(t.enabled)) e.push('tools.enabled must be an array')
  else {
    for (const n of t.enabled) if (!TOOL_NAMES.includes(n)) e.push(`unknown tool: ${n}`)
    if (typeof t.approveBash !== 'boolean') e.push('tools.approveBash must be boolean')
    for (const k of ['requireReadBeforeEdit', 'explainEditMiss'] as const)
      if (t[k] !== undefined && typeof t[k] !== 'boolean') e.push(`tools.${k} must be boolean`)
    if (t.editMissEscalation !== undefined && !(Number.isInteger(t.editMissEscalation) && t.editMissEscalation >= 1)) e.push('tools.editMissEscalation must be a positive integer')
    for (const k of ['readMaxBytes', 'bashMaxBytes', 'bashTimeoutS'] as const)
      if (t[k] !== undefined && !(Number.isInteger(t[k]) && t[k] > 0)) e.push(`tools.${k} must be a positive integer`)
    // setTimeout runs a delay above 2^31-1 ms after 1 ms, which would kill every command at once.
    if (Number.isInteger(t.bashTimeoutS) && t.bashTimeoutS > 2147483) e.push('tools.bashTimeoutS must be at most 2147483')
    if (t.bashEnv !== undefined && !(Array.isArray(t.bashEnv) && t.bashEnv.every((n: unknown) => typeof n === 'string' && ENV_NAME.test(n)))) e.push('tools.bashEnv must be an array of environment variable names')
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
    if (isObj(b) && b.kind === 'anthropic' && tc.mode === 'prompted' && tc.enforceSchema === true) e.push('toolCalls.enforceSchema cannot go with prompted mode on kind anthropic: its schema leaves args free; use enforceSchema: false or mode: "native"')
  }
  const cx = c.context
  if (cx !== undefined && !isObj(cx)) e.push('context must be an object')
  else if (cx) {
    if (cx.maxToolOutputChars !== undefined && !(Number.isInteger(cx.maxToolOutputChars) && cx.maxToolOutputChars > 0)) e.push('context.maxToolOutputChars must be a positive integer')
    if (cx.budgetTokens !== undefined && !(Number.isInteger(cx.budgetTokens) && cx.budgetTokens >= 0)) e.push('context.budgetTokens must be a non-negative integer')
  }
  const n = c.notes
  if (n !== undefined && (!isObj(n) || Array.isArray(n))) e.push('notes must be an object')
  else if (n) {
    if (typeof n.enabled !== 'boolean') e.push('notes.enabled must be boolean')
    if (n.enabled && !(Number.isInteger(n.maxTokens) && n.maxTokens > 0)) e.push('notes.maxTokens must be a positive integer')
  }
  if (!isObj(c.loop) || !(Number.isInteger(c.loop.maxTurns) && c.loop.maxTurns > 0)) e.push('loop.maxTurns must be a positive integer')
  else {
    const l = c.loop
    if (l.maxRepeats !== undefined && !(Number.isInteger(l.maxRepeats) && l.maxRepeats >= 0)) e.push('loop.maxRepeats must be a non-negative integer')
    if (l.repeatTemperature !== undefined) {
      if (!(typeof l.repeatTemperature === 'number' && l.repeatTemperature >= 0 && l.repeatTemperature <= 2)) e.push('loop.repeatTemperature must be a number from 0 to 2')
      if (l.maxRepeats === undefined) e.push('loop.repeatTemperature needs loop.maxRepeats: a repeat is what that detector counts')
    }
    if (l.repeatThinkTokens !== undefined) {
      if (!(Number.isInteger(l.repeatThinkTokens) && l.repeatThinkTokens > 0)) e.push('loop.repeatThinkTokens must be a positive integer')
      if (l.maxRepeats === undefined) e.push('loop.repeatThinkTokens needs loop.maxRepeats: a repeat is what that detector counts')
      // Without the line there is nothing to flip, and the knob would be silently off.
      if (typeof c.systemPrompt === 'string' && !NO_THINK_LINE.test(c.systemPrompt)) e.push('loop.repeatThinkTokens needs a line "/no_think" in systemPrompt: that line is what it turns into "/think"')
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
  let unsafeKey = false // said once, whichever key is the first
  if (ms !== undefined) {
    if (!isObj(ms) || Array.isArray(ms)) e.push('mcpServers must be an object')
    else for (const [k, v] of Object.entries(ms)) {
      if (!k) { e.push('mcpServers key must be a non-empty string'); continue }
      // A key is printed in the approval question and in the server's line. No message after this one names it: a key that
      // redraws the line would do so in that message too.
      if (!isShowable(k)) { if (!unsafeKey) e.push('mcpServers keys must not contain control or format characters'); unsafeKey = true; continue }
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
