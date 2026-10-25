import { test, expect } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
// @ts-expect-error -- vue SFC, no .d.ts; typechecked separately by vue-tsc
import ConfigForm from '../web/src/ConfigForm.vue'
import { H } from '../web/src/hints'
import type { HarnessConfig } from '../src/core/config.js'
import { DEFAULT_PROMPTED_TEMPLATE, DEFAULT_PARSE_ERROR_HINT } from '../src/core/prompts.js'
import { harness } from './helpers.js'

// An ollama/prompted harness: the form renders more knobs for it than for the shared default.
const base = harness({
  backend: { kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:8b', numCtx: 8192, temperature: 0.2 },
  toolCalls: { mode: 'prompted', format: 'json', enforceSchema: true, promptedTemplate: '{{tools}}', parseErrorHint: 'h' },
})
const render = (c: HarnessConfig, models: string[] = []) =>
  renderToString(createSSRApp(ConfigForm, { modelValue: c, models, modelsError: '', harnessNames: [] }))

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
    .filter(f => !['web/src/hints.ts', 'web/src/uk.ts'].includes(f)) // Ukrainian on purpose: the hover hints, and the Ukrainian catalog in uk.ts
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

// SSR writes the bound value on the select itself; in a browser Vue sets it as the DOM property once the options exist.
const formatSelect = (html: string) => /<select[^>]*value="(\w+)"><option value="json">/.exec(html)?.[1]

test('a prompted harness without toolCalls.format shows json, and rendering it does not write the key', async () => {
  const { format: _, ...toolCalls } = base.toolCalls
  const c = { ...base, toolCalls } as HarnessConfig
  expect(formatSelect(await render(c))).toBe('json')
  expect('format' in c.toolCalls).toBe(false)
  expect(formatSelect(await render({ ...base, toolCalls: { ...base.toolCalls, format: 'hermes' } }))).toBe('hermes')
})

test('think shows the harness value: on, off, and — when the harness sends nothing; rendering does not write the key', async () => {
  const selected = (html: string) => /think<\/span><select value="(\w*)">/.exec(html)?.[1]
  expect(selected(await render(base))).toBe('')
  expect('think' in base.backend).toBe(false)
  expect(selected(await render({ ...base, backend: { ...base.backend, think: false } }))).toBe('off')
  expect(selected(await render({ ...base, backend: { ...base.backend, think: true } }))).toBe('on')
})

test('the edit-miss escalation box shows the value, and an empty box for a harness without it', async () => {
  const on = await render({ ...base, tools: { ...base.tools, editMissEscalation: 3 } })
  expect(on).toContain(`title="${H.escalation}">edit misses before a re-read note</span><input type="number" min="1" value="3"`)
  const off = await render(base)
  expect(off).toMatch(/edit misses before a re-read note<\/span><input type="number" min="1" value=""/)
})

test('tools.bashEnv shows as a read-only line with the names, and not at all when absent', async () => {
  const html = await render({ ...base, tools: { ...base.tools, bashEnv: ['GITHUB_TOKEN', 'TZ'] } })
  expect(html).toContain('bash gets from your environment: GITHUB_TOKEN, TZ')
  expect(await render(base)).not.toContain('bash gets from your environment')
})

test('the key env box shows the name, and the line under the backend says where the key goes; nothing without a key or for a name validation refuses', async () => {
  const keyed = { ...base, backend: { kind: 'openai' as const, baseUrl: 'https://openrouter.ai/api/v1', model: 'm', temperature: 0, apiKeyEnv: 'OPENROUTER_API_KEY' } }
  const html = await render(keyed)
  expect(html).toContain('value="OPENROUTER_API_KEY"')
  expect(html).toContain('the key in OPENROUTER_API_KEY goes to openrouter.ai')
  expect(await render(base)).not.toContain('the key in')
  expect(await render({ ...keyed, backend: { ...keyed.backend, apiKeyEnv: 'sk-or-v1-pasted-by-mistake' } })).not.toContain('the key in')
  expect(await render({ ...keyed, backend: { ...keyed.backend, baseUrl: '' } })).not.toContain('the key in')
})

test('with a key and no models listed, the form says the list waits for the refresh button, because that request carries the key; without a key, or once there are models, it says nothing', async () => {
  const keyed = { ...base, backend: { kind: 'openai' as const, baseUrl: 'https://openrouter.ai/api/v1', model: 'm', temperature: 0, apiKeyEnv: 'OPENROUTER_API_KEY' } }
  const asks = 'to list the models: that request carries the key'
  const html = await render(keyed, [])
  expect(html).toContain('press '); expect(html).toContain(asks)
  expect(await render(keyed, ['m'])).not.toContain(asks)
  expect(await render(base, [])).not.toContain(asks)
})

const anthropic = { ...base, backend: { kind: 'anthropic' as const, baseUrl: 'https://api.anthropic.com/v1', model: 'claude-x', temperature: 0.2, maxTokens: 1024, apiKeyEnv: 'ANTHROPIC_API_KEY' } }
const withInfo = (c: HarnessConfig, modelInfo: unknown) =>
  renderToString(createSSRApp(ConfigForm, { modelValue: c, models: [], modelsError: '', harnessNames: [], modelInfo }))

test('the backend select offers anthropic, and rendering a harness of that kind neither writes nor removes a key', async () => {
  const c = structuredClone(anthropic)
  const html = await render(c)
  expect(html).toMatch(/<option value="anthropic"[^>]*>anthropic \(native\)<\/option>/)
  expect(c).toEqual(anthropic)
})

test('a knob the model does not take is a disabled box with a hint and where that was said; the value stays in the harness', async () => {
  const c = structuredClone({ ...anthropic, loop: { ...anthropic.loop, repeatTemperature: 0.7 } })
  const html = await withInfo(c, { takes: { temperature: false }, takesFrom: 'Anthropic API 2026-10-21' })
  expect(html).toMatch(/temp<\/span><input[^>]*disabled/)
  expect(html).toMatch(/repeat temperature<\/span><input[^>]*disabled/)
  expect(html).not.toMatch(/max_tokens<\/span><input[^>]*disabled/)
  expect(html).toContain('this knob is not available for this model')
  expect(html).toContain('Anthropic API 2026-10-21')
  expect(c.backend.temperature).toBe(0.2)
  const free = await withInfo(c, undefined)
  expect(free).not.toMatch(/temp<\/span><input[^>]*disabled/)
  expect(free).not.toContain('not available for this model')
})


test('context boxes: show the harness values, and empty boxes when the harness sets no limit', async () => {
  const none = { ...base } as any; delete none.context
  expect(await render(none)).toMatch(/max tool output chars \(empty = no limit\)<\/span><input[^>]*value=""/)
  expect(await render(none)).toMatch(/budget tokens \(empty = no budget\)<\/span><input[^>]*value=""/)
  const set = { ...base, context: { maxToolOutputChars: 50, budgetTokens: 60 } } as HarnessConfig
  expect(await render(set)).toMatch(/max tool output chars[^<]*<\/span><input[^>]*value="50"/)
  expect(await render(set)).toMatch(/budget tokens[^<]*<\/span><input[^>]*value="60"/)
})

test('the rarer knobs sit inside one <details> that counts the ones set; the common ones stay outside', async () => {
  const c = { ...base, tools: { ...base.tools, bashTimeoutS: 60 }, context: { maxToolOutputChars: 4000 }, toolCalls: { ...base.toolCalls, promptedTemplate: DEFAULT_PROMPTED_TEMPLATE, parseErrorHint: DEFAULT_PARSE_ERROR_HINT }, loop: { maxTurns: 20, maxRepeats: 3, untilBash: 'node --test' } }
  const html = await render(c)
  expect(html).toContain('Advanced · 3 set')
  const [outside, inside] = html.split(/<summary[^>]*>Advanced/)
  for (const t of ['bash timeout, s', 'MCP servers', 'prompted template', 'max tool output chars', 'budget tokens', 'max repeats', 'fresh context', 'repeat temperature', 'repeat think tokens', 'until bash', 'read_file max bytes', 'bash max bytes', 'edit misses', 'refuse to edit'])
    expect(inside).toContain(t)
  for (const t of ['temp</span>', 'num_ctx', 'max_tokens', 'think</span>', 'System prompt', 'Model family', 'ask before running bash', 'max turns', 'enforce schema'])
    expect(outside).toContain(t)
  expect(await render({ ...c, tools: base.tools, loop: { maxTurns: 15 } })).toMatch(/Advanced<\/summary>/)
})

test('a locked repeat knob inside Advanced shows the lock hint there too', async () => {
  const html = await render(base)
  expect(html.split(/<summary[^>]*>Advanced/)[1]).not.toContain('not available for this model')
  const locked = await renderToString(createSSRApp(ConfigForm, { modelValue: base, models: [], modelsError: '', harnessNames: [], modelInfo: { takes: { temperature: false } } }))
  expect(locked.split(/<summary[^>]*>Advanced/)[1]).toContain('not available for this model')
})
