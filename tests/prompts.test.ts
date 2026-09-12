import { test, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { renderTools, applyFamily, FAMILIES, PRESETS, DEFAULT_PROMPTED_TEMPLATE, DEFAULT_PARSE_ERROR_HINT, HERMES_TEMPLATE, HERMES_PARSE_ERROR_HINT } from '../src/core/prompts.js'
import type { HarnessConfig } from '../src/core/config.js'

// Do not import validConfig from config.test.ts: importing a test file re-registers its tests here.
const validConfig: HarnessConfig = {
  name: 'test',
  backend: { kind: 'openai', baseUrl: 'http://localhost:8080/v1', model: 'm', temperature: 0 },
  systemPrompt: 'You are a coding agent.',
  tools: { enabled: ['read_file', 'bash'], approveBash: true },
  toolCalls: { mode: 'native', enforceSchema: false, promptedTemplate: 'Tools:\n{{tools}}', parseErrorHint: 'Reply with valid JSON.' },
  context: { maxToolOutputChars: 4000, budgetTokens: 0 },
  loop: { maxTurns: 10 },
}

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
