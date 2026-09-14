import type { ToolSchema } from './backends/types.js'
import type { HarnessConfig, ToolCallFormat } from './config.js'

export const PRESETS = {
  minimal: 'You are a coding agent. Use the tools to complete the task.',
  'opencode-like': [
    'You are a coding agent working inside a project directory.',
    'Work in small steps: inspect before you change, verify after you change.',
    'Prefer read_file/list_dir over bash for reading. Never read a large file whole: grep, head or tail it through bash.',
    'Never guess file contents. Read a file before you change it; edit_file\'s "old" must match the file character for character, so for a short file prefer write_file with the full new contents.',
    'When the task is complete, answer with a short summary and no further tool calls.',
  ].join('\n'),
  'strict-json': [
    'You are a coding agent. You MUST respond with a single JSON object and nothing else.',
    'Never write prose outside the JSON. Set "final" only when the task is complete.',
  ].join('\n'),
} as const

const ONE_CALL_RULE = 'Send one call per response. Put several calls in one response only when they are independent reads; never send an edit or a command in the same response as the call whose output it depends on.'

export const DEFAULT_PROMPTED_TEMPLATE = [
  'You can call tools. Available tools:',
  '{{tools}}',
  '',
  'Respond with exactly one JSON object of this shape and nothing else:',
  '{"calls": [{"name": "<tool name>", "args": {...}}], "final": null}',
  ONE_CALL_RULE,
  'To finish, send {"calls": [], "final": "<your answer>"}.',
  'Tool results will be sent back to you inside <tool_result> tags.',
].join('\n')

export const DEFAULT_PARSE_ERROR_HINT =
  'Your last message was not a valid response. Reply with exactly one JSON object: {"calls": [...], "final": null|string}.'

/** Mirrors the tool section of the Qwen2.5/Qwen3 chat template so a prompted run looks like what the model was trained on. */
export const HERMES_TEMPLATE = [
  '# Tools',
  '',
  'You may call one or more functions to assist with the user query.',
  'You are provided with function signatures within <tools></tools> XML tags:',
  '<tools>',
  '{{tools}}',
  '</tools>',
  '',
  'For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:',
  '<tool_call>',
  '{"name": <function-name>, "arguments": <args-json-object>}',
  '</tool_call>',
  ONE_CALL_RULE + ' Results come back inside <tool_response></tool_response> tags in the same order.',
  'When the task is complete, answer in plain text with no <tool_call> block.',
].join('\n')

export const HERMES_PARSE_ERROR_HINT =
  'Your last message had a malformed <tool_call> block. Each block must contain exactly one JSON object with "name" and "arguments".'

export const DEMO_TASK = 'A user filed a bug report: it is the single ERROR line near the end of data/app.log (the file has thousands of lines, so grep or tail it instead of reading it whole). Fix src/slugify.js so the reported case works, then run `node --test` and make sure it passes. Finally answer with a one-line summary.'

export const PROMPTED_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, args: { type: 'object' } },
        required: ['name', 'args'],
      },
    },
    final: { type: ['string', 'null'] },
  },
  required: ['calls', 'final'],
}

export function renderTools(schemas: ToolSchema[], format: ToolCallFormat = 'json'): string {
  if (format === 'hermes')
    return schemas.map(s => JSON.stringify({ type: 'function', function: { name: s.name, description: s.description, parameters: s.parameters } })).join('\n')
  return schemas
    .map(s => `- ${s.name}: ${s.description}\n  parameters: ${JSON.stringify(s.parameters)}`)
    .join('\n')
}

export type Family = {
  mode: 'native' | 'prompted'
  format: ToolCallFormat
  /** Appended as its own last line of systemPrompt; '' = nothing. */
  systemSuffix: string
  promptedTemplate: string
  parseErrorHint: string
  /** One line for the UI tooltip and the README table. */
  note: string
}

export const FAMILIES: Record<'qwen3' | 'gemma' | 'llama3', Family> = {
  qwen3: {
    mode: 'prompted', format: 'hermes', systemSuffix: '/no_think', promptedTemplate: HERMES_TEMPLATE, parseErrorHint: HERMES_PARSE_ERROR_HINT,
    note: 'trained on <tool_call> XML; /no_think keeps the 8B from burning the window in <think>',
  },
  gemma: {
    mode: 'prompted', format: 'json', systemSuffix: '', promptedTemplate: DEFAULT_PROMPTED_TEMPLATE, parseErrorHint: DEFAULT_PARSE_ERROR_HINT,
    note: 'no native tool calling in the chat template (Ollama rejects tools[]); no thinking switch',
  },
  llama3: {
    mode: 'native', format: 'json', systemSuffix: '', promptedTemplate: DEFAULT_PROMPTED_TEMPLATE, parseErrorHint: DEFAULT_PARSE_ERROR_HINT,
    note: 'native tool calls work through the chat template; nothing to add to the prompt',
  },
}

/** Fills the family's mode/format/template/hint and swaps the trailing family line of systemPrompt. Pure; never touches other fields. */
export function applyFamily(config: HarnessConfig, key: string): HarnessConfig {
  const f = (FAMILIES as Record<string, Family>)[key]
  if (!f) throw new Error(`unknown family "${key}"; available: ${Object.keys(FAMILIES).join(', ')}`)
  const suffixes = Object.values(FAMILIES).map(x => x.systemSuffix).filter(Boolean)
  const lines = config.systemPrompt.split('\n')
  while (lines.length) {
    const last = lines[lines.length - 1].trim()
    if (last === '' || suffixes.includes(last)) lines.pop()
    else break
  }
  if (f.systemSuffix) lines.push(f.systemSuffix)
  return {
    ...config,
    systemPrompt: lines.join('\n'),
    toolCalls: { ...config.toolCalls, mode: f.mode, format: f.format, promptedTemplate: f.promptedTemplate, parseErrorHint: f.parseErrorHint },
  }
}
