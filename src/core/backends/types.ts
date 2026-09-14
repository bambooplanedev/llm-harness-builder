import { fetch as undiciFetch, Agent } from 'undici'

/** The subset of fetch the adapters use; lets tests pass a fake and keeps undici's types out of the public surface. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

// A local model can take minutes before the first byte (model load, prompt eval, a long <think>).
// undici's defaults kill any request without headers within 300 s; that is the "fetch failed" of v1.
const patient = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
export const defaultFetch: FetchLike = (url, init) => undiciFetch(url, { ...init, dispatcher: patient })

export type Usage = { promptTokens: number; completionTokens: number }

export type ToolSchema = { name: string; description: string; parameters: Record<string, unknown> }

export type NormalizedToolCall = {
  backendId?: string
  name: string
  args: Record<string, unknown>
  /** Set when the backend returned arguments that are not a JSON object; args is {} then. */
  argsError?: string
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string; isToolResult?: boolean }
  | { role: 'assistant'; content: string; toolCalls?: NormalizedToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string; isToolResult: true }

export type ChatRequest = {
  model: string
  messages: ChatMessage[]
  tools?: ToolSchema[]
  responseSchema?: Record<string, unknown>
  temperature: number
  numCtx?: number
}

export type NormalizedResponse = {
  content: string
  reasoning?: string
  toolCalls: NormalizedToolCall[]
  usage?: Usage
  /** Backend stopped at max tokens (finish_reason/done_reason "length"); the content is incomplete. */
  truncated?: boolean
  raw: unknown
}

export interface Backend {
  listModels(): Promise<string[]>
  /** Pure: turns a ChatRequest into the exact JSON body that will be sent. */
  buildPayload(req: ChatRequest): unknown
  /** Sends a payload produced by buildPayload. Throws BackendError on non-2xx / network failure. */
  send(payload: unknown, signal?: AbortSignal): Promise<NormalizedResponse>
}

export class BackendError extends Error {
  constructor(message: string, public body?: string) { super(message) }
}

/** Reads a JSON body; a non-JSON body becomes a BackendError carrying the raw text. */
export async function readJson(r: { text(): Promise<string> }, what: string): Promise<any> {
  const text = await r.text()
  try { return JSON.parse(text) } catch { throw new BackendError(`${what}: response is not JSON`, text.slice(0, 2000)) }
}
