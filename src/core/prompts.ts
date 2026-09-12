import type { ToolSchema } from './backends/types.js'

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

export const DEFAULT_PROMPTED_TEMPLATE = [
  'You can call tools. Available tools:',
  '{{tools}}',
  '',
  'Respond with exactly one JSON object of this shape and nothing else:',
  '{"calls": [{"name": "<tool name>", "args": {...}}], "final": null}',
  'To finish, send {"calls": [], "final": "<your answer>"}.',
  'Tool results will be sent back to you inside <tool_result> tags.',
].join('\n')

export const DEMO_TASK = 'A user filed a bug report: it is the single ERROR line near the end of data/app.log (the file has thousands of lines, so grep or tail it instead of reading it whole). Fix src/slugify.js so the reported case works, then run `node --test` and make sure it passes. Finally answer with a one-line summary.'

export const DEFAULT_PARSE_ERROR_HINT =
  'Your last message was not a valid response. Reply with exactly one JSON object: {"calls": [...], "final": null|string}.'

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

export function renderTools(schemas: ToolSchema[]): string {
  return schemas
    .map(s => `- ${s.name}: ${s.description}\n  parameters: ${JSON.stringify(s.parameters)}`)
    .join('\n')
}
