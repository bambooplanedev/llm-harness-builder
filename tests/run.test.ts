import { test, expect } from 'vitest'
import { mkdtemp, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgent } from '../src/core/run.js'
import type { Backend, ChatRequest, NormalizedResponse } from '../src/core/backends/types.js'
import type { HarnessConfig, RunParams } from '../src/core/config.js'
import type { HarnessEvent } from '../src/core/events.js'

class Fake implements Backend {
  requests: ChatRequest[] = []
  constructor(private queue: Partial<NormalizedResponse>[]) {}
  async listModels() { return ['m'] }
  buildPayload(req: ChatRequest) { this.requests.push(structuredClone(req)); return { messages: req.messages } }
  async send(): Promise<NormalizedResponse> {
    const r = this.queue.shift(); if (!r) throw new Error('fake: no more responses')
    return { content: '', toolCalls: [], raw: {}, ...r }
  }
}

const base = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  name: 't', backend: { kind: 'openai', baseUrl: 'http://x/v1', model: 'm', temperature: 0 },
  systemPrompt: 'sys', tools: { enabled: ['read_file', 'bash'], approveBash: false },
  toolCalls: { mode: 'native', enforceSchema: false, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' },
  context: { maxToolOutputChars: 50, budgetTokens: 0 }, loop: { maxTurns: 5 }, ...over,
})
async function wd() { const d = await mkdtemp(join(tmpdir(), 'lhb-run-')); await writeFile(join(d, 'a.txt'), 'A'.repeat(120)); return d }
async function collect(params: RunParams, opts = {}) { const ev: HarnessEvent[] = []; for await (const e of runAgent(params, opts)) ev.push(e); return ev }
const types = (ev: HarnessEvent[]) => ev.map(e => e.type)
const last = (ev: HarnessEvent[]) => ev[ev.length - 1] as Extract<HarnessEvent, { type: 'done' }>

test('native: final text with no tool calls ends the run', async () => {
  const be = new Fake([{ content: 'done!' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  expect(types(ev)).toEqual(['context_stats', 'llm_request', 'llm_response', 'done'])
  expect(last(ev)).toMatchObject({ reason: 'final', text: 'done!', turns: 1, toolCallCount: 0 })
})

test('native: tool call, truncated result goes back as tool message, then final', async () => {
  const be = new Fake([{ toolCalls: [{ backendId: 'id1', name: 'read_file', args: { path: 'a.txt' } }] }, { content: 'ok' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  const tr = ev.find(e => e.type === 'tool_result') as any
  expect(tr.truncated).toBe(true); expect(tr.output.startsWith('A'.repeat(50))).toBe(true)
  expect(tr.output.endsWith('[truncated: 70 more chars]')).toBe(true) // exact: a.txt is 120 chars, cap is 50
  const toolMsg = be.requests[1].messages.at(-1) as any
  expect(toolMsg).toMatchObject({ role: 'tool', toolCallId: 'id1', isToolResult: true })
  expect(last(ev)).toMatchObject({ reason: 'final', toolCallCount: 1, turns: 2 })
})

test('native: empty content without tool calls is a parse error; two in a row = parse_failed', async () => {
  const be = new Fake([{ content: '' }, { content: '  ' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  expect(types(ev).filter(t => t === 'parse_error')).toHaveLength(2)
  expect(last(ev).reason).toBe('parse_failed')
  expect(be.requests[1].messages.at(-1)).toMatchObject({ role: 'user', content: 'HINT' })
})

test('parse error counter resets after a good turn', async () => {
  const be = new Fake([{ content: '' }, { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { content: '' }, { content: 'fin' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  expect(last(ev).reason).toBe('final')
})

test('prompted: template injected, json parsed, results wrapped in <tool_result>, prose-only is parse error', async () => {
  const cfg = base({ toolCalls: { mode: 'prompted', enforceSchema: true, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' } })
  const be = new Fake([
    { content: 'Sure, let me look.' },
    { content: '{"calls":[{"name":"read_file","args":{"path":"a.txt"}}],"final":null}' },
    { content: '{"calls":[],"final":"All good."}' },
  ])
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(be.requests[0].messages[0].content).toContain('T:- read_file')
  expect(be.requests[0].tools).toBeUndefined()
  expect(be.requests[0].responseSchema).toBeDefined()
  expect(types(ev)).toContain('parse_error')
  const resultMsg = be.requests[2].messages.at(-1) as any
  expect(resultMsg.role).toBe('user'); expect(resultMsg.isToolResult).toBe(true)
  expect(resultMsg.content).toMatch(/^<tool_result id="c1" name="read_file">/)
  expect(last(ev)).toMatchObject({ reason: 'final', text: 'All good.' })
})

test('prompted: no calls and no final is a parse error; two in a row = parse_failed', async () => {
  const cfg = base({ toolCalls: { mode: 'prompted', enforceSchema: true, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' } })
  const be = new Fake([{ content: '{"calls":[],"final":null}' }, { content: '{"calls":[],"final":null}' }])
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(types(ev).filter(t => t === 'parse_error')).toHaveLength(2)
  expect(last(ev).reason).toBe('parse_failed')
})

test('prompted: empty-string final is a parse error, then a real final ends the run', async () => {
  const cfg = base({ toolCalls: { mode: 'prompted', enforceSchema: true, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' } })
  const be = new Fake([{ content: '{"calls":[],"final":""}' }, { content: '{"calls":[],"final":"All good."}' }])
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(types(ev).filter(t => t === 'parse_error')).toHaveLength(1)
  expect(last(ev)).toMatchObject({ reason: 'final', text: 'All good.' })
})

test('prompted: {{tools}} placeholder is substituted at every occurrence', async () => {
  const cfg = base({ toolCalls: { mode: 'prompted', enforceSchema: true, promptedTemplate: 'A {{tools}} B {{tools}}', parseErrorHint: 'HINT' } })
  const be = new Fake([{ content: '{"calls":[],"final":"done"}' }])
  await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  const sys = be.requests[0].messages[0].content as string
  expect(sys.match(/- read_file/g)).toHaveLength(2)
})

test('unknown tool and bad args are tool errors, not parse errors', async () => {
  const be = new Fake([{ toolCalls: [{ name: 'grep', args: {} }, { name: 'read_file', args: {}, argsError: 'bad json' }] }, { content: 'x' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  const results = ev.filter(e => e.type === 'tool_result') as any[]
  expect(results).toHaveLength(2)
  expect(results[0]).toMatchObject({ error: true }); expect(results[0].output).toMatch(/unknown tool grep/)
  expect(results[1].output).toMatch(/invalid arguments/)
  expect(types(ev)).not.toContain('parse_error')
})

test('approval: denied bash returns denied text; approval_required emitted', async () => {
  const cfg = base({ tools: { enabled: ['bash'], approveBash: true } })
  const be = new Fake([{ toolCalls: [{ name: 'bash', args: { command: 'echo hi' } }] }, { content: 'x' }])
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be, approve: async () => false })
  expect(types(ev)).toContain('approval_required')
  expect((ev.find(e => e.type === 'tool_result') as any).output).toBe('denied by user')
})

test('approval: no approve callback provided denies bash and it never runs', async () => {
  const dir = await wd()
  const cfg = base({ tools: { enabled: ['bash'], approveBash: true } })
  const be = new Fake([{ toolCalls: [{ name: 'bash', args: { command: 'touch SHOULD_NOT_EXIST' } }] }, { content: 'x' }])
  const ev = await collect({ config: cfg, task: 'do', workdir: dir }, { backend: be })
  expect(types(ev)).toContain('approval_required')
  expect((ev.find(e => e.type === 'tool_result') as any).output).toBe('denied by user')
  await expect(access(join(dir, 'SHOULD_NOT_EXIST'))).rejects.toThrow()
})

test('bash call with argsError skips the approval gate entirely', async () => {
  const cfg = base({ tools: { enabled: ['bash'], approveBash: true } })
  const be = new Fake([{ toolCalls: [{ name: 'bash', args: {}, argsError: 'bad json' }] }, { content: 'x' }])
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be, approve: async () => true })
  expect(types(ev)).not.toContain('approval_required')
  expect((ev.find(e => e.type === 'tool_result') as any).output).toMatch(/invalid arguments/)
})

test('backend error message includes the fetch failure cause', async () => {
  const be: Backend = {
    async listModels() { return [] },
    buildPayload: r => r,
    async send() { throw Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }) },
  }
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  const err = ev.find(e => e.type === 'error') as any
  expect(err.message).toContain('UND_ERR_HEADERS_TIMEOUT')
  expect(last(ev).reason).toBe('backend_error')
})

test('budget: oldest tool result dropped, context_stats reports it', async () => {
  const cfg = base({ context: { maxToolOutputChars: 1000, budgetTokens: 60 } })
  const be = new Fake([{ toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { content: 'x' }])
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  const stats = ev.filter(e => e.type === 'context_stats') as any[]
  expect(stats.some(s => s.droppedChars > 0)).toBe(true)
  expect(be.requests[2].messages.length).toBe(be.requests[1].messages.length + 2)
})

test('max_turns, backend_error, aborted', async () => {
  const many = new Fake(Array(9).fill({ toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }))
  expect(last(await collect({ config: base({ loop: { maxTurns: 2 } }), task: 'do', workdir: await wd() }, { backend: many })).reason).toBe('max_turns')
  const broken = new Fake([])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: broken })
  expect(types(ev)).toContain('error'); expect(last(ev).reason).toBe('backend_error')
  const ac = new AbortController(); ac.abort()
  expect(last(await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: new Fake([{ content: 'x' }]), signal: ac.signal })).reason).toBe('aborted')
})

test('truncated response is a parse error in any format, then the loop continues', async () => {
  const be = new Fake([{ content: '<think>endless', truncated: true }, { content: 'fin' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  const pe = ev.find(e => e.type === 'parse_error') as any
  expect(pe.message).toMatch(/truncated/)
  expect(last(ev)).toMatchObject({ reason: 'final', text: 'fin', turns: 2 })
})

const hermesCfg = (over: Partial<HarnessConfig['toolCalls']> = {}) => base({
  toolCalls: { mode: 'prompted', format: 'hermes', enforceSchema: false, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT', ...over },
})
const block = (name: string, args: unknown) => `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`

test('hermes: tool call, <tool_response> wrapping without attributes, plain text ends the run', async () => {
  const be = new Fake([{ content: 'Reading.\n' + block('read_file', { path: 'a.txt' }) }, { content: 'Done.' }])
  const ev = await collect({ config: hermesCfg(), task: 'do', workdir: await wd() }, { backend: be })
  expect(types(ev)).toContain('tool_call')
  const sys = be.requests[0].messages[0].content
  expect(sys).toContain('"type":"function"')
  expect(be.requests[0].responseSchema).toBeUndefined()
  const back = be.requests[1].messages.at(-1) as any
  expect(back.role).toBe('user')
  expect(back.content).toMatch(/^<tool_response>\n[\s\S]*\n<\/tool_response>$/)
  expect(back.content).not.toContain('id=')
  expect(last(ev)).toMatchObject({ reason: 'final', text: 'Done.', toolCallCount: 1, turns: 2 })
})

test('hermes: plain text on the first turn is final with 0 tool calls', async () => {
  const be = new Fake([{ content: 'Sure, let me read the file first.' }])
  const ev = await collect({ config: hermesCfg(), task: 'do', workdir: await wd() }, { backend: be })
  expect(last(ev)).toMatchObject({ reason: 'final', toolCallCount: 0 })
})

test('hermes: server-parsed tool_calls with empty content are used and re-serialised into history', async () => {
  const be = new Fake([{ content: '', toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { content: 'ok' }])
  const ev = await collect({ config: hermesCfg(), task: 'do', workdir: await wd() }, { backend: be })
  expect(ev.find(e => e.type === 'tool_result')).toBeTruthy()
  const asst = be.requests[1].messages.at(-2) as any
  expect(asst.role).toBe('assistant')
  expect(asst.content).toContain('<tool_call>')
  expect(asst.content).toContain('"name":"read_file"')
  expect(asst.toolCalls).toBeUndefined()
})

test('hermes: enforceSchema is ignored (no responseSchema in the request)', async () => {
  const be = new Fake([{ content: 'x' }])
  await collect({ config: hermesCfg({ enforceSchema: true }), task: 'do', workdir: await wd() }, { backend: be })
  expect(be.requests[0].responseSchema).toBeUndefined()
})

test('hermes: a malformed block in content is a parse error even if the server also returned tool_calls', async () => {
  const be = new Fake([
    { content: '<tool_call>{oops</tool_call>', toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
    { content: 'Done.' },
  ])
  const ev = await collect({ config: hermesCfg(), task: 'do', workdir: await wd() }, { backend: be })
  expect(types(ev)).toContain('parse_error')
  expect(types(ev)).not.toContain('tool_call')
  expect(be.requests[1].messages.at(-1)).toMatchObject({ role: 'user', content: 'HINT' })
  expect(last(ev)).toMatchObject({ reason: 'final', text: 'Done.', toolCallCount: 0 })
})

test('hermes: broken block -> parse_error with hint, second in a row -> parse_failed', async () => {
  const be = new Fake([{ content: '<tool_call>{oops</tool_call>' }, { content: '<tool_call>' }])
  const ev = await collect({ config: hermesCfg(), task: 'do', workdir: await wd() }, { backend: be })
  expect(be.requests[1].messages.at(-1)).toMatchObject({ role: 'user', content: 'HINT' })
  expect(last(ev).reason).toBe('parse_failed')
})

test('context_stats carries exactTokens when the backend can count, from the same payload that is sent', async () => {
  const be = new Fake([{ content: 'done!' }])
  const seen: unknown[] = []
  ;(be as any).countTokens = async (payload: unknown) => { seen.push(payload); return 4242 }
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  expect(types(ev)).toEqual(['context_stats', 'llm_request', 'llm_response', 'done'])
  expect(ev[0]).toMatchObject({ type: 'context_stats', exactTokens: 4242 })
  expect(seen).toEqual([(ev[1] as any).payload])
})

test('context_stats has no exactTokens when the backend cannot count', async () => {
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: new Fake([{ content: 'x' }]) })
  expect((ev[0] as any).exactTokens).toBeUndefined()
  expect(JSON.parse(JSON.stringify(ev[0]))).not.toHaveProperty('exactTokens')
})

const fakeMcp = (over: Partial<any> = {}) => ({
  tools: [{ name: 'echo', description: 'E', parameters: { type: 'object', properties: {}, required: [] } }],
  servers: [{ server: 'fs', command: 'npx', args: ['.'], offered: 3, tools: ['echo'], descriptionChars: 1, schemaChars: 2 }],
  has: (n: string) => n === 'echo',
  call: async () => ({ output: 'mcp said hi', error: false }),
  close: () => {},
  ...over,
})
const withMcp = (over: Partial<HarnessConfig> = {}) =>
  base({ mcpServers: { fs: { command: 'npx', args: ['.'] } }, ...over })

test('mcp: approval, start event and the tool schema reaches the request', async () => {
  const be = new Fake([{ toolCalls: [{ name: 'echo', args: {} }] }, { content: 'fin' }])
  const asked: string[] = []
  const config = withMcp()
  const workdir = await wd()
  let seen: { servers: unknown; workdir: string; opts: { taken?: Set<string> } } | undefined
  const ev = await collect({ config, task: 'do', workdir }, {
    backend: be,
    mcp: async (servers, w, o) => { seen = { servers, workdir: w, opts: o ?? {} }; return fakeMcp() },
    approve: async c => { asked.push(c.name); return true },
  })
  expect(asked).toEqual(['mcp:fs'])
  // startServers must see the real workdir and the enabled built-ins as `taken`, so it can
  // detect a name collision itself — wiring this by inspection alone let it regress silently.
  expect(seen?.workdir).toBe(workdir)
  expect(seen?.opts.taken).toEqual(new Set(config.tools.enabled))
  expect(types(ev).slice(0, 3)).toEqual(['approval_required', 'mcp_server_start', 'context_stats'])
  expect(be.requests[0].tools!.map(t => t.name)).toContain('echo')
  const tr = ev.find(e => e.type === 'tool_result') as any
  expect(tr.output).toBe('mcp said hi')
  expect(last(ev).reason).toBe('final')
})

test('mcp: refusing the server ends the run before any llm_request', async () => {
  const be = new Fake([])
  const ev = await collect({ config: withMcp(), task: 'do', workdir: await wd() }, {
    backend: be, mcp: async () => fakeMcp(), approve: async () => false,
  })
  expect(types(ev)).toEqual(['approval_required', 'done'])
  expect(last(ev).reason).toBe('mcp_error')
  expect(be.requests).toHaveLength(0)
})

test('mcp: a server that will not start ends the run with its message', async () => {
  const be = new Fake([])
  const ev = await collect({ config: withMcp(), task: 'do', workdir: await wd() }, {
    backend: be, approve: async () => true,
    mcp: async () => { throw new Error('mcp server "fs" failed to start: boom') },
  })
  expect(types(ev)).toEqual(['approval_required', 'error', 'done'])
  expect((ev[1] as any).message).toMatch(/failed to start: boom/)
  expect(last(ev).reason).toBe('mcp_error')
  expect(be.requests).toHaveLength(0)
})

test('mcp: aborting while the approval is pending is aborted, not mcp_error', async () => {
  const ac = new AbortController()
  const ev = await collect({ config: withMcp(), task: 'do', workdir: await wd() }, {
    backend: new Fake([]), mcp: async () => fakeMcp(),
    // Real callers (src/server/runs.ts) resolve a pending approval with `false` on abort — the
    // refusal and the abort land together. Aborted must still win over mcp_error, and no server
    // must have been started (no mcp_server_start event), or a cancelled run misreports as refused.
    signal: ac.signal, approve: async () => { ac.abort(); return false },
  })
  expect(types(ev)).toEqual(['approval_required', 'done'])
  expect(last(ev).reason).toBe('aborted')
})

test('mcp: no approve callback is a stated refusal, not a silent one', async () => {
  const ev = await collect({ config: withMcp(), task: 'do', workdir: await wd() }, {
    backend: new Fake([]), mcp: async () => fakeMcp(),
  })
  expect(types(ev)).toEqual(['approval_required', 'error', 'done'])
  expect((ev[1] as any).message).toMatch(/no approval handler/)
  expect(last(ev).reason).toBe('mcp_error')
})

test('mcp: the session is closed even when the loop throws', async () => {
  let closed = false
  const be = { buildPayload: () => ({}), async send(): Promise<never> { throw Object.assign(new Error('x'), { fatal: true }) }, async listModels() { return [] } }
  const gen = runAgent({ config: withMcp(), task: 'do', workdir: await wd() }, {
    backend: be as any, mcp: async () => fakeMcp({ close: () => { closed = true } }), approve: async () => true,
  })
  for await (const _ of gen) { /* backend_error ends it */ }
  expect(closed).toBe(true)
})
