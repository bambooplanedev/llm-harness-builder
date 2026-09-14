import type { RunParams } from './config.js'
import { mcpApprovalName, type HarnessEvent, type ToolCall, type DoneReason } from './events.js'
import { createBackend, type Backend, type ChatMessage, type ChatRequest, type Delta, type NormalizedResponse, type Usage } from './backends/index.js'
import { TOOL_SCHEMAS, runTool } from './tools/index.js'
import { renderTools, PROMPTED_SCHEMA } from './prompts.js'
import { parsePrompted, parseHermes } from './parse.js'
import { estimateTokens, applyBudget } from './tokens.js'
import { startServers, type McpSession } from './mcp.js'

export type RunOpts = {
  signal?: AbortSignal
  approve?: (call: ToolCall) => Promise<boolean>
  backend?: Backend
  onDelta?: (d: Delta) => void
  /** Seam for tests; defaults to the real stdio client. */
  mcp?: typeof startServers
}

// Plain Omit collapses the HarnessEvent union into one object type; distribute it manually
// so each variant keeps its own extra fields (reason, payload, call, ...).
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type Ev = DistributiveOmit<HarnessEvent, 'seq' | 'turn' | 'ts'>

export async function* runAgent(params: RunParams, opts: RunOpts = {}): AsyncGenerator<HarnessEvent> {
  const { config, task, workdir } = params
  const backend = opts.backend ?? createBackend(config.backend)
  const prompted = config.toolCalls.mode === 'prompted'
  const hermes = prompted && config.toolCalls.format === 'hermes'

  let seq = 0, turn = 0, toolCallCount = 0, parseFails = 0, callSeq = 0
  let lastUsage: Usage | undefined
  const ev = (e: Ev): HarnessEvent => ({ seq: seq++, turn, ts: Date.now(), ...e } as HarnessEvent)
  const done = (reason: DoneReason, text?: string) => ev({ type: 'done', reason, text, turns: turn, toolCallCount })

  let mcp: McpSession | undefined
  const mcpNames = Object.keys(config.mcpServers ?? {})
  if (mcpNames.length) {
    let i = 0
    for (const name of mcpNames) {
      const s = config.mcpServers![name]
      const call: ToolCall = {
        callId: `mcp${++i}`, name: mcpApprovalName(name),
        args: { command: [s.command, ...(s.args ?? [])].join(' ') },
      }
      if (opts.signal?.aborted) { yield done('aborted'); return }
      yield ev({ type: 'approval_required', call })
      if (!opts.approve) {
        yield ev({ type: 'error', message: `mcp server "${name}" needs approval but no approval handler is available` })
        yield done('mcp_error'); return
      }
      const ok = await opts.approve(call)
      if (opts.signal?.aborted) { yield done('aborted'); return }
      if (!ok) { yield done('mcp_error'); return }
    }
    try {
      mcp = await (opts.mcp ?? startServers)(config.mcpServers!, workdir, {
        signal: opts.signal, taken: new Set(config.tools.enabled),
      })
    } catch (e) {
      if (opts.signal?.aborted) { yield done('aborted'); return }
      yield ev({ type: 'error', message: (e as Error).message })
      yield done('mcp_error'); return
    }
  }

  // mcp is live from here on (when mcpServers is non-empty); everything that can throw or yield
  // from this point must run inside this try, so a thrown error from a consumer or from
  // renderTools() still reaches the finally and mcp.close() runs — no detached child outlives the run.
  try {
    if (mcp) for (const s of mcp.servers) yield ev({ type: 'mcp_server_start', ...s })

    const schemas = [...config.tools.enabled.map(n => TOOL_SCHEMAS[n]), ...(mcp?.tools ?? [])]
    const system = prompted
      ? config.systemPrompt + '\n\n' + config.toolCalls.promptedTemplate.split('{{tools}}').join(renderTools(schemas, hermes ? 'hermes' : 'json'))
      : config.systemPrompt
    const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: task }]
    const ctx = { workdir, maxToolOutputChars: config.context.maxToolOutputChars }

    while (true) {
      if (opts.signal?.aborted) { yield done('aborted'); return }
      if (turn >= config.loop.maxTurns) { yield done('max_turns'); return }
      turn++

      const droppedChars = applyBudget(messages, config.context.budgetTokens)
      const req: ChatRequest = {
        model: config.backend.model, messages, temperature: config.backend.temperature, numCtx: config.backend.numCtx,
        tools: prompted ? undefined : schemas,
        responseSchema: prompted && !hermes && config.toolCalls.enforceSchema ? PROMPTED_SCHEMA : undefined,
      }
      const payload = backend.buildPayload(req)
      const exactTokens = await backend.countTokens?.(payload, opts.signal)
      yield ev({ type: 'context_stats', estimatedTokens: estimateTokens(messages), exactTokens, budgetTokens: config.context.budgetTokens, droppedChars, usage: lastUsage })
      yield ev({ type: 'llm_request', payload })

      const t0 = Date.now()
      let res: NormalizedResponse
      try {
        res = await backend.send(payload, opts.signal, opts.onDelta)
      } catch (e) {
        if (opts.signal?.aborted) { yield done('aborted'); return }
        const cause = (e as any)?.cause?.code ?? (e as any)?.cause?.message
        const message = `${(e as Error).message}${cause ? ` (${cause})` : ''}`
        yield ev({ type: 'error', message, body: (e as { body?: string }).body })
        yield done('backend_error'); return
      }
      lastUsage = res.usage
      yield ev({ type: 'llm_response', raw: res.raw, content: res.content, reasoning: res.reasoning, usage: res.usage, latencyMs: Date.now() - t0 })

      // ---- parse -------------------------------------------------------------
      let calls: { name: string; args: Record<string, unknown>; backendId?: string; argsError?: string }[] = []
      let final: string | null = null
      let parseError: string | null = null
      if (res.truncated) {
        parseError = 'response truncated by max tokens (finish_reason=length)'
      } else if (prompted) {
        const p = hermes ? parseHermes(res.content) : parsePrompted(res.content)
        if (hermes && res.toolCalls.length && !(p.ok && p.calls.length) && !res.content.includes('<tool_call>')) {
          // llama-server/Ollama (version- and template-dependent) may have lifted the <tool_call>
          // blocks into tool_calls and left content empty or prose-only. Use them; the trace keeps raw.
          // Only when content carries no <tool_call> text at all — if it does, the block is malformed
          // (parseHermes rejected it), and that must surface as a parse_error, not be silently swallowed.
          calls = res.toolCalls
        } else if (p.ok) {
          if (p.calls.length === 0 && (p.final === null || p.final.trim() === ''))
            parseError = 'response has no tool calls and no final answer'
          else { calls = p.calls; final = p.final }
        } else parseError = p.message
      } else {
        calls = res.toolCalls
        if (calls.length === 0) {
          if (res.content.trim() === '') parseError = 'empty response without tool calls'
          else final = res.content
        }
      }

      if (parseError) {
        parseFails++
        messages.push({ role: 'assistant', content: res.content })
        messages.push({ role: 'user', content: config.toolCalls.parseErrorHint })
        yield ev({ type: 'parse_error', message: parseError, content: res.content })
        if (parseFails >= 2) { yield done('parse_failed'); return }
        continue
      }
      parseFails = 0
      // hermes fallback: put the blocks back into the text so the history shows the call before its <tool_response>
      const assistantText = hermes && calls.length && !res.content.includes('<tool_call>')
        ? [res.content, ...calls.map(c => `<tool_call>\n${JSON.stringify({ name: c.name, arguments: c.args })}\n</tool_call>`)].filter(Boolean).join('\n')
        : res.content
      messages.push({ role: 'assistant', content: assistantText, toolCalls: prompted ? undefined : res.toolCalls })

      if (calls.length === 0) { yield done('final', final ?? res.content); return }

      // ---- tools -------------------------------------------------------------
      const wrapped: string[] = []
      for (const c of calls) {
        if (opts.signal?.aborted) { yield done('aborted'); return }
        const call: ToolCall = { callId: `c${++callSeq}`, name: c.name, args: c.args, backendId: c.backendId ?? `c${callSeq}` }
        c.backendId = call.backendId // so the assistant message in history carries the same id as the tool message
        toolCallCount++
        yield ev({ type: 'tool_call', call })

        let result: { output: string; error: boolean } | undefined
        if (c.argsError) {
          result = { output: `tool ${c.name}: invalid arguments: ${c.argsError}`, error: true }
        } else if (c.name === 'bash' && config.tools.approveBash && config.tools.enabled.includes('bash')) {
          yield ev({ type: 'approval_required', call })
          const ok = opts.approve ? await opts.approve(call) : false
          if (!ok) result = { output: 'denied by user', error: true }
        }
        if (!result) {
          result = await runTool(c.name, c.args, ctx, config.tools.enabled, mcp)
        }
        const max = config.context.maxToolOutputChars
        const truncated = result.output.length > max
        const output = truncated ? result.output.slice(0, max) + `\n[truncated: ${result.output.length - max} more chars]` : result.output
        yield ev({ type: 'tool_result', callId: call.callId, name: call.name, output, truncated, error: result.error })

        if (hermes) wrapped.push(`<tool_response>\n${output}\n</tool_response>`)
        else if (prompted) wrapped.push(`<tool_result id="${call.callId}" name="${call.name}">\n${output}\n</tool_result>`)
        else messages.push({ role: 'tool', content: output, toolCallId: call.backendId!, name: call.name, isToolResult: true })
      }
      if (prompted) messages.push({ role: 'user', content: wrapped.join('\n'), isToolResult: true })
    }
  } finally {
    mcp?.close()
  }
}
