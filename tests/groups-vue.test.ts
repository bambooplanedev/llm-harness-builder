import { test, expect, afterEach } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
// @ts-expect-error -- vue SFC, no .d.ts; typechecked separately by vue-tsc
import Groups from '../web/src/Groups.vue'
import { setFilm } from '../web/src/film'
import type { HarnessEvent } from '../src/core/events.js'

// Runs in the `dom` project (vitest.config.ts), like trace-vue.test.ts.
const md = (rules: string) => `<system-reminder>\nContents of /home/u/proj/CLAUDE.md (project):\n\n${rules}\n</system-reminder>`
const req = (rules: string): HarnessEvent => ({ seq: 0, turn: 1, ts: 0, type: 'llm_request',
  payload: { model: 'claude-fixture-model', system: [{ type: 'text', text: 'You are a coding agent.' }], messages: [{ role: 'user', content: [{ type: 'text', text: md(rules) }, { type: 'text', text: 'fix it' }] }] } })
const res = (content: string, reasoning?: string): HarnessEvent => ({ seq: 1, turn: 1, ts: 0, type: 'llm_response', raw: { model: 'claude-fixture-model' }, content, reasoning, latencyMs: 1 })
const tool = (path: string): HarnessEvent => ({ seq: 2, turn: 1, ts: 0, type: 'tool_call', call: { callId: 'c', name: 'Read', args: { file_path: path } } })
const run = (id: string, rules: string, more: HarnessEvent[] = [res(`answer of ${id}`)]) => ({ id, events: [req(rules), ...more] })
const names = { models: [], urls: [] }
const render = (props: Record<string, unknown>) => renderToString(createSSRApp(Groups, { names, ...props }))

afterEach(() => setFilm(false))

test('a CLAUDE.md line only in B runs shows with its source; each run shows its path, answer and reasoning', async () => {
  const html = await render({
    a: [run('a1', 'Shared rule'), run('a2', 'Shared rule')],
    b: [run('b1', 'Shared rule\nNew rule', [res('done b1', 'because'), tool('/home/u/proj/x.ts')]), run('b2', 'Shared rule\nNew rule')],
  })
  expect(html).toContain('+ CLAUDE.md: New rule')
  expect(html).not.toContain('Shared rule')
  expect(html).toContain('before (A) vs after (B): only lines every run of a side has and no run of the other')
  for (const s of ['a1', 'a2', 'b1', 'b2', 'answer of a2', 'done b1', 'because', 'Read /home/u/proj/x.ts', 'no reasoning recorded']) expect(html).toContain(s)
})

test('a run without responses says nothing is recorded yet', async () => {
  const html = await render({ a: [run('a1', 'R')], b: [run('b1', 'R', [])] })
  expect(html).toContain('nothing recorded yet')
})

test('while a side has no request yet, no diff is drawn: it would list the whole other side', async () => {
  const html = await render({ a: [run('a1', 'Rule A')], b: [{ id: 'b1', events: [] }] })
  expect(html).toContain('waiting for requests…')
  expect(html).not.toContain('Rule A')
})

test('film mode: no machine path and no model name in the comparison', async () => {
  setFilm(true)
  const html = await render({
    a: [run('a1', 'Read /home/u/proj/a.ts', [res('used claude-fixture-model', 'in /home/u/proj')])],
    b: [run('b1', 'Read /home/u/proj/b.ts', [res('ok'), tool('/home/u/proj/x.ts')])],
  })
  expect(html).toContain('CLAUDE.md: Read …/')
  expect(html).not.toMatch(/\/home\/u|claude-fixture-model/)
})
