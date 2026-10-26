import type { Knob, Usage } from './backends/types.js'

export type ToolCall = { callId: string; name: string; args: Record<string, unknown>; backendId?: string }
/** A knob set in the harness that is not sent, because the server said the model does not take it. */
export type KnobOff = { knob: Knob | 'repeatTemperature' | 'repeatThinkTokens'; value: unknown; reason: string }
export type DoneReason = 'final' | 'max_turns' | 'parse_failed' | 'aborted' | 'backend_error' | 'mcp_error' | 'repeat_loop' | 'proxy_stopped'

type Base = { seq: number; turn: number; ts: number }

export type HarnessEvent = Base & (
  | { type: 'llm_request'; payload: unknown }
  | { type: 'llm_response'; raw: unknown; content: string; reasoning?: string; usage?: Usage; costUsd?: number; latencyMs: number }
  | { type: 'parse_error'; message: string; content: string; droppedChars?: number }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'approval_required'; call: ToolCall }
  | { type: 'tool_result'; callId: string; name: string; output: string; truncated?: boolean; error?: boolean }
  | { type: 'context_stats'; estimatedTokens: number; exactTokens?: number; budgetTokens?: number; droppedChars: number; usage?: Usage }
  | { type: 'context_reset'; chars: number }
  | { type: 'final_check'; command: string; passed: boolean; output: string }
  | { type: 'mcp_server_start'; server: string; command: string; args: string[]
      offered: number; tools: string[]; descriptionChars: number; schemaChars: number }
  | { type: 'knobs_off'; off: KnobOff[] }
  | { type: 'error'; message: string; body?: string }
  /** Notes sent after the task (notes.ts): which ones, and the length of their block. */
  | { type: 'notes_loaded'; ids: string[]; chars: number }
  /** A proxy run only: a side call of the agent (a title, a summary) recorded beside the turn, or a compaction turn. */
  | { type: 'proxy_note'; kind: 'auxiliary' | 'compaction'; model?: string; usage?: Usage; latencyMs?: number; error?: string }
  | { type: 'done'; reason: DoneReason; text?: string; turns: number; toolCallCount: number }
)

// Plain Omit collapses the HarnessEvent union into one object type; distribute it manually
// so each variant keeps its own extra fields (reason, payload, call, ...).
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** An event before the run stamps its seq, turn and ts. */
export type Ev = DistributiveOmit<HarnessEvent, 'seq' | 'turn' | 'ts'>
export type DoneEvent = Extract<HarnessEvent, { type: 'done' }>
export type McpStartEvent = Extract<HarnessEvent, { type: 'mcp_server_start' }>

/** `final` with no tool call at all: the model answered without doing anything. The CLI trace, the UI and the diff all mark this as a failure. */
export const quitWithoutWork = (e: DoneEvent): boolean => e.reason === 'final' && e.toolCallCount === 0

/** What one mcp server cost, without the server name: the CLI and the UI put their own prefix in front. */
export const mcpCounts = (e: McpStartEvent): string =>
  `${e.offered} offered, ${e.tools.length} tools, ${e.descriptionChars} desc + ${e.schemaChars} schema chars`

/** The approval call for `loop.untilBash`: once before the run, and before every execution when `tools.approveBash` is on. */
export const UNTIL_BASH = 'until_bash'

/** Approval calls that start an mcp server are named `mcp:<server>`; run.ts writes the name, the CLI and the UI read it back. */
const MCP_PREFIX = 'mcp:'
export const mcpApprovalName = (server: string): string => MCP_PREFIX + server
/** The server an approval call would start, or null when the call is an ordinary tool. */
export const mcpApprovalServer = (callName: string): string | null =>
  callName.startsWith(MCP_PREFIX) ? callName.slice(MCP_PREFIX.length) : null

const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
/** One `\uXXXX` per UTF-16 code unit of `ch`. */
const escapeChar = (ch: string): string => ch.split('').map(u => '\\u' + u.charCodeAt(0).toString(16).padStart(4, '0')).join('')

/** `s` as a terminal can show it without acting on it: every control character (C0, DEL, C1), format character (bidi
 *  marks and overrides, zero-width characters and joiners, soft hyphen, BOM, tag characters) and line or paragraph
 *  separator is written as `\uXXXX`, one escape per UTF-16 code unit. JSON.stringify escapes the C0 controls only;
 *  a terminal acts on U+009B (an 8-bit CSI: it redraws the line on xterm.js and others) and reorders the text after U+202E.
 *  Letters, combining marks and emoji stay as they are, except the joiner U+200D between emoji. */
export function showable(s: string): string {
  return s.replace(UNSHOWABLE, escapeChar)
}

/** `showable` for text that spans lines (a final answer, an error body, the reply as it streams in): a newline and a tab
 *  stay what they are, and everything else `showable` escapes is escaped, the carriage return included, which puts the
 *  cursor back to the start of the line so that what follows is written over it. */
export function showableText(s: string): string {
  return s.replace(UNSHOWABLE, ch => ch === '\n' || ch === '\t' ? ch : escapeChar(ch))
}

/** Whether `showable` would leave `s` as it is: nothing in it that a terminal would act on. For a name that is printed. */
export const isShowable = (s: string): boolean => showable(s) === s

/** The question the CLI asks before an approval call. The command and the server name go through JSON.stringify and
 *  showable: with control characters (`\r\u001b[2K`, or the single character U+009B) either would otherwise redraw
 *  the line and show something else than what runs. */
export function approvalPrompt(call: ToolCall): string {
  const command = showable(JSON.stringify(String(call.args.command ?? '')))
  const server = mcpApprovalServer(call.name)
  if (server !== null) return `start mcp server ${showable(JSON.stringify(server))}: ${command}`
  if (call.name === UNTIL_BASH) return `run each time the model says it is done, on files the model has written: ${command}`
  return `run bash: ${command}`
}
