import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { NEW_HARNESS, advancedSet } from '../web/src/advanced'
import type { HarnessConfig } from '../src/core/config.js'

const fresh = () => structuredClone(NEW_HARNESS)

test('a new harness has no Advanced knob set', () => expect(advancedSet(NEW_HARNESS)).toBe(0))

test('each changed knob counts once', () => {
  const c = fresh()
  c.tools.bashTimeoutS = 60; c.loop.maxRepeats = 0; c.mcpServers = { fs: { command: 'x' } }
  expect(advancedSet(c)).toBe(3)
})

test('bare.json differs only in maxToolOutputChars', () => {
  const bare = JSON.parse(readFileSync(new URL('../harnesses/bare.json', import.meta.url), 'utf8')) as HarnessConfig
  expect(advancedSet(bare)).toBe(1)
})

test('absent equals the built-in: budget 0, empty mcpServers, no templates, guard false', () => {
  const c = fresh()
  c.context = { maxToolOutputChars: 4000, budgetTokens: 0 }; c.mcpServers = {}; c.tools.requireReadBeforeEdit = false
  delete c.toolCalls.promptedTemplate; delete c.toolCalls.parseErrorHint
  expect(advancedSet(c)).toBe(0)
})

test('readRanges and notes each count one when on; readRanges false is absent', () => {
  const c = fresh()
  c.tools.readRanges = false
  expect(advancedSet(c)).toBe(0)
  c.tools.readRanges = true
  expect(advancedSet(c)).toBe(1)
  c.notes = { enabled: true, maxTokens: 1000 }
  expect(advancedSet(c)).toBe(2)
  c.notes = { enabled: false, maxTokens: 1000 }; c.tools.readRanges = false
  expect(advancedSet(c)).toBe(0)
})
