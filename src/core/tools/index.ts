import type { ToolName } from '../config.js'
import type { ToolSchema } from '../backends/types.js'
import type { McpSession } from '../mcp.js'
import { listDir, readFile, writeFile, editFile, type ToolCtx } from './fs.js'
import { bash } from './bash.js'
export type { ToolCtx } from './fs.js'

const p = (props: Record<string, { type: string; description: string }>, required: string[]) =>
  ({ type: 'object', properties: props, required })

export const TOOL_SCHEMAS: Record<ToolName, ToolSchema> = {
  list_dir: { name: 'list_dir', description: 'List files in a directory (non-recursive). Directories end with "/". Hidden entries (dot-files) are omitted.', parameters: p({ path: { type: 'string', description: 'Directory path relative to the project root, "." for root' } }, ['path']) },
  read_file: { name: 'read_file', description: 'Read a text file. Large files are truncated.', parameters: p({ path: { type: 'string', description: 'File path relative to the project root' } }, ['path']) },
  write_file: { name: 'write_file', description: 'Create or overwrite a file with the given content.', parameters: p({ path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Full file content' } }, ['path', 'content']) },
  edit_file: { name: 'edit_file', description: 'Replace one exact occurrence of "old" with "new" in a file. "old" must occur exactly once.', parameters: p({ path: { type: 'string', description: 'File path' }, old: { type: 'string', description: 'Exact text to replace' }, new: { type: 'string', description: 'Replacement text' } }, ['path', 'old', 'new']) },
  bash: { name: 'bash', description: 'Run a shell command in the project root. Returns stdout+stderr and the exit code. 30s timeout.', parameters: p({ command: { type: 'string', description: 'Shell command' } }, ['command']) },
}

const IMPL: Record<ToolName, (a: Record<string, unknown>, c: ToolCtx) => Promise<string>> = {
  list_dir: listDir, read_file: readFile, write_file: writeFile, edit_file: editFile, bash,
}

export async function runTool(
  name: string, args: Record<string, unknown>, ctx: ToolCtx, enabled: ToolName[], mcp?: McpSession,
): Promise<{ output: string; error: boolean }> {
  if (!enabled.includes(name as ToolName)) {
    if (mcp?.has(name)) return mcp.call(name, args)
    const available = [...enabled, ...(mcp?.tools.map(t => t.name) ?? [])]
    return { error: true, output: `unknown tool ${name}; available: ${available.join(', ')}` }
  }
  const schema = TOOL_SCHEMAS[name as ToolName]
  const required = (schema.parameters as { required: string[] }).required
  for (const k of required) if (typeof args[k] !== 'string') return { error: true, output: `tool ${name}: missing or non-string argument "${k}"; required: ${required.join(', ')}` }
  try {
    return { output: await IMPL[name as ToolName](args, ctx), error: false }
  } catch (e) {
    return { output: `tool ${name} failed: ${(e as Error).message}`, error: true }
  }
}
