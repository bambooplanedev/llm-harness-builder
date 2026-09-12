import { test, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTool, TOOL_SCHEMAS } from '../src/core/tools/index.js'
import { TOOL_NAMES } from '../src/core/config.js'

test('every tool has a schema with required params', () => {
  for (const n of TOOL_NAMES) expect(TOOL_SCHEMAS[n].parameters).toHaveProperty('required')
})

test('unknown or disabled tool is a tool error, not a throw', async () => {
  const ctx = { workdir: await mkdtemp(join(tmpdir(), 'lhb-reg-')), maxToolOutputChars: 100 }
  const r1 = await runTool('grep', { q: 'x' }, ctx, ['read_file'])
  expect(r1.error).toBe(true); expect(r1.output).toMatch(/unknown tool grep.*available: read_file/)
  const r2 = await runTool('bash', { command: 'ls' }, ctx, ['read_file'])
  expect(r2.error).toBe(true)
})

test('missing required arg is a tool error', async () => {
  const ctx = { workdir: await mkdtemp(join(tmpdir(), 'lhb-reg-')), maxToolOutputChars: 100 }
  const r = await runTool('read_file', {}, ctx, ['read_file'])
  expect(r.error).toBe(true); expect(r.output).toMatch(/path/)
})

test('tool failure is returned as error text', async () => {
  const ctx = { workdir: await mkdtemp(join(tmpdir(), 'lhb-reg-')), maxToolOutputChars: 100 }
  const r = await runTool('read_file', { path: 'nope' }, ctx, ['read_file'])
  expect(r.error).toBe(true); expect(r.output).toMatch(/ENOENT|no such file/i)
})
