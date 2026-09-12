import type { Usage } from './backends/types.js'

export type ToolCall = { callId: string; name: string; args: Record<string, unknown>; backendId?: string }
export type DoneReason = 'final' | 'max_turns' | 'parse_failed' | 'aborted' | 'backend_error'

type Base = { seq: number; turn: number; ts: number }

export type HarnessEvent = Base & (
  | { type: 'llm_request'; payload: unknown }
  | { type: 'llm_response'; raw: unknown; content: string; reasoning?: string; usage?: Usage; latencyMs: number }
  | { type: 'parse_error'; message: string; content: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'approval_required'; call: ToolCall }
  | { type: 'tool_result'; callId: string; name: string; output: string; truncated: boolean; error: boolean }
  | { type: 'context_stats'; estimatedTokens: number; exactTokens?: number; budgetTokens: number; droppedChars: number; usage?: Usage }
  | { type: 'error'; message: string; body?: string }
  | { type: 'done'; reason: DoneReason; text?: string; turns: number; toolCallCount: number }
)
