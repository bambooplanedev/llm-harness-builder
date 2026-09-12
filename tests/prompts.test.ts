import { test, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { renderTools, PRESETS, DEFAULT_PROMPTED_TEMPLATE, DEFAULT_PARSE_ERROR_HINT } from '../src/core/prompts.js'

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
})
