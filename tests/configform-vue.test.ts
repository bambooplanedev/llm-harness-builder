import { test, expect } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
// @ts-expect-error -- vue SFC, no .d.ts; typechecked separately by vue-tsc
import ConfigForm from '../web/src/ConfigForm.vue'
import type { HarnessConfig } from '../src/core/config.js'

const base: HarnessConfig = {
  name: 'x',
  backend: { kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:8b', numCtx: 8192, temperature: 0.2 },
  systemPrompt: 's',
  tools: { enabled: ['bash'], approveBash: true },
  toolCalls: { mode: 'prompted', format: 'json', enforceSchema: true, promptedTemplate: '{{tools}}', parseErrorHint: 'h' },
  context: { maxToolOutputChars: 4000, budgetTokens: 0 },
  loop: { maxTurns: 15 },
}
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
