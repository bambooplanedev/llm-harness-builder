import type { Usage } from './backends/types.js'

export type ToolCall = { callId: string; name: string; args: Record<string, unknown>; backendId?: string }
export type DoneReason = 'final' | 'max_turns' | 'parse_failed' | 'aborted' | 'backend_error' | 'mcp_error' | 'repeat_loop'

type Base = { seq: number; turn: number; ts: number }

export type HarnessEvent = Base & (
  | { type: 'llm_request'; payload: unknown }
  | { type: 'llm_response'; raw: unknown; content: string; reasoning?: string; usage?: Usage; latencyMs: number }
  | { type: 'parse_error'; message: string; content: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'approval_required'; call: ToolCall }
  | { type: 'tool_result'; callId: string; name: string; output: string; truncated: boolean; error: boolean }
  | { type: 'context_stats'; estimatedTokens: number; exactTokens?: number; budgetTokens: number; droppedChars: number; usage?: Usage }
  | { type: 'mcp_server_start'; server: string; command: string; args: string[]
      offered: number; tools: string[]; descriptionChars: number; schemaChars: number }
  | { type: 'error'; message: string; body?: string }
  | { type: 'done'; reason: DoneReason; text?: string; turns: number; toolCallCount: number }
)

export type DoneEvent = Extract<HarnessEvent, { type: 'done' }>
export type McpStartEvent = Extract<HarnessEvent, { type: 'mcp_server_start' }>

/** `final` with no tool call at all: the model answered without doing anything. The CLI trace, the UI and the diff all mark this as a failure. */
export const quitWithoutWork = (e: DoneEvent): boolean => e.reason === 'final' && e.toolCallCount === 0

/** What one mcp server cost, without the server name: the CLI and the UI put their own prefix in front. */
export const mcpCounts = (e: McpStartEvent): string =>
  `${e.offered} offered, ${e.tools.length} tools, ${e.descriptionChars} desc + ${e.schemaChars} schema chars`

/** Approval calls that start an mcp server are named `mcp:<server>`; run.ts writes the name, the CLI and the UI read it back. */
const MCP_PREFIX = 'mcp:'
export const mcpApprovalName = (server: string): string => MCP_PREFIX + server
/** The server an approval call would start, or null when the call is an ordinary tool. */
export const mcpApprovalServer = (callName: string): string | null =>
  callName.startsWith(MCP_PREFIX) ? callName.slice(MCP_PREFIX.length) : null
