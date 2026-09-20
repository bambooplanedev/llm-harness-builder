import { test, expect } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
// @ts-expect-error -- vue SFC, no .d.ts; typechecked separately by vue-tsc
import ConfigForm from '../web/src/ConfigForm.vue'
import type { HarnessConfig } from '../src/core/config.js'
import { harness } from './helpers.js'

// An ollama/prompted harness: the form renders more knobs for it than for the shared default.
const base = harness({
  backend: { kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:8b', numCtx: 8192, temperature: 0.2 },
  toolCalls: { mode: 'prompted', format: 'json', enforceSchema: true, promptedTemplate: '{{tools}}', parseErrorHint: 'h' },
})
const render = (c: HarnessConfig) =>
  renderToString(createSSRApp(ConfigForm, { modelValue: c, models: [], modelsError: '', harnessNames: [] }))

/** The textarea's rendered content, with SSR's entity escaping undone. */
function mcpBox(html: string): string {
  const m = /MCP servers[\s\S]*?<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html)
  if (!m) throw new Error('no MCP servers textarea in the rendered form')
  return m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

test('a harness with mcpServers shows the count and round-trips through the textarea', async () => {
  const mcpServers = { fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], tools: ['read_text_file'] } }
  const html = await render({ ...base, mcpServers })
  expect(html).toContain('MCP servers (1)')
  expect(JSON.parse(mcpBox(html))).toEqual(mcpServers)
})

test('a harness without mcpServers shows an empty box, not "{}" or "undefined"', async () => {
  const html = await render(base)
  expect(html).toContain('MCP servers (0)')
  expect(mcpBox(html)).toBe('')
})

test('the guard checkbox reflects the flag and the label is English', async () => {
  const box = (html: string) => {
    const m = /<input type="checkbox"([^>]*)>\s*refuse to edit a file that has not been read/.exec(html)
    if (!m) throw new Error('no read-before-edit checkbox in the rendered form')
    return m[1]
  }
  expect(box(await render(base))).not.toContain('checked')
  expect(box(await render({ ...base, tools: { ...base.tools, requireReadBeforeEdit: true } }))).toContain('checked')
})

/**
 * The UI, the CLI and the README are English. Two components were written in Ukrainian and shipped
 * that way for three iterations before anyone looked; catch the next one at the commit, not the demo.
 */
test('no non-English text ships in the source', async () => {
  const { readFile } = await import('node:fs/promises')
  const { execFileSync } = await import('node:child_process')
  const root = new URL('..', import.meta.url).pathname
  const files = execFileSync('git', ['ls-files', 'src', 'web/src', 'tests'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean)
  const offenders: string[] = []
  for (const f of files) {
    const text = await readFile(new URL(`../${f}`, import.meta.url), 'utf8')
    text.split('\n').forEach((line, i) => {
      if ([...line].some(ch => ch.codePointAt(0)! >= 0x400 && ch.codePointAt(0)! <= 0x4ff)) offenders.push(`${f}:${i + 1}`)
    })
  }
  expect(offenders).toEqual([])
})

test('max_tokens shows the harness value, and an empty box when the harness has no cap', async () => {
  expect(await render({ ...base, backend: { ...base.backend, maxTokens: 1024 } })).toMatch(/max_tokens<\/span><input[^>]*value="1024"/)
  expect(await render(base)).toMatch(/max_tokens<\/span><input[^>]*value=""/)
})

test('the optional loop knobs show the harness values, 0 included, and empty boxes when the harness has none', async () => {
  const on = await render({ ...base, loop: { maxTurns: 20, maxRepeats: 0, repeatTemperature: 0.7, repeatThinkTokens: 2048, freshContext: 2, untilBash: 'node --test' } })
  for (const [label, value] of [['max repeats', '0'], ['repeat temperature', '0.7'], ['repeat think tokens', '2048'], ['fresh context', '2'], ['until bash', 'node --test']])
    expect(on).toMatch(new RegExp(`${label}</span><input[^>]*value="${value}"`))
  const off = await render(base)
  for (const label of ['max repeats', 'repeat temperature', 'repeat think tokens', 'fresh context', 'until bash'])
    expect(off).toMatch(new RegExp(`${label}</span><input[^>]*value=""`))
})
