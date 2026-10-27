import { test, expect } from 'vitest'
import { writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { runAgent, mayAsk } from '../src/core/run.js'
import type { HarnessConfig, RunParams } from '../src/core/config.js'
import type { HarnessEvent } from '../src/core/events.js'
import { BackendError } from '../src/core/backends/types.js'
import { notesBlock } from '../src/core/notes.js'
import { fakeBackend, harness, tmp, type FakeResponse } from './helpers.js'

// The truncation assertions below depend on the 50-char cap; everything else is the shared default.
const base = (over: Partial<HarnessConfig> = {}): HarnessConfig =>
  harness({ context: { maxToolOutputChars: 50, budgetTokens: 0 }, ...over })
const Fake = (queue: FakeResponse[]) => fakeBackend(queue)
async function wd() { const d = await tmp('lhb-run-'); await writeFile(join(d, 'a.txt'), 'A'.repeat(120)); return d }
async function collect(params: RunParams, opts = {}) { const ev: HarnessEvent[] = []; for await (const e of runAgent(params, opts)) ev.push(e); return ev }
const types = (ev: HarnessEvent[]) => ev.map(e => e.type)
const last = (ev: HarnessEvent[]) => ev[ev.length - 1] as Extract<HarnessEvent, { type: 'done' }>

test('native: final text with no tool calls ends the run', async () => {
  const be = Fake([{ content: 'done!' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  expect(types(ev)).toEqual(['context_stats', 'llm_request', 'llm_response', 'done'])
  expect(last(ev)).toMatchObject({ reason: 'final', text: 'done!', turns: 1, toolCallCount: 0 })
})

test('native: tool call, truncated result goes back as tool message, then final', async () => {
  const be = Fake([{ toolCalls: [{ backendId: 'id1', name: 'read_file', args: { path: 'a.txt' } }] }, { content: 'ok' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  const tr = ev.find(e => e.type === 'tool_result') as any
  expect(tr.truncated).toBe(true); expect(tr.output.startsWith('A'.repeat(50))).toBe(true)
  expect(tr.output.endsWith('[truncated: 70 more chars]')).toBe(true) // exact: a.txt is 120 chars, cap is 50
  const toolMsg = be.requests[1].messages.at(-1) as any
  expect(toolMsg).toMatchObject({ role: 'tool', toolCallId: 'id1', isToolResult: true })
  expect(last(ev)).toMatchObject({ reason: 'final', toolCallCount: 1, turns: 2 })
})

test('native: empty content without tool calls is a parse error; two in a row = parse_failed', async () => {
  const be = Fake([{ content: '' }, { content: '  ' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  expect(types(ev).filter(t => t === 'parse_error')).toHaveLength(2)
  expect(last(ev).reason).toBe('parse_failed')
  expect(be.requests[1].messages.at(-1)).toMatchObject({ role: 'user', content: 'HINT' })
})

test('parse error counter resets after a good turn', async () => {
  const be = Fake([{ content: '' }, { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { content: '' }, { content: 'fin' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  expect(last(ev).reason).toBe('final')
})

test('prompted: template injected, json parsed, results wrapped in <tool_result>, prose-only is parse error', async () => {
  const cfg = base({ toolCalls: { mode: 'prompted', enforceSchema: true, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' } })
  const be = Fake([
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
  const be = Fake([{ content: '{"calls":[],"final":null}' }, { content: '{"calls":[],"final":null}' }])
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(types(ev).filter(t => t === 'parse_error')).toHaveLength(2)
  expect(last(ev).reason).toBe('parse_failed')
})

test('prompted: empty-string final is a parse error, then a real final ends the run', async () => {
  const cfg = base({ toolCalls: { mode: 'prompted', enforceSchema: true, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' } })
  const be = Fake([{ content: '{"calls":[],"final":""}' }, { content: '{"calls":[],"final":"All good."}' }])
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(types(ev).filter(t => t === 'parse_error')).toHaveLength(1)
  expect(last(ev)).toMatchObject({ reason: 'final', text: 'All good.' })
})

test('prompted: {{tools}} placeholder is substituted at every occurrence', async () => {
  const cfg = base({ toolCalls: { mode: 'prompted', enforceSchema: true, promptedTemplate: 'A {{tools}} B {{tools}}', parseErrorHint: 'HINT' } })
  const be = Fake([{ content: '{"calls":[],"final":"done"}' }])
  await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  const sys = be.requests[0].messages[0].content as string
  expect(sys.match(/- read_file/g)).toHaveLength(2)
})

test('unknown tool and bad args are tool errors, not parse errors', async () => {
  const be = Fake([{ toolCalls: [{ name: 'grep', args: {} }, { name: 'read_file', args: {}, argsError: 'bad json' }] }, { content: 'x' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  const results = ev.filter(e => e.type === 'tool_result') as any[]
  expect(results).toHaveLength(2)
  expect(results[0]).toMatchObject({ error: true }); expect(results[0].output).toMatch(/unknown tool grep/)
  expect(results[1].output).toMatch(/invalid arguments/)
  expect(types(ev)).not.toContain('parse_error')
})

test('approval: denied bash returns denied text; approval_required emitted', async () => {
  const cfg = base({ tools: { enabled: ['bash'], approveBash: true } })
  const be = Fake([{ toolCalls: [{ name: 'bash', args: { command: 'echo hi' } }] }, { content: 'x' }])
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be, approve: async () => false })
  expect(types(ev)).toContain('approval_required')
  expect((ev.find(e => e.type === 'tool_result') as any).output).toBe('denied by user')
})

test('approval: no approve callback provided denies bash and it never runs', async () => {
  const dir = await wd()
  const cfg = base({ tools: { enabled: ['bash'], approveBash: true } })
  const be = Fake([{ toolCalls: [{ name: 'bash', args: { command: 'touch SHOULD_NOT_EXIST' } }] }, { content: 'x' }])
  const ev = await collect({ config: cfg, task: 'do', workdir: dir }, { backend: be })
  expect(types(ev)).toContain('approval_required')
  expect((ev.find(e => e.type === 'tool_result') as any).output).toBe('denied by user')
  await expect(access(join(dir, 'SHOULD_NOT_EXIST'))).rejects.toThrow()
})

test('bash call with argsError skips the approval gate entirely', async () => {
  const cfg = base({ tools: { enabled: ['bash'], approveBash: true } })
  const be = Fake([{ toolCalls: [{ name: 'bash', args: {}, argsError: 'bad json' }] }, { content: 'x' }])
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
  const be = Fake([{ toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { content: 'x' }])
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  const stats = ev.filter(e => e.type === 'context_stats') as any[]
  expect(stats.some(s => s.droppedChars > 0)).toBe(true)
  expect(be.requests[2].messages.length).toBe(be.requests[1].messages.length + 2)
})

test('max_turns, backend_error, aborted', async () => {
  const many = Fake(Array(9).fill({ toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }))
  expect(last(await collect({ config: base({ loop: { maxTurns: 2 } }), task: 'do', workdir: await wd() }, { backend: many })).reason).toBe('max_turns')
  const broken = Fake([])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: broken })
  expect(types(ev)).toContain('error'); expect(last(ev).reason).toBe('backend_error')
  const ac = new AbortController(); ac.abort()
  expect(last(await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: Fake([{ content: 'x' }]), signal: ac.signal })).reason).toBe('aborted')
})

test('truncated response is a parse error in any format, then the loop continues', async () => {
  const be = Fake([{ content: '<think>endless', truncated: true }, { content: 'fin' }])
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
  const be = Fake([{ content: 'Reading.\n' + block('read_file', { path: 'a.txt' }) }, { content: 'Done.' }])
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
  const be = Fake([{ content: 'Sure, let me read the file first.' }])
  const ev = await collect({ config: hermesCfg(), task: 'do', workdir: await wd() }, { backend: be })
  expect(last(ev)).toMatchObject({ reason: 'final', toolCallCount: 0 })
})

test('hermes: server-parsed tool_calls with empty content are used and re-serialised into history', async () => {
  const be = Fake([{ content: '', toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { content: 'ok' }])
  const ev = await collect({ config: hermesCfg(), task: 'do', workdir: await wd() }, { backend: be })
  expect(ev.find(e => e.type === 'tool_result')).toBeTruthy()
  const asst = be.requests[1].messages.at(-2) as any
  expect(asst.role).toBe('assistant')
  expect(asst.content).toContain('<tool_call>')
  expect(asst.content).toContain('"name":"read_file"')
  expect(asst.toolCalls).toBeUndefined()
})

test('hermes: enforceSchema is ignored (no responseSchema in the request)', async () => {
  const be = Fake([{ content: 'x' }])
  await collect({ config: hermesCfg({ enforceSchema: true }), task: 'do', workdir: await wd() }, { backend: be })
  expect(be.requests[0].responseSchema).toBeUndefined()
})

test('hermes: a malformed block in content is a parse error even if the server also returned tool_calls', async () => {
  const be = Fake([
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
  const be = Fake([{ content: '<tool_call>{oops</tool_call>' }, { content: '<tool_call>' }])
  const ev = await collect({ config: hermesCfg(), task: 'do', workdir: await wd() }, { backend: be })
  expect(be.requests[1].messages.at(-1)).toMatchObject({ role: 'user', content: 'HINT' })
  expect(last(ev).reason).toBe('parse_failed')
})

test('context_stats carries exactTokens when the backend can count, from the same payload that is sent', async () => {
  const be = Fake([{ content: 'done!' }])
  const seen: unknown[] = []
  ;(be as any).countTokens = async (payload: unknown) => { seen.push(payload); return 4242 }
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  expect(types(ev)).toEqual(['context_stats', 'llm_request', 'llm_response', 'done'])
  expect(ev[0]).toMatchObject({ type: 'context_stats', exactTokens: 4242 })
  expect(seen).toEqual([(ev[1] as any).payload])
})

test('context_stats has no exactTokens when the backend cannot count', async () => {
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: Fake([{ content: 'x' }]) })
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
  const be = Fake([{ toolCalls: [{ name: 'echo', args: {} }] }, { content: 'fin' }])
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

test('mcp: prompted mode renders the mcp tool into the system message the backend receives', async () => {
  const be = Fake([{ content: '{"calls":[],"final":"fin"}' }])
  const config = withMcp({ toolCalls: { mode: 'prompted', enforceSchema: false, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' } })
  await collect({ config, task: 'do', workdir: await wd() }, { backend: be, mcp: async () => fakeMcp(), approve: async () => true })
  expect((be.requests[0].messages.find(m => m.role === 'system') as any).content).toContain('echo')
})

test('mcp: refusing the server ends the run before any llm_request', async () => {
  const be = Fake([])
  const ev = await collect({ config: withMcp(), task: 'do', workdir: await wd() }, {
    backend: be, mcp: async () => fakeMcp(), approve: async () => false,
  })
  expect(types(ev)).toEqual(['approval_required', 'done'])
  expect(last(ev).reason).toBe('mcp_error')
  expect(be.requests).toHaveLength(0)
})

test('mcp: a server that will not start ends the run with its message', async () => {
  const be = Fake([])
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
    backend: Fake([]), mcp: async () => fakeMcp(),
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
    backend: Fake([]), mcp: async () => fakeMcp(),
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

test('the guard reaches the tools: an unread edit comes back as a tool error', async () => {
  const cfg = base({ context: { maxToolOutputChars: 200, budgetTokens: 0 }, tools: { enabled: ['read_file', 'edit_file'], approveBash: false, requireReadBeforeEdit: true } })
  const be = Fake([
    { toolCalls: [{ backendId: 'id1', name: 'edit_file', args: { path: 'a.txt', old: 'A', new: 'B' } }] },
    { content: 'giving up' },
  ])
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  const tr = ev.find(e => e.type === 'tool_result') as any
  expect(tr.error).toBe(true)
  expect(tr.output).toContain('has not been read in this run')
})

test('without the flag the same edit goes through', async () => {
  const cfg = base({ tools: { enabled: ['read_file', 'edit_file'], approveBash: false } })
  const be = Fake([
    // 'A'.repeat(120) is the whole file the wd() fixture writes, so this is a clean single match:
    // a bare 'A' would occur 120 times and fail the exact-match check for an unrelated reason.
    { toolCalls: [{ backendId: 'id1', name: 'edit_file', args: { path: 'a.txt', old: 'A'.repeat(120), new: 'B' } }] },
    { content: 'done' },
  ])
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  const tr = ev.find(e => e.type === 'tool_result') as any
  expect(tr.error).toBe(false)
})

// Without this a forgotten line in run.ts gives green unit tests, two identical bench arms and a false null.
test('explainEditMiss reaches the tools: a punctuation miss comes back with the file line', async () => {
  const cfg = base({ context: { maxToolOutputChars: 1000, budgetTokens: 0 }, tools: { enabled: ['read_file', 'edit_file'], approveBash: false, explainEditMiss: true } })
  const be = Fake([
    { toolCalls: [{ backendId: 'id1', name: 'edit_file', args: { path: 'a.txt', old: 'A'.repeat(120) + ';', new: 'B' } }] },
    { content: 'giving up' },
  ])
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  const tr = ev.find(e => e.type === 'tool_result') as any
  expect(tr.error).toBe(true)
  expect(tr.output).toContain('Line 1 of a.txt matches your "old"')
})

// ---- loop.maxRepeats -----------------------------------------------------------
const readA = { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }
const results = (ev: HarnessEvent[]) => ev.filter(e => e.type === 'tool_result') as Extract<HarnessEvent, { type: 'tool_result' }>[]

test('maxRepeats: a repeated call still runs, carries a note, and one repeat too many ends the run', async () => {
  const be = Fake([readA, readA, readA, { content: 'never reached' }])
  const ev = await collect({ config: base({ loop: { maxTurns: 10, maxRepeats: 1 } }), task: 'do', workdir: await wd() }, { backend: be })
  const out = results(ev).map(r => r.output)
  expect(out).toHaveLength(3)
  expect(out[0]).not.toContain('identical call')
  expect(out[1].startsWith('A'.repeat(50))).toBe(true) // executed, not refused
  expect(out[1].endsWith('note: identical call #2 since the last file change')).toBe(true) // after the truncation marker, not cut by it
  expect(last(ev)).toMatchObject({ reason: 'repeat_loop', turns: 3 })
})

test('maxRepeats absent: the same three calls change nothing', async () => {
  const be = Fake([readA, readA, readA, { content: 'fin' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  expect(results(ev).some(r => r.output.includes('identical call'))).toBe(false)
  expect(last(ev).reason).toBe('final')
})

// maxRepeats: 0 makes a single false positive fatal, so these two are sharp.
test('maxRepeats: a successful edit in between makes the same call new again', async () => {
  const edit = { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old: 'A'.repeat(120), new: 'B' } }] }
  const be = Fake([readA, edit, readA, { content: 'fin' }])
  const cfg = base({ tools: { enabled: ['read_file', 'edit_file'], approveBash: false }, loop: { maxTurns: 10, maxRepeats: 0 } })
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(last(ev).reason).toBe('final')
})

test('maxRepeats: an edit the guard refused, then read_file, then the same edit is the recovery, not a repeat', async () => {
  const edit = { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old: 'A'.repeat(120), new: 'B' } }] }
  const be = Fake([edit, readA, edit, { content: 'fin' }])
  const cfg = base({ tools: { enabled: ['read_file', 'edit_file'], approveBash: false, requireReadBeforeEdit: true }, loop: { maxTurns: 10, maxRepeats: 0 } })
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(results(ev).map(r => r.error)).toEqual([true, false, false])
  expect(last(ev).reason).toBe('final')
})

// The third loop in the README: old === new. It is an error now, so it changes no file and clears no count.
test('maxRepeats: a no-op edit is an error, and the calls around it keep their counts', async () => {
  const noop = { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old: 'A'.repeat(120), new: 'A'.repeat(120) } }] }
  const be = Fake([readA, noop, readA, { content: 'never reached' }])
  const cfg = base({ tools: { enabled: ['read_file', 'edit_file'], approveBash: false }, loop: { maxTurns: 10, maxRepeats: 0 } })
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(results(ev).map(r => r.error)).toEqual([false, true, false])
  expect(last(ev)).toMatchObject({ reason: 'repeat_loop', turns: 3 })
})

// Two edits that undo each other: each one used to clear the other's count, so neither reached 2.
test('maxRepeats: an edit and its undo, repeated, are counted across each other', async () => {
  const a = 'A'.repeat(120)
  const there = { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old: a, new: 'B' } }] }
  const back = { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old: 'B', new: a } }] }
  const be = Fake([there, back, there, back, there, { content: 'never reached' }])
  const cfg = base({ tools: { enabled: ['read_file', 'edit_file'], approveBash: false }, loop: { maxTurns: 10, maxRepeats: 1 } })
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  const out = results(ev)
  expect(out.every(r => !r.error)).toBe(true) // every one of them really edited the file
  expect(out.map(r => r.output.split('\n').at(-1))).toEqual([
    'edited a.txt', 'edited a.txt',
    'note: identical call #2 in this run', 'note: identical call #2 in this run', 'note: identical call #3 in this run',
  ])
  expect(last(ev)).toMatchObject({ reason: 'repeat_loop', turns: 5 })
})

test('maxRepeats: write_file is counted over the run like an edit', async () => {
  const w = (content: string) => ({ toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content } }] })
  const be = Fake([w('one'), w('two'), w('one'), { content: 'never reached' }])
  const cfg = base({ tools: { enabled: ['write_file'], approveBash: false }, loop: { maxTurns: 10, maxRepeats: 0 } })
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(results(ev)[2].output.endsWith('note: identical call #2 in this run')).toBe(true)
  expect(last(ev)).toMatchObject({ reason: 'repeat_loop', turns: 3 })
})

// Only an edit that has succeeded keeps its count: a miss, a write that repairs the file, the same edit again is a recovery.
test('maxRepeats: an edit that only ever missed is new again after the file changed', async () => {
  const edit = { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old: 'ZZ', new: 'Y' } }] }
  const write = { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'ZZ' } }] }
  const be = Fake([edit, write, edit, { content: 'fin' }])
  const cfg = base({ tools: { enabled: ['edit_file', 'write_file'], approveBash: false }, loop: { maxTurns: 10, maxRepeats: 0 } })
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(results(ev).map(r => r.error)).toEqual([true, false, false])
  expect(last(ev).reason).toBe('final')
})

// A response cut off at the token limit filled the window; sent back whole, the retry cannot fit (README, MCP).
test('truncated: a long cut-off response goes back as a marker, the event keeps the whole text', async () => {
  const runaway = '{"calls": [' + '`**'.repeat(2500)
  const be = Fake([{ content: runaway, truncated: true }, { content: 'fin' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  const back = be.requests[1].messages.at(-2) as any
  expect(back).toMatchObject({ role: 'assistant', content: `[response cut off at the token limit: kept 0 of ${runaway.length} chars]` })
  const pe = ev.find(e => e.type === 'parse_error') as any
  expect(pe.content).toBe(runaway)
  expect(pe.droppedChars).toBe(runaway.length)
  expect(last(ev).reason).toBe('final')
})

test('truncated: content shorter than the marker goes back as it is, and an empty one stays empty', async () => {
  for (const content of ['<think>endless', '']) {
    const be = Fake([{ content, truncated: true }, { content: 'fin' }])
    const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
    expect((be.requests[1].messages.at(-2) as any).content).toBe(content)
    expect((ev.find(e => e.type === 'parse_error') as any).droppedChars).toBeUndefined()
  }
})

test('a parse error that is not a truncation is never clipped', async () => {
  const prose = 'Sure, let me think about this. '.repeat(20)
  const cfg = base({ toolCalls: { mode: 'prompted', enforceSchema: true, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' } })
  const be = Fake([{ content: prose }, { content: '{"calls":[],"final":"ok"}' }])
  await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect((be.requests[1].messages.at(-2) as any).content).toBe(prose)
})

test('backend.think reaches the request, and only when the harness sets it', async () => {
  const off = Fake([{ content: 'fin' }]), plain = Fake([{ content: 'fin' }])
  const cfg = base(); cfg.backend = { ...cfg.backend, think: false }
  await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: off })
  await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: plain })
  expect(off.requests[0].think).toBe(false)
  expect('think' in plain.requests[0] && plain.requests[0].think !== undefined).toBe(false)
})

test('backend.maxTokens reaches the request, and only when the harness sets it', async () => {
  const capped = Fake([{ content: 'fin' }]), plain = Fake([{ content: 'fin' }])
  const cfg = base(); cfg.backend = { ...cfg.backend, maxTokens: 1024 }
  await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: capped })
  await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: plain })
  expect(capped.requests[0].maxTokens).toBe(1024)
  expect(plain.requests[0].maxTokens).toBeUndefined()
})

const temps = (be: { requests: { temperature?: number }[] }) => be.requests.map(r => r.temperature)

test('repeatTemperature: the turn after a repeat is sampled at it, and a turn without a repeat goes back', async () => {
  const be = Fake([readA, readA, { toolCalls: [{ name: 'read_file', args: { path: 'b.txt' } }] }, { content: 'fin' }])
  const ev = await collect({ config: base({ loop: { maxTurns: 10, maxRepeats: 3, repeatTemperature: 0.9 } }), task: 'do', workdir: await wd() }, { backend: be })
  expect(temps(be)).toEqual([0, 0, 0.9, 0])
  expect(last(ev).reason).toBe('final')
})

// tuned-repeat and guard-repeat have maxRepeats and no repeatTemperature: their requests must not change by a byte.
test('repeatTemperature absent: a repeat under maxRepeats leaves the base temperature in the next request', async () => {
  const be = Fake([readA, readA, { content: 'fin' }])
  await collect({ config: base({ loop: { maxTurns: 10, maxRepeats: 3 } }), task: 'do', workdir: await wd() }, { backend: be })
  expect(temps(be)).toEqual([0, 0, 0])
  expect(be.requests.every(r => 'temperature' in r && r.temperature === 0)).toBe(true)
})

test('repeatTemperature: 0 is a temperature, not "off"', async () => {
  const cfg = base({ loop: { maxTurns: 10, maxRepeats: 3, repeatTemperature: 0 } }); cfg.backend = { ...cfg.backend, temperature: 0.2 }
  const be = Fake([readA, readA, { content: 'fin' }])
  await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(temps(be)).toEqual([0.2, 0.2, 0])
})

test('repeatTemperature: the retry after a parse error goes out at the base temperature', async () => {
  const be = Fake([readA, readA, { content: '' }, { content: 'fin' }])
  await collect({ config: base({ loop: { maxTurns: 10, maxRepeats: 3, repeatTemperature: 0.9 } }), task: 'do', workdir: await wd() }, { backend: be })
  expect(temps(be)).toEqual([0, 0, 0.9, 0])
})

const THINK_SYS = 'sys\n/no_think'
const sysOf = (be: { requests: { messages: { content: string }[] }[] }) => be.requests.map(r => r.messages[0].content)
const caps = (be: { requests: { maxTokens?: number }[] }) => be.requests.map(r => r.maxTokens)

test('repeatThinkTokens: the turn after a repeat goes out with /think and its own token cap, and the next one goes back', async () => {
  const be = Fake([readA, readA, { toolCalls: [{ name: 'read_file', args: { path: 'b.txt' } }] }, { content: 'fin' }])
  const cfg = base({ systemPrompt: THINK_SYS, loop: { maxTurns: 10, maxRepeats: 3, repeatThinkTokens: 2048 } }); cfg.backend = { ...cfg.backend, maxTokens: 1024 }
  await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(sysOf(be)).toEqual([THINK_SYS, THINK_SYS, 'sys\n/think', THINK_SYS])
  expect(caps(be)).toEqual([1024, 1024, 2048, 1024])
  expect(temps(be)).toEqual([0, 0, 0, 0]) // thinking on its own leaves the temperature alone
  // only the system message differs: the history the thinking turn sees is the history
  expect(be.requests[2].messages.slice(1)).toEqual(be.requests[3].messages.slice(1, be.requests[2].messages.length))
})

test('repeatThinkTokens with backend.think off: the thinking turn alone goes out with think on', async () => {
  const be = Fake([readA, readA, { toolCalls: [{ name: 'read_file', args: { path: 'b.txt' } }] }, { content: 'fin' }])
  const cfg = base({ systemPrompt: THINK_SYS, loop: { maxTurns: 10, maxRepeats: 3, repeatThinkTokens: 2048 } }); cfg.backend = { ...cfg.backend, think: false }
  await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(be.requests.map(r => r.think)).toEqual([false, false, true, false])
})

test('repeatThinkTokens: in a prompted run the switch is flipped inside the system message, the tool template stays', async () => {
  const be = Fake([{ content: '{"calls":[{"name":"read_file","args":{"path":"a.txt"}}],"final":null}' }, { content: '{"calls":[{"name":"read_file","args":{"path":"a.txt"}}],"final":null}' }, { content: '{"calls":[],"final":"fin"}' }])
  const cfg = base({ systemPrompt: THINK_SYS, loop: { maxTurns: 10, maxRepeats: 3, repeatThinkTokens: 2048 } })
  cfg.toolCalls = { ...cfg.toolCalls, mode: 'prompted' }
  await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  const [a, , c] = sysOf(be)
  expect(c).toBe(a.replace('/no_think', '/think')); expect(c).not.toBe(a); expect(c).toContain('read_file')
})

test('repeatThinkTokens absent: a repeat leaves the system message and the token cap as they were', async () => {
  const be = Fake([readA, readA, { content: 'fin' }])
  const cfg = base({ systemPrompt: THINK_SYS, loop: { maxTurns: 10, maxRepeats: 3 } }); cfg.backend = { ...cfg.backend, maxTokens: 1024 }
  await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(sysOf(be)).toEqual([THINK_SYS, THINK_SYS, THINK_SYS]); expect(caps(be)).toEqual([1024, 1024, 1024])
})

test('repeatThinkTokens: a thinking reply cut off by the cap is retried without thinking', async () => {
  const be = Fake([readA, readA, { content: '', truncated: true }, { content: 'fin' }])
  await collect({ config: base({ systemPrompt: THINK_SYS, loop: { maxTurns: 10, maxRepeats: 3, repeatThinkTokens: 2048 } }), task: 'do', workdir: await wd() }, { backend: be })
  expect(sysOf(be).map(s => s.includes('/think'))).toEqual([false, false, true, false])
})

const resets = (ev: HarnessEvent[]) => ev.filter(e => e.type === 'context_reset') as Extract<HarnessEvent, { type: 'context_reset' }>[]

test('freshContext: after N repeats the history is the task again, once; the second loop is for maxRepeats', async () => {
  const be = Fake([readA, readA, readA, readA, readA, { content: 'never reached' }])
  const ev = await collect({ config: base({ loop: { maxTurns: 10, maxRepeats: 1, freshContext: 1 } }), task: 'do', workdir: await wd() }, { backend: be })
  const before = be.requests[1].messages, after = be.requests[2].messages
  expect(after.map(m => m.role)).toEqual(['system', 'user'])
  expect(after[0].content).toBe('sys')
  expect(after[1].content.startsWith('do\n\nNote: an earlier attempt')).toBe(true)
  // what went: the assistant turns and tool results of turns 1 and 2 (the second result never entered the history)
  expect(resets(ev)).toHaveLength(1)
  expect(resets(ev)[0]).toMatchObject({ turn: 2, chars: before.slice(2).reduce((n, m) => n + m.content.length, 0) })
  const out = results(ev).map(r => r.output)
  expect(out[1]).toContain('identical call #2')
  expect(out[2]).not.toContain('identical call') // the counts went with the history
  expect(out[3]).toContain('identical call #2')
  expect(last(ev)).toMatchObject({ reason: 'repeat_loop', turns: 5, toolCallCount: 5 })
})

test('freshContext: the looping call twice in one response resets, and the second copy never runs', async () => {
  const cfg = base({ loop: { maxTurns: 10, maxRepeats: 1, freshContext: 1 }, toolCalls: { mode: 'prompted', enforceSchema: false, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' } })
  const call = '{"name":"read_file","args":{"path":"a.txt"}}'
  const be = Fake([{ content: `{"calls":[${call}],"final":null}` }, { content: `{"calls":[${call},${call}],"final":null}` }, { content: '{"calls":[],"final":"fin"}' }])
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(resets(ev)).toHaveLength(1)
  expect(results(ev)).toHaveLength(2)
  expect(be.requests[2].messages.map(m => m.role)).toEqual(['system', 'user'])
  expect(last(ev)).toMatchObject({ reason: 'final', toolCallCount: 2 })
})

test('freshContext: the new context has read nothing, so the guard asks for a read again', async () => {
  const cfg = base({ context: { maxToolOutputChars: 200, budgetTokens: 0 }, loop: { maxTurns: 10, maxRepeats: 1, freshContext: 1 },
    tools: { enabled: ['read_file', 'edit_file'], approveBash: false, requireReadBeforeEdit: true } })
  const be = Fake([readA, readA, { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old: 'A'.repeat(120), new: 'B' } }] }, { content: 'fin' }])
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(results(ev)[2]).toMatchObject({ error: true })
  expect(results(ev)[2].output).toContain('has not been read in this run')
})

test('freshContext: the turn after the reset is not a hot one', async () => {
  const be = Fake([readA, readA, { content: 'fin' }])
  await collect({ config: base({ loop: { maxTurns: 10, maxRepeats: 1, freshContext: 1, repeatTemperature: 0.9 } }), task: 'do', workdir: await wd() }, { backend: be })
  expect(temps(be)).toEqual([0, 0, 0])
})

test('freshContext absent: nothing is reset', async () => {
  const be = Fake([readA, readA, { content: 'fin' }])
  const ev = await collect({ config: base({ loop: { maxTurns: 10, maxRepeats: 3 } }), task: 'do', workdir: await wd() }, { backend: be })
  expect(resets(ev)).toHaveLength(0)
  expect(be.requests[2].messages).toHaveLength(6)
})

const until = (cmd: string, over: Partial<HarnessConfig> = {}) => base({ loop: { maxTurns: 4, untilBash: cmd }, ...over })
const checks = (ev: HarnessEvent[]) => ev.filter(e => e.type === 'final_check') as Extract<HarnessEvent, { type: 'final_check' }>[]
const asked = (ev: HarnessEvent[]) => (ev.filter(e => e.type === 'approval_required') as Extract<HarnessEvent, { type: 'approval_required' }>[]).map(e => e.call)
const yes = { approve: async () => true }

test('untilBash: approved once before any model time; a final with the command green is final', async () => {
  const be = Fake([{ content: 'fin' }])
  const ev = await collect({ config: until('true'), task: 'do', workdir: await wd() }, { backend: be, ...yes })
  expect(types(ev).slice(0, 2)).toEqual(['approval_required', 'context_stats'])
  expect(asked(ev)).toEqual([{ callId: 'until0', name: 'until_bash', args: { command: 'true' } }])
  expect(checks(ev)).toMatchObject([{ command: 'true', passed: true }])
  expect(last(ev)).toMatchObject({ reason: 'final', text: 'fin' })
})

test('untilBash: a final with the command red goes back to the model with the output, and the run goes on', async () => {
  const be = Fake([{ content: 'done!' }, { toolCalls: [{ name: 'bash', args: { command: 'touch ok.txt' } }] }, { content: 'now done' }])
  const ev = await collect({ config: until('echo looking; test -f ok.txt'), task: 'do', workdir: await wd() }, { backend: be, ...yes })
  expect(checks(ev).map(c => c.passed)).toEqual([false, true])
  const m = be.requests[1].messages
  expect(m.slice(-2).map(x => x.role)).toEqual(['assistant', 'user'])
  expect(m[m.length - 1].content).toBe('not finished: `echo looking; test -f ok.txt` did not exit 0\nlooking\n\n[exit 1]')
  expect(last(ev)).toMatchObject({ reason: 'final', text: 'now done', turns: 3, toolCallCount: 1 })
})

test('untilBash: a model that only ever says it is done ends max_turns', async () => {
  const be = Fake([{ content: 'a' }, { content: 'b' }, { content: 'c' }, { content: 'd' }])
  const ev = await collect({ config: until('false'), task: 'do', workdir: await wd() }, { backend: be, ...yes })
  expect(checks(ev)).toHaveLength(4)
  expect(last(ev).reason).toBe('max_turns')
})

const lastMsg = (be: { requests: { messages: { content: string }[] }[] }, i: number) => be.requests[i].messages.at(-1)!.content

test('untilBash under maxRepeats: a check that fails again with no file change is a repeat, whatever the claim says', async () => {
  const be = Fake([{ content: 'a' }, { content: 'b' }, { content: 'c' }, { content: 'd' }])
  const ev = await collect({ config: until('false', { loop: { maxTurns: 10, untilBash: 'false', maxRepeats: 1 } }), task: 'do', workdir: await wd() }, { backend: be, ...yes })
  expect(lastMsg(be, 1)).not.toContain('note:')
  expect(lastMsg(be, 2).endsWith('[exit 1]\nnote: check #2 with no file change since the last one')).toBe(true)
  expect(checks(ev)).toHaveLength(3) // the third is still run and recorded: bash may have changed what no tool saw
  expect(last(ev)).toMatchObject({ reason: 'repeat_loop', turns: 3 })
})

test('untilBash under maxRepeats: a file change between two failed checks starts the count again', async () => {
  const edit = { toolCalls: [{ name: 'write_file', args: { path: 'b.txt', content: 'x' } }] }
  const be = Fake([{ content: 'a' }, edit, { content: 'b' }, { content: 'c' }, { content: 'd' }])
  const cfg = until('false', { tools: { enabled: ['write_file', 'bash'], approveBash: false }, loop: { maxTurns: 5, untilBash: 'false', maxRepeats: 1 } })
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be, ...yes })
  expect(lastMsg(be, 3)).not.toContain('note:')
  expect(lastMsg(be, 4)).toContain('note: check #2')
  expect(last(ev)).toMatchObject({ reason: 'repeat_loop', turns: 5 }) // without the restart it would have been turn 4
})

test('untilBash with repeatThinkTokens: a repeated failed check draws the thinking turn, a first one after a thinking turn does not keep it', async () => {
  const be = Fake([readA, readA, { content: 'done' }, { content: 'done' }, { content: 'done' }, { content: 'fin' }])
  const cfg = until('false', { systemPrompt: THINK_SYS, loop: { maxTurns: 5, untilBash: 'false', maxRepeats: 3, repeatThinkTokens: 2048 } })
  await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be, ...yes })
  // turn 3 thinks for the repeated read; its claim is check #1, so turn 4 does not think; check #2 on turn 4 makes turn 5 think
  expect(sysOf(be).map(s => s.includes('/think'))).toEqual([false, false, true, false, true])
})

test('untilBash: exit 0 is read before the output is cut, and the event carries the cut text', async () => {
  const be = Fake([{ content: 'fin' }])
  const ev = await collect({ config: until('cat a.txt'), task: 'do', workdir: await wd() }, { backend: be, ...yes })
  expect(checks(ev)[0].passed).toBe(true)
  expect(checks(ev)[0].output).toBe('A'.repeat(50) + '\n[truncated: 79 more chars]')
  expect(last(ev).reason).toBe('final')
})

test('untilBash: refused, or nobody to ask, is a stated error and no model time', async () => {
  for (const opts of [{ approve: async () => false }, {}]) {
    const be = Fake([])
    const ev = await collect({ config: until('true'), task: 'do', workdir: await wd() }, { backend: be, ...opts })
    expect(types(ev)).toEqual(['approval_required', 'error', 'done'])
    expect((ev[1] as any).message).toContain('untilBash')
    expect(last(ev).reason).toBe('aborted')
    expect(be.requests).toHaveLength(0)
  }
})

test('untilBash: refused after the mcp servers were approved, no server is ever started', async () => {
  let started = 0
  const ev = await collect({ config: withMcp({ loop: { maxTurns: 4, untilBash: 'true' } }), task: 'do', workdir: await wd() }, {
    backend: Fake([]), mcp: async () => { started++; return fakeMcp() }, approve: async (c: any) => c.name !== 'until_bash',
  })
  expect(asked(ev).map(c => c.callId)).toEqual(['mcp1', 'until0'])
  expect(started).toBe(0)
  expect(last(ev).reason).toBe('aborted')
})

test('untilBash under approveBash: every execution asks, because it runs what the model wrote', async () => {
  const cfg = until('false', { tools: { enabled: ['read_file', 'bash'], approveBash: true } })
  const be = Fake([{ content: 'a' }, { content: 'b' }])
  const answers = [true, true, false]
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be, approve: async () => answers.shift()! })
  expect(asked(ev).map(c => c.callId)).toEqual(['until0', 'until1', 'until2'])
  expect(checks(ev)).toHaveLength(1) // the refused one never ran
  expect(ev.some(e => e.type === 'error' && e.message.includes('untilBash'))).toBe(true)
  expect(last(ev).reason).toBe('aborted')
})

test('untilBash: a stop that arrives while the check runs is aborted, even if the check came back green', async () => {
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 60)
  const ev = await collect({ config: until('sleep 0.4'), task: 'do', workdir: await wd() }, { backend: Fake([{ content: 'fin' }]), signal: ac.signal, ...yes })
  expect(last(ev).reason).toBe('aborted')
})

test('untilBash absent: a final is final, nothing is asked and nothing is run', async () => {
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: Fake([{ content: 'fin' }]) })
  expect(types(ev)).toEqual(['context_stats', 'llm_request', 'llm_response', 'done'])
})

// answerSchema: the form of the final answer comes with the task; the harness decides whether the server holds the model to it.
test('answerSchema goes out only from a native harness with no tools and enforceSchema on, and then no tools field goes with it', async () => {
  const schema = { type: 'object' }
  const tc = base().toolCalls
  const sent = async (over: Partial<HarnessConfig>, answerSchema?: Record<string, unknown>) => {
    const be = Fake([{ content: '{}' }])
    const ev = await collect({ config: base(over), task: 'judge', workdir: await wd(), answerSchema }, { backend: be })
    expect(last(ev)).toMatchObject({ reason: 'final', text: '{}', turns: 1 })
    return [be.requests[0].responseSchema, be.requests[0].tools]
  }
  const none = { enabled: [], approveBash: true }
  expect(await sent({ tools: none, toolCalls: { ...tc, mode: 'native', enforceSchema: true } }, schema)).toEqual([schema, undefined])
  expect(await sent({ tools: none, toolCalls: { ...tc, mode: 'native', enforceSchema: false } }, schema)).toEqual([undefined, undefined])
  expect(await sent({ tools: none, toolCalls: { ...tc, mode: 'native', enforceSchema: true } })).toEqual([undefined, undefined])
  const withTool = await sent({ tools: { enabled: ['read_file'], approveBash: true }, toolCalls: { ...tc, mode: 'native', enforceSchema: true } }, schema)
  expect([withTool[0], (withTool[1] as unknown[]).length]).toEqual([undefined, 1])
})

// tools.editMissEscalation: failed edits of one file since it was last read or changed; from the Nth on, the error says to read it again.
const escCfg = (n?: number) => base({ context: { maxToolOutputChars: 1000, budgetTokens: 0 }, loop: { maxTurns: 8 },
  tools: { enabled: ['read_file', 'edit_file'], approveBash: false, ...(n === undefined ? {} : { editMissEscalation: n }) } })
const miss = { toolCalls: [{ name: 'edit_file', args: { path: './a.txt', old: 'zzz', new: 'y' } }] }
const reread = { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }
const fix = { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old: 'A'.repeat(120), new: 'B' } }] }
const edits = (ev: HarnessEvent[]) => (ev.filter(e => e.type === 'tool_result' && e.name === 'edit_file') as any[]).map(e => e.output as string)
const NOTE = 'note: miss #3 on a.txt — read the file again with read_file before editing it, or rewrite it with write_file'

test('editMissEscalation: the third miss on a file says to read it again, the first two do not', async () => {
  const ev = await collect({ config: escCfg(3), task: 'do', workdir: await wd() }, { backend: Fake([miss, miss, miss, { content: 'x' }]) })
  const out = edits(ev)
  expect(out[0]).not.toContain('note: miss'); expect(out[1]).not.toContain('note: miss')
  expect(out[2]).toContain(NOTE)
})

test('editMissEscalation: reading the file starts the count again', async () => {
  const ev = await collect({ config: escCfg(3), task: 'do', workdir: await wd() }, { backend: Fake([miss, miss, reread, miss, { content: 'x' }]) })
  expect(edits(ev).some(o => o.includes('note: miss'))).toBe(false)
})

test('editMissEscalation: a successful edit starts the count again', async () => {
  const ev = await collect({ config: escCfg(3), task: 'do', workdir: await wd() }, { backend: Fake([miss, miss, fix, miss, { content: 'x' }]) })
  expect(edits(ev)[2]).toBe('edited a.txt')
  expect(edits(ev).some(o => o.includes('note: miss'))).toBe(false)
})

test('editMissEscalation off: three misses, no note — the requests are what they were', async () => {
  const ev = await collect({ config: escCfg(), task: 'do', workdir: await wd() }, { backend: Fake([miss, miss, miss, { content: 'x' }]) })
  expect(edits(ev).some(o => o.includes('note: miss'))).toBe(false)
})

test('the model\'s bash and loop.untilBash see a variable named in tools.bashEnv and nothing else of ours', async () => {
  process.env.LHB_RUN_NAMED = 'named'; process.env.LHB_RUN_SECRET = 'secret'
  try {
    const tools: HarnessConfig['tools'] = { enabled: ['bash'], approveBash: false, bashEnv: ['LHB_RUN_NAMED'] }
    const be = Fake([{ toolCalls: [{ name: 'bash', args: { command: 'echo "[$LHB_RUN_NAMED][$LHB_RUN_SECRET]"' } }] }, { content: 'fin' }])
    const ev = await collect({ config: until('test "$LHB_RUN_NAMED" = named && test -z "$LHB_RUN_SECRET"', { tools }), task: 'do', workdir: await wd() }, { backend: be, ...yes })
    const tr = ev.find(e => e.type === 'tool_result') as Extract<HarnessEvent, { type: 'tool_result' }>
    expect(tr.output).toContain('[named][]')
    expect(checks(ev)).toMatchObject([{ passed: true }])
    expect(last(ev)).toMatchObject({ reason: 'final' })
  } finally { delete process.env.LHB_RUN_NAMED; delete process.env.LHB_RUN_SECRET }
})

test('mayAsk: the three places a run can stop at an approval, and nothing else', () => {
  expect(mayAsk(base({ tools: { enabled: ['bash'], approveBash: true } }))).toBe(true)
  expect(mayAsk(base({ tools: { enabled: [], approveBash: true } }))).toBe(false) // curator-judge: no bash to ask about
  expect(mayAsk(base({ tools: { enabled: ['bash'], approveBash: false } }))).toBe(false)
  expect(mayAsk(base({ tools: { enabled: [], approveBash: false }, loop: { maxTurns: 2, untilBash: 'true' } }))).toBe(true)
  expect(mayAsk(base({ tools: { enabled: [], approveBash: false }, mcpServers: { s: { command: 'x' } } }))).toBe(true)
  expect(mayAsk(base({ tools: { enabled: [], approveBash: false }, mcpServers: {} }))).toBe(false)
})

const KEY_NAME = 'LHB_RUN_TEST_API_KEY'
const KEY = 'sk-or-v1-' + 'f3'.repeat(16)
const MARK = `[redacted: ${KEY_NAME}]`
const keyed = (over: Partial<HarnessConfig> = {}) => base({ backend: { ...harness().backend, baseUrl: 'https://or.example/v1', apiKeyEnv: KEY_NAME }, ...over })
const withKey = async (f: () => Promise<void>) => { process.env[KEY_NAME] = KEY; try { await f() } finally { delete process.env[KEY_NAME] } }
const leaked = (x: unknown) => JSON.stringify(x).includes(KEY)
const keyTools: HarnessConfig['tools'] = { enabled: ['bash'], approveBash: false, bashEnv: [KEY_NAME] }

test('bash output that holds the backend key reaches the history and the event as the mark', () => withKey(async () => {
  const be = Fake([{ toolCalls: [{ name: 'bash', args: { command: `printf %s "$${KEY_NAME}"` } }] }, { content: 'fin' }])
  const ev = await collect({ config: keyed({ tools: keyTools }), task: 'do', workdir: await wd() }, { backend: be })
  expect((ev.find(e => e.type === 'tool_result') as any).output).toContain(MARK)
  expect(leaked(ev)).toBe(false)
  expect(JSON.stringify(be.requests[1].messages)).toContain(MARK); expect(leaked(be.requests[1].messages)).toBe(false)
}))

test('an until_bash check that prints the key: final_check and the next request carry the mark', () => withKey(async () => {
  const be = Fake([{ content: 'done' }, { content: 'done again' }])
  const config = keyed({ tools: keyTools, loop: { maxTurns: 2, untilBash: `printf %s "$${KEY_NAME}"; exit 1` } })
  const ev = await collect({ config, task: 'do', workdir: await wd() }, { backend: be, ...yes })
  expect(checks(ev)[0]).toMatchObject({ passed: false })
  expect(checks(ev)[0].output).toContain(MARK)
  expect(leaked(ev)).toBe(false)
  expect(JSON.stringify(be.requests[1].messages)).toContain(MARK); expect(leaked(be.requests[1].messages)).toBe(false)
}))

test('an mcp result that holds the key: tool_result and the next request carry the mark; the servers start without it', () => withKey(async () => {
  let opts: any
  const be = Fake([{ toolCalls: [{ name: 'echo', args: {} }] }, { content: 'fin' }])
  const ev = await collect({ config: keyed({ mcpServers: { fs: { command: 'npx', args: ['.'] } } }), task: 'do', workdir: await wd() }, {
    backend: be, approve: async () => true,
    mcp: async (_s: unknown, _w: unknown, o: unknown) => { opts = o; return fakeMcp({ call: async () => ({ output: `token=${KEY}`, error: false }) }) },
  })
  expect((ev.find(e => e.type === 'tool_result') as any).output).toBe(`token=${MARK}`)
  expect(leaked(ev)).toBe(false); expect(leaked(be.requests[1].messages)).toBe(false)
  expect(opts.dropEnv).toBe(KEY_NAME)
}))

test('a key the cut would split is taken out first: no part of it is left, and the truncation counts the redacted text', () => withKey(async () => {
  const dir = await wd(); await writeFile(join(dir, 'k.txt'), 'x'.repeat(30) + KEY)
  const be = Fake([{ toolCalls: [{ name: 'read_file', args: { path: 'k.txt' } }] }, { content: 'fin' }])
  const ev = await collect({ config: keyed(), task: 'do', workdir: dir }, { backend: be })
  const tr = ev.find(e => e.type === 'tool_result') as Extract<HarnessEvent, { type: 'tool_result' }>
  expect(tr.truncated).toBe(true)
  expect(tr.output).toBe('x'.repeat(30) + MARK.slice(0, 20) + '\n[truncated: 12 more chars]') // 30 + the 32-char mark is 62, the cap is 50
  expect(tr.output).not.toContain(KEY.slice(0, 9))
}))

test('what goes to the server is left as it is: the key in the task reaches the backend, the events carry the mark', () => withKey(async () => {
  const sent: unknown[] = []
  const be = Fake([{ content: `echo ${KEY}` }])
  const send = be.send.bind(be)
  be.send = async (p, s, d) => { sent.push(structuredClone(p)); return send(p, s, d) }
  const ev = await collect({ config: keyed(), task: `use ${KEY}`, workdir: await wd() }, { backend: be })
  expect(JSON.stringify(sent[0])).toContain(KEY)
  const reqEv = ev.find(e => e.type === 'llm_request') as any
  expect(JSON.stringify(reqEv.payload)).toContain(MARK)
  expect((ev.find(e => e.type === 'llm_response') as any).content).toBe(`echo ${MARK}`)
  expect(last(ev).text).toBe(`echo ${MARK}`)
  expect(leaked(ev)).toBe(false)
}))

test('a backend error whose body holds the key: the error event carries the mark', () => withKey(async () => {
  const be = Fake([])
  be.send = async () => { throw new BackendError('POST /chat/completions: 400', `{"echo":"${KEY}"}`) }
  const ev = await collect({ config: keyed(), task: 'do', workdir: await wd() }, { backend: be })
  expect((ev.find(e => e.type === 'error') as any).body).toBe(`{"echo":"${MARK}"}`)
}))

test('a key under 20 characters is not looked for', async () => {
  process.env[KEY_NAME] = 'k'.repeat(19)
  try {
    const be = Fake([{ content: `say ${'k'.repeat(19)}` }])
    const ev = await collect({ config: keyed(), task: 'do', workdir: await wd() }, { backend: be })
    expect(last(ev).text).toBe(`say ${'k'.repeat(19)}`)
  } finally { delete process.env[KEY_NAME] }
})

test('llm_response.costUsd: only with a price and a usage', async () => {
  const usage = { promptTokens: 1e6, completionTokens: 0 }
  const cost = async (price: HarnessConfig['backend']['pricePerMTok'], u?: typeof usage) => {
    const config = base(); config.backend = { ...config.backend, pricePerMTok: price }
    const ev = await collect({ config, task: 'do', workdir: await wd() }, { backend: Fake([{ content: 'ok', usage: u }]) })
    return ev.find(e => e.type === 'llm_response') as Extract<HarnessEvent, { type: 'llm_response' }>
  }
  expect((await cost({ input: 1, output: 1 }, usage)).costUsd).toBe(1)
  expect('costUsd' in await cost(undefined, usage)).toBe(false)
  expect('costUsd' in await cost({ input: 1, output: 1 })).toBe(false)
})

test('native blocks of an unchanged reply go back verbatim; a parse-error reply drops them', async () => {
  const native = [{ type: 'thinking', thinking: 't', signature: 's' }]
  const be = Fake([{ content: '', native, toolCalls: [{ backendId: 'id1', name: 'read_file', args: { path: 'a.txt' } }] }, { content: 'ok' }])
  await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  expect(be.requests[1].messages.find(m => m.role === 'assistant')).toMatchObject({ native })

  const cfg = base({ toolCalls: { ...base().toolCalls, mode: 'prompted' } })
  const be2 = Fake([{ content: 'not json', native }, { content: '{"final":"x"}' }])
  await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be2 })
  const a = be2.requests[1].messages.find(m => m.role === 'assistant') as any
  expect(a.native).toBeUndefined()
})

test('a tool that errored goes back with isError', async () => {
  const be = Fake([{ toolCalls: [{ backendId: 'id1', name: 'nope', args: {} }] }, { content: 'ok' }])
  await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  expect(be.requests[1].messages.at(-1)).toMatchObject({ role: 'tool', isError: true })
})

test('a knob the model does not take is not sent and the run says so first; the harness keeps its value', async () => {
  const config = base({ backend: { kind: 'ollama', baseUrl: 'http://x', model: 'fake-model', temperature: 0.2 } })
  const be = Object.assign(Fake([{ content: 'done!' }]), { async serverInfo() { return { takes: { temperature: false as const }, takesFrom: 'test' } } })
  const ev = await collect({ config, task: 'do', workdir: await wd() }, { backend: be })
  expect(ev[0]).toMatchObject({ type: 'knobs_off', turn: 0, off: [{ knob: 'temperature', value: 0.2 }] })
  expect(be.requests[0].temperature).toBeUndefined()
  expect(config.backend.temperature).toBe(0.2)
  expect(last(ev).reason).toBe('final')
})

test('a structural knob the model does not take refuses the run before any request', async () => {
  const be = Object.assign(Fake([{ content: 'x' }]), { async serverInfo() { return { takes: { tools: false as const }, takesFrom: 'test' } } })
  const config = base({ backend: { kind: 'ollama', baseUrl: 'http://x', model: 'fake-model', temperature: 0 } })
  const ev = await collect({ config, task: 'do', workdir: await wd() }, { backend: be })
  expect(types(ev)).toEqual(['error', 'done'])
  expect((ev[0] as any).message).toContain('mode: "prompted"')
  expect(last(ev).reason).toBe('backend_error')
  expect(be.requests).toHaveLength(0)
})

test('anthropic without maxTokens sends the model\'s own output cap', async () => {
  const config = base({ backend: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-5-5', temperature: 0 } })
  const be = Object.assign(Fake([{ content: 'done!' }]), { async serverInfo() { return { maxOutput: 64000, router: false } } })
  await collect({ config, task: 'do', workdir: await wd() }, { backend: be })
  expect(be.requests[0].maxTokens).toBe(64000)
})

test('keyless openai: serverInfo is not asked (a router would load the model; its answer has no takes)', async () => {
  let asked = 0
  const be = Object.assign(Fake([{ content: 'done!' }]), { async serverInfo() { asked++; return undefined } })
  await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be })
  expect(asked).toBe(0)
})

test('anthropic with no maxTokens and no answer from the server: the refusal names the failed lookup', async () => {
  const config = base({ backend: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-5-5', temperature: 0 } })
  const be = Object.assign(Fake([]), { async serverInfo() { return undefined } })
  const ev = await collect({ config, task: 'do', workdir: await wd() }, { backend: be })
  expect((ev[0] as any).message).toContain('GET /v1/models/claude-haiku-5-5 failed or the model is unknown')
  expect(be.requests).toHaveLength(0)
})

test('a price with no usage reported: no cost on the response event', async () => {
  const config = base({ backend: { kind: 'openai', baseUrl: 'http://x/v1', model: 'fake-model', temperature: 0, pricePerMTok: { input: 1, output: 1 } } })
  const ev = await collect({ config, task: 'do', workdir: await wd() }, { backend: Fake([{ content: 'done!' }]) })
  expect(ev.find(e => e.type === 'llm_response')).not.toHaveProperty('costUsd')
})

test('no context limits: a long tool output is not truncated and nothing is stubbed', async () => {
  const be = Fake([{ toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { content: 'x' }])
  const cfg = base(); delete (cfg as any).context
  const ev = await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  const tr = ev.filter(e => e.type === 'tool_result') as any[]
  expect(tr.every(t => !t.truncated && t.output.includes('A'.repeat(120)))).toBe(true)
  const stats = ev.filter(e => e.type === 'context_stats') as any[]
  expect(stats.every(s => s.droppedChars === 0 && s.budgetTokens === undefined)).toBe(true)
})

test('bash timeout knob: the description the model reads names the real limit, native and prompted', async () => {
  const cfg = base({ tools: { enabled: ['bash'], approveBash: false, bashTimeoutS: 5 } })
  const be = Fake([{ content: 'x' }])
  await collect({ config: cfg, task: 'do', workdir: await wd() }, { backend: be })
  expect(be.requests[0].tools![0].description).toMatch(/ 5s timeout/)
  const pr = Fake([{ content: '{"calls":[],"final":"done"}' }])
  await collect({ config: { ...cfg, toolCalls: { mode: 'prompted', enforceSchema: true, promptedTemplate: '{{tools}}', parseErrorHint: 'H' } }, task: 'do', workdir: await wd() }, { backend: pr })
  expect(pr.requests[0].messages[0].content).toMatch(/ 5s timeout/)
})

const nt = (id: string, text: string) => ({ id, ts: 1, author: 'model' as const, text })

test('notes: the block goes after the task, and notes_loaded says which, before the first request', async () => {
  const be = Fake([{ content: 'done' }])
  const notes = [nt('a', 'one'), nt('b', 'two')]
  const ev = await collect({ config: base(), task: 'do', workdir: await wd(), notes }, { backend: be })
  expect(be.requests[0].messages[1].content).toBe('do\n\n' + notesBlock(notes))
  const i = ev.findIndex(e => e.type === 'notes_loaded')
  expect(ev[i]).toMatchObject({ ids: ['a', 'b'], chars: notesBlock(notes).length })
  expect(i).toBeLessThan(ev.findIndex(e => e.type === 'llm_request'))
})

test('notes: none or empty leaves the task as it is', async () => {
  for (const notes of [undefined, []]) {
    const be = Fake([{ content: 'done' }])
    const ev = await collect({ config: base(), task: 'do', workdir: await wd(), notes }, { backend: be })
    expect(be.requests[0].messages[1].content).toBe('do')
    expect(types(ev)).not.toContain('notes_loaded')
  }
})

test('notes: a freshContext reset sends the task with its notes again', async () => {
  const be = Fake([readA, readA, readA, readA, readA, { content: 'never reached' }])
  const notes = [nt('a', 'one')]
  await collect({ config: base({ loop: { maxTurns: 10, maxRepeats: 1, freshContext: 1 } }), task: 'do', workdir: await wd(), notes }, { backend: be })
  expect(be.requests[2].messages[1].content.startsWith('do\n\n' + notesBlock(notes) + '\n\nNote: an earlier attempt')).toBe(true)
})

test('the error event carries the BackendError status and moderated flag, and only those', async () => {
  const failing = (e: Error) => ({ ...Fake([]), send: async () => { throw e } })
  const run = async (e: Error) => (await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: failing(e) as any }))
  const withStatus = await run(Object.assign(new BackendError('POST /x: nope'), { status: 402 }))
  expect(withStatus.find(e => e.type === 'error')).toMatchObject({ status: 402 })
  expect(last(withStatus).reason).toBe('backend_error')
  const mod = await run(Object.assign(new BackendError('flagged'), { status: 403, moderated: true }))
  expect(mod.find(e => e.type === 'error')).toMatchObject({ status: 403, moderated: true })
  const textOnly = (await run(new BackendError('POST /x: 429 too many'))).find(e => e.type === 'error') as any
  expect(textOnly).not.toHaveProperty('status')
  expect(textOnly).not.toHaveProperty('moderated')
})

// --- sendRetrying: a 429 is tried again up to 3 times; nothing else is, and nothing that already streamed.
const scripted = (steps: (Error | { content: string; deltas?: { content: string }[] })[]) => {
  let calls = 0
  return {
    get calls() { return calls },
    ...Fake([]),
    async send(_p: unknown, _s?: AbortSignal, onDelta?: (d: any) => void) {
      const s = steps[calls++]
      if (!s) throw new Error('fake backend: no more responses')
      if (s instanceof Error) { if ((s as any).deltas) for (const d of (s as any).deltas) onDelta?.(d); throw s }
      return { content: s.content, toolCalls: [], raw: {} }
    },
  }
}
const r429 = (extra: object = {}) => Object.assign(new BackendError('POST /chat/completions: 429', undefined, { status: 429 }), extra)

test('a 429 is retried and the run goes on as if nothing happened', async () => {
  const be = scripted([r429(), { content: 'fin' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be as any, retryMs: 10 })
  expect(be.calls).toBe(2)
  expect(types(ev)).not.toContain('error')
  expect(last(ev)).toMatchObject({ reason: 'final', text: 'fin' })
})

test('four 429s end the run as backend_error with status 429', async () => {
  const be = scripted([r429(), r429(), r429(), r429(), { content: 'never' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be as any, retryMs: 10 })
  expect(be.calls).toBe(4)
  expect(ev.find(e => e.type === 'error')).toMatchObject({ status: 429 })
  expect(last(ev).reason).toBe('backend_error')
})

test('a 401 and a 429 after a delta are not retried', async () => {
  for (const e of [new BackendError('POST /x: 401', undefined, { status: 401 }), r429({ deltas: [{ content: 'half' }] })]) {
    const be = scripted([e, { content: 'never' }])
    const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be as any, retryMs: 10, onDelta: () => {} })
    expect(be.calls).toBe(1)
    expect(ev.find(x => x.type === 'error')).toMatchObject({ status: e.status })
    expect(last(ev).reason).toBe('backend_error')
  }
})

test('a run timeout during a retry wait ends the run with the 429, not aborted', async () => {
  const be = scripted([r429(), { content: 'never' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be as any, retryMs: 60_000, signal: AbortSignal.timeout(100) })
  expect(be.calls).toBe(1)
  expect(ev.find(e => e.type === 'error')).toMatchObject({ status: 429 })
  expect(last(ev).reason).toBe('backend_error')
}, 10_000)

test('retryAfter is the wait when no override is given', async () => {
  const be = scripted([r429({ retryAfter: 0.01 }), { content: 'fin' }])
  const ev = await collect({ config: base(), task: 'do', workdir: await wd() }, { backend: be as any })
  expect(last(ev)).toMatchObject({ reason: 'final', text: 'fin' })
})
