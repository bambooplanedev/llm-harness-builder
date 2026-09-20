import { NO_THINK_LINE, type RunParams } from './config.js'
import { mcpApprovalName, UNTIL_BASH, type HarnessEvent, type ToolCall, type DoneReason } from './events.js'
import { createBackend, type Backend, type ChatMessage, type ChatRequest, type Delta, type NormalizedResponse, type Usage } from './backends/index.js'
import { TOOL_SCHEMAS, runTool } from './tools/index.js'
import { GUARD_BLOCKED } from './tools/fs.js'
import { bash } from './tools/bash.js'
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

// loop.freshContext. Appended to the task, not sent as a second user message: no chat template sees two user turns in a row.
// It does not name the call that looped: that would put the loop back into the new history.
const FRESH_NOTE = 'Note: an earlier attempt at this task was cleared from this conversation. Files in the project may already have been changed. Look at their current state before editing.'

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
  }
  // loop.untilBash comes from the harness file like an mcp command does, so it is asked about the same way: before any
  // model time, and before a server is started, so that a refusal leaves no child behind.
  let untilSeq = 0
  async function* approveUntil(): AsyncGenerator<HarnessEvent, boolean> {
    if (opts.signal?.aborted) { yield done('aborted'); return false }
    const call: ToolCall = { callId: `until${untilSeq++}`, name: UNTIL_BASH, args: { command: config.loop.untilBash } }
    yield ev({ type: 'approval_required', call })
    const ok = opts.approve ? await opts.approve(call) : false
    if (opts.signal?.aborted) { yield done('aborted'); return false }
    if (!ok) {
      yield ev({ type: 'error', message: opts.approve ? 'loop.untilBash was not approved' : 'loop.untilBash needs approval but no approval handler is available' })
      yield done('aborted')
    }
    return ok
  }
  if (config.loop.untilBash !== undefined && !(yield* approveUntil())) return
  if (mcpNames.length) {
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
      ? config.systemPrompt + '\n\n' + config.toolCalls.promptedTemplate.split('{{tools}}').join(renderTools(schemas, config.toolCalls.format))
      : config.systemPrompt
    const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: task }]
    // loop.repeatThinkTokens: the system message of a thinking turn. It is sent for that turn only and never enters the history.
    const thinkTokens = config.loop.repeatThinkTokens
    const systemThinking = system.replace(NO_THINK_LINE, '/think')
    const max = config.context.maxToolOutputChars
    const cut = (s: string) => s.length > max ? s.slice(0, max) + `\n[truncated: ${s.length - max} more chars]` : s
    const ctx = {
      workdir,
      maxToolOutputChars: max,
      // Present only when the harness asked for it; the tools treat "absent" as "guard off".
      reads: config.tools.requireReadBeforeEdit ? new Set<string>() : undefined,
      explainEditMiss: config.tools.explainEditMiss,
    }
    // loop.maxRepeats: how many times each call was made since the files last changed through a tool.
    // An edit that has succeeded is counted over the whole run: it succeeds twice only when it was undone in between.
    const seen = new Map<string, number>()
    const applied = new Set<string>()
    // loop.repeatTemperature, loop.repeatThinkTokens: true while the previous turn carried a repeat. Never true without one of them:
    // a harness with maxRepeats alone must send the requests it always sent.
    let hot = false
    let wasReset = false // loop.freshContext fires once; a second loop is for maxRepeats to end

    while (true) {
      if (opts.signal?.aborted) { yield done('aborted'); return }
      if (turn >= config.loop.maxTurns) { yield done('max_turns'); return }
      turn++

      const droppedChars = applyBudget(messages, config.context.budgetTokens)
      const think = hot && thinkTokens !== undefined
      const req: ChatRequest = {
        model: config.backend.model, messages: think ? [{ role: 'system', content: systemThinking }, ...messages.slice(1)] : messages,
        temperature: hot && config.loop.repeatTemperature !== undefined ? config.loop.repeatTemperature : config.backend.temperature, numCtx: config.backend.numCtx, maxTokens: think ? thinkTokens : config.backend.maxTokens,
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
        hot = false // the retry of a reply that did not parse is not the place for more noise, or for the thinking that may have cut it off
        // A response cut off at the token limit has filled the window, so sent back whole the retry cannot fit.
        // Only the marker goes back: a kept head made the model repeat the form that had just run away.
        const marker = `[response cut off at the token limit: kept 0 of ${res.content.length} chars]`
        const clip = res.truncated && marker.length < res.content.length
        messages.push({ role: 'assistant', content: clip ? marker : res.content })
        messages.push({ role: 'user', content: config.toolCalls.parseErrorHint })
        yield ev({ type: 'parse_error', message: parseError, content: res.content, droppedChars: clip ? res.content.length : undefined })
        if (parseFails >= 2) { yield done('parse_failed'); return }
        continue
      }
      parseFails = 0
      // hermes fallback: put the blocks back into the text so the history shows the call before its <tool_response>
      const assistantText = hermes && calls.length && !res.content.includes('<tool_call>')
        ? [res.content, ...calls.map(c => `<tool_call>\n${JSON.stringify({ name: c.name, arguments: c.args })}\n</tool_call>`)].filter(Boolean).join('\n')
        : res.content
      messages.push({ role: 'assistant', content: assistantText, toolCalls: prompted ? undefined : res.toolCalls })

      if (calls.length === 0) {
        const command = config.loop.untilBash
        if (command === undefined) { yield done('final', final ?? res.content); return }
        // The check runs files the model wrote. Under approveBash nothing of the model's runs unasked, so this does not either.
        if (config.tools.approveBash && !(yield* approveUntil())) return
        const raw = await bash({ command }, ctx)
        if (opts.signal?.aborted) { yield done('aborted'); return }
        // bash() writes the exit tail last, so output cannot forge it; read it before the cut, which takes the tail away.
        const passed = raw.endsWith('\n[exit 0]')
        yield ev({ type: 'final_check', command, passed, output: cut(raw) })
        if (passed) { yield done('final', final ?? res.content); return }
        messages.push({ role: 'user', content: `not finished: \`${command}\` did not exit 0\n${cut(raw)}`, isToolResult: true })
        continue
      }

      // ---- tools -------------------------------------------------------------
      const wrapped: string[] = []
      hot = false
      let reset = false
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
        const truncated = result.output.length > max
        let output = cut(result.output)
        let repeats = 0
        if (config.loop.maxRepeats !== undefined) {
          const key = c.name + JSON.stringify(c.args)
          const n = (seen.get(key) ?? 0) + 1
          repeats = n - 1
          if (!result.error && (c.name === 'edit_file' || c.name === 'write_file')) {
            applied.add(key)
            for (const k of [...seen.keys()]) if (!applied.has(k)) seen.delete(k)
          }
          // A refusal by the guard is not recorded: read_file and then the same edit is the recovery we want.
          if (!(result.error && result.output.includes(GUARD_BLOCKED))) seen.set(key, n)
          if (repeats && (config.loop.repeatTemperature !== undefined || thinkTokens !== undefined)) hot = true
          if (repeats) output += `\nnote: identical call #${n} ${applied.has(key) ? 'in this run' : 'since the last file change'}`
        }
        yield ev({ type: 'tool_result', callId: call.callId, name: call.name, output, truncated, error: result.error })
        if (repeats > (config.loop.maxRepeats ?? Infinity)) { yield done('repeat_loop'); return }
        // The rest of this response's calls do not run: no context would ever hold their results.
        if (!wasReset && repeats >= (config.loop.freshContext ?? Infinity)) { reset = true; break }

        if (hermes) wrapped.push(`<tool_response>\n${output}\n</tool_response>`)
        else if (prompted) wrapped.push(`<tool_result id="${call.callId}" name="${call.name}">\n${output}\n</tool_result>`)
        else messages.push({ role: 'tool', content: output, toolCallId: call.backendId!, name: call.name, isToolResult: true })
      }
      if (reset) {
        wasReset = true
        const chars = messages.slice(2).reduce((n, m) => n + m.content.length, 0)
        messages.splice(0, messages.length, { role: 'system', content: system }, { role: 'user', content: task + '\n\n' + FRESH_NOTE })
        seen.clear(); applied.clear(); ctx.reads?.clear(); hot = false
        yield ev({ type: 'context_reset', chars })
        continue
      }
      if (prompted) messages.push({ role: 'user', content: wrapped.join('\n'), isToolResult: true })
    }
  } finally {
    mcp?.close()
  }
}
