import { test, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { renderTools, applyFamily, FAMILIES, PRESETS, DEFAULT_PROMPTED_TEMPLATE, DEFAULT_PARSE_ERROR_HINT, HERMES_TEMPLATE, HERMES_PARSE_ERROR_HINT } from '../src/core/prompts.js'
import { validateConfig } from '../src/core/config.js'
import { harness } from './helpers.js'

const validConfig = harness()

test('renderTools lists name, description and parameters', () => {
  const s = renderTools([{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }])
  expect(s).toContain('read_file')
  expect(s).toContain('Read a file')
  expect(s).toContain('"path"')
})

test('template has placeholder and presets exist', () => {
  expect(DEFAULT_PROMPTED_TEMPLATE).toContain('{{tools}}')
  expect(Object.keys(PRESETS)).toEqual(['minimal', 'opencode-like', 'strict-json'])
})

test('shipped harnesses stay in sync with the defaults and presets', async () => {
  const load = async (n: string) => JSON.parse(await readFile(new URL(`../harnesses/${n}.json`, import.meta.url), 'utf8'))
  const bare = await load('bare'), tuned = await load('tuned')
  expect(bare.systemPrompt).toBe(PRESETS.minimal)
  expect(bare.toolCalls.promptedTemplate).toBe(DEFAULT_PROMPTED_TEMPLATE)
  expect(bare.toolCalls.parseErrorHint).toBe(DEFAULT_PARSE_ERROR_HINT)
  for (const line of PRESETS['opencode-like'].split('\n')) expect(tuned.systemPrompt).toContain(line)
  expect(tuned.toolCalls.promptedTemplate).toBe(DEFAULT_PROMPTED_TEMPLATE)

  const hermes = await load('tuned-hermes')
  expect(hermes.toolCalls).toMatchObject({ mode: 'prompted', format: 'hermes', enforceSchema: false, promptedTemplate: HERMES_TEMPLATE, parseErrorHint: HERMES_PARSE_ERROR_HINT })
  expect(hermes.systemPrompt).toBe(applyFamily(tuned, 'qwen3').systemPrompt)
  expect(hermes.backend).toEqual(tuned.backend); expect(hermes.tools).toEqual(tuned.tools)
  expect(hermes.context).toEqual(tuned.context); expect(hermes.loop).toEqual(tuned.loop)
})

test('default template carries the one-call-per-response rule', () => {
  expect(DEFAULT_PROMPTED_TEMPLATE).toContain('Send one call per response.')
})

test('renderTools hermes: one {"type":"function",...} JSON per line', () => {
  const s = renderTools([{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } }], 'hermes')
  expect(JSON.parse(s)).toEqual({ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } } })
  const two = renderTools([{ name: 'a', description: 'A', parameters: {} }, { name: 'b', description: 'B', parameters: {} }], 'hermes')
  expect(two.split('\n')).toHaveLength(2)
})

test('hermes template mentions <tools>, <tool_call>, <tool_response> and one call per response', () => {
  for (const s of ['{{tools}}', '<tools>', '<tool_call>', '<tool_response>', 'one call per response']) expect(HERMES_TEMPLATE).toContain(s)
  expect(HERMES_PARSE_ERROR_HINT).toContain('<tool_call>')
})

test('applyFamily qwen3 sets prompted/hermes and appends /no_think once', () => {
  const a = applyFamily(validConfig, 'qwen3')
  expect(a.toolCalls).toMatchObject({ mode: 'prompted', format: 'hermes', promptedTemplate: HERMES_TEMPLATE, parseErrorHint: HERMES_PARSE_ERROR_HINT, enforceSchema: validConfig.toolCalls.enforceSchema })
  expect(a.systemPrompt).toBe(validConfig.systemPrompt + '\n/no_think')
  expect(applyFamily(a, 'qwen3').systemPrompt).toBe(a.systemPrompt)
  expect(a.backend).toEqual(validConfig.backend); expect(a.tools).toEqual(validConfig.tools)
  expect(a.context).toEqual(validConfig.context); expect(a.loop).toEqual(validConfig.loop)
  expect(validConfig.systemPrompt).not.toContain('/no_think') // input not mutated
})

test('applyFamily gemma after qwen3 removes /no_think and goes prompted/json; llama3 goes native', () => {
  const g = applyFamily(applyFamily(validConfig, 'qwen3'), 'gemma')
  expect(g.systemPrompt).toBe(validConfig.systemPrompt)
  expect(g.toolCalls).toMatchObject({ mode: 'prompted', format: 'json', promptedTemplate: DEFAULT_PROMPTED_TEMPLATE })
  expect(applyFamily(validConfig, 'llama3').toolCalls.mode).toBe('native')
  expect(() => applyFamily(validConfig, 'bogus')).toThrow(/qwen3/)
  expect(Object.keys(FAMILIES)).toEqual(['qwen3', 'gemma', 'llama3'])
})

test('applyFamily strips a trailing blank line together with the suffix', () => {
  expect(applyFamily({ ...validConfig, systemPrompt: 'sys\n/no_think\n' }, 'qwen3').systemPrompt).toBe('sys\n/no_think')
})

test('applyFamily does not strip a line that merely contains the suffix as a substring', () => {
  expect(applyFamily({ ...validConfig, systemPrompt: 'remember /no_think mode' }, 'qwen3').systemPrompt).toBe('remember /no_think mode\n/no_think')
})

// The two arms of the mcp experiment must differ in one thing only, or the bench measures noise.
test('mcp-off and mcp-on differ from tuned only in where the file tools come from', async () => {
  const load = async (n: string) => JSON.parse(await readFile(new URL(`../harnesses/${n}.json`, import.meta.url), 'utf8'))
  const tuned = await load('tuned'), off = await load('mcp-off'), on = await load('mcp-on')
  for (const h of [off, on]) {
    expect(validateConfig(h)).toEqual([])
    for (const k of ['backend', 'toolCalls', 'context', 'loop']) expect(h[k]).toEqual(tuned[k])
  }
  // One prompt for both arms, and it names no tool: tuned's prompt says "read_file", which does not
  // exist on the mcp side (there it is list_directory, and edit_file takes edits: [{oldText,newText}]).
  expect(off.systemPrompt).toBe(on.systemPrompt)
  for (const name of ['list_dir', 'read_file', 'write_file', 'edit_file', 'list_directory', 'read_text_file'])
    expect(on.systemPrompt).not.toContain(name)
  expect(off.tools).toEqual(tuned.tools)
  expect(off.mcpServers).toBeUndefined()
  expect(on.tools.enabled).toEqual(['bash'])   // bash stays: the demo task needs node --test, which the fs server cannot run
  expect(on.mcpServers).toEqual({ fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } })
})

// One flag apart, or the bench measures something else.
test('guard-hint is guard-only plus explainEditMiss and nothing else', async () => {
  const load = async (n: string) => JSON.parse(await readFile(new URL(`../harnesses/${n}.json`, import.meta.url), 'utf8'))
  const only = await load('guard-only'), hint = await load('guard-hint')
  expect(validateConfig(hint)).toEqual([])
  expect(hint).toEqual({ ...only, name: 'guard-hint', tools: { ...only.tools, explainEditMiss: true } })
})

test('guard-repeat is guard-only plus loop.maxRepeats and nothing else', async () => {
  const load = async (n: string) => JSON.parse(await readFile(new URL(`../harnesses/${n}.json`, import.meta.url), 'utf8'))
  const only = await load('guard-only'), rep = await load('guard-repeat')
  expect(validateConfig(rep)).toEqual([])
  expect(rep).toEqual({ ...only, name: 'guard-repeat', loop: { ...only.loop, maxRepeats: 3 } })
})

test('tuned-repeat is tuned plus loop.maxRepeats and nothing else', async () => {
  const load = async (n: string) => JSON.parse(await readFile(new URL(`../harnesses/${n}.json`, import.meta.url), 'utf8'))
  const tuned = await load('tuned'), rep = await load('tuned-repeat')
  expect(validateConfig(rep)).toEqual([])
  expect(rep).toEqual({ ...tuned, name: 'tuned-repeat', loop: { ...tuned.loop, maxRepeats: 3 } })
})

test('tuned-budget is tuned-repeat plus context.budgetTokens and nothing else', async () => {
  const load = async (n: string) => JSON.parse(await readFile(new URL(`../harnesses/${n}.json`, import.meta.url), 'utf8'))
  const rep = await load('tuned-repeat'), bud = await load('tuned-budget')
  expect(validateConfig(bud)).toEqual([])
  expect(bud).toEqual({ ...rep, name: 'tuned-budget', context: { ...rep.context, budgetTokens: 2670 } })
})

// Every /no_think harness answers in under 200 tokens; bare thinks, and <think> counts against the cap.
// curator writes a verdict per post in one call: 29 of them did not fit 1024 tokens (a window of the real feed, 2026-09-20), 19 did.
test('every shipped harness caps generation at 1024 tokens, except bare (no cap) and curator (4096)', async () => {
  const { readdir } = await import('node:fs/promises')
  const dir = new URL('../harnesses/', import.meta.url)
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  expect(files.length).toBeGreaterThan(5)
  for (const f of files) {
    const h = JSON.parse(await readFile(new URL(f, dir), 'utf8'))
    expect(validateConfig(h)).toEqual([])
    expect([f, h.backend.maxTokens]).toEqual([f, f === 'bare.json' ? undefined : f === 'curator.json' ? 4096 : 1024])
  }
})

// Each line here came from a recorded run of 2026-09-20: the coder's prompt made the model retype lines, the enforced JSON shape was where
// every cut-off reply happened, and /no_think is a Qwen3 line that Gemma did not read.
test('curator: native calls, thinking off through the template, nothing about code in the prompt, no edit_file', async () => {
  const h = JSON.parse(await readFile(new URL('../harnesses/curator.json', import.meta.url), 'utf8'))
  expect(validateConfig(h)).toEqual([])
  expect([h.toolCalls.mode, h.backend.think, h.backend.temperature]).toEqual(['native', false, 0])
  expect(h.systemPrompt).not.toMatch(/no_think|node --test|coding agent|edit_file/)
  expect(h.tools.enabled).toEqual(['list_dir', 'read_file', 'write_file', 'bash'])
})
