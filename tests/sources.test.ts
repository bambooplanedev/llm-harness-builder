import { test, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { execFileSync } from 'node:child_process'
import { requestSources, lineLabels, type Source } from '../src/core/sources'
import { partLine, leadingSystem } from '../src/core/diff'

const fx = JSON.parse(readFileSync('tests/fixtures/cc-request.json', 'utf8'))
const pairs = (s: Source[]) => s.map(x => [x.kind, x.label])

test('a Claude Code request: every part gets its origin, in order', () => {
  const want = [
    ['harness', 'billing header'], ['harness', 'system prompt'], ['harness', '12 tools'],
    ['file', 'CLAUDE.md'], ['file', 'MEMORY.md'],
    ['harness', 'reminder: userEmail'], ['harness', 'reminder'], ['you', 'you'],
    ['hook', 'hook'], ['skill', 'using-superpowers'],
    ['harness', 'environment'], ['harness', 'MCP instructions'], ['harness', 'skills list'],
  ]
  const got = pairs(requestSources(fx)!)
  expect(got).toEqual(expect.arrayContaining(want))
  // in order: each wanted item is found after the previous one
  let from = 0
  for (const w of want) {
    const i = got.findIndex((g, k) => k >= from && g[0] === w[0] && g[1] === w[1])
    expect(i, String(w)).toBeGreaterThanOrEqual(0)
    from = i + 1
  }
  // the second system[] block is the SDK line, also the harness's prompt
  expect(got.filter(g => g[1] === 'system prompt')).toHaveLength(2)
})

test('chunks of a block join back to the block text, and chars is the length', () => {
  const s = requestSources(fx)!
  for (const c of s) expect(c.chars).toBe(c.text.length)
  const msgs = (fx.messages as Record<string, unknown>[])
  const lead = leadingSystem(msgs)
  const blocks: [string, string][] = fx.system.map((b: unknown, i: number) => [`system[${i}]`, partLine(b)])
  msgs.slice(lead).forEach((m, i) => (m.content as unknown[]).forEach((b, j) => blocks.push([`#${i + 1} block ${j}`, partLine(b)])))
  for (const [where, text] of blocks) expect(s.filter(c => c.where === where).map(c => c.text).join(''), where).toBe(text)
  expect(s.filter(c => c.where === 'tools')).toHaveLength(1)
})

test('"Contents of" inside a file and "# CLAUDE.md" inside a file open nothing', () => {
  const s = requestSources(fx)!
  expect(s.filter(c => c.kind === 'file').map(c => c.label)).toEqual(['CLAUDE.md', 'MEMORY.md'])
  const md = s.find(c => c.label === 'CLAUDE.md')!
  expect(md.text).toContain('see Contents of /home/u/x.md (old): for history.')
  expect(md.text).toContain('\nContents of /home/u/notes.txt\n')
  expect(s.some(c => c.label === 'reminder: CLAUDE.md')).toBe(false)
})

test('a "Contents of … ():" line that is prose, not a path, opens nothing', () => {
  const t = '<system-reminder>\nContents of this file (summary):\nContents of a/b.md):\nContents of /home/u/A.md\n</system-reminder>'
  expect(requestSources({ messages: [{ role: 'user', content: [{ type: 'text', text: t }] }] })!.map(c => c.kind)).toEqual(['harness'])
})

test('a Skill tool result is the skill; another tool result is history with its call name', () => {
  const s = requestSources({
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'superpowers:brainstorming' } }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/home/u/a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Launching skill' }] }, { type: 'tool_result', tool_use_id: 't2', content: 'a\nb' }, { type: 'tool_result', tool_use_id: 'zz', content: 'c' }] },
    ],
  })!
  expect(s.map(c => [c.where, c.kind, c.label])).toEqual([
    ['#1 block 0', 'you', 'you'],
    ['#2 block 0', 'history', 'history'],
    ['#2 block 1', 'history', 'history'],
    ['#2 block 2', 'history', 'history'],
    ['#3 block 0', 'skill', 'brainstorming'],
    ['#3 block 1', 'history', 'result of Read'],
    ['#3 block 2', 'history', 'history'],
  ])
})

test('an OpenAI body without markers', () => {
  const s = requestSources({
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'a.txt' },
      { role: 'system', content: 'Late note.' },
    ],
  })!
  expect(s.map(c => [c.where, c.kind, c.label])).toEqual([
    ['system[0]', 'harness', 'system prompt'],
    ['#1 block 0', 'you', 'you'],
    ['#2 block 0', 'history', 'history'],
    ['#3 block 0', 'history', 'result of bash'],
    ['#4 block 0', 'harness', 'system prompt'],
  ])
  expect(s[2].text).toBe('call bash {"command":"ls"}')
})

test('malformed input does not throw, and an unreadable body is undefined', () => {
  expect(requestSources({})).toBeUndefined()
  expect(requestSources({ messages: 'x' })).toBeUndefined()
  expect(requestSources(null)).toBeUndefined()
  expect(() => requestSources({ system: [null, { type: 'text', text: 5 }], tools: 'x', messages: [null, { role: 'user', content: [null, { type: 'text', text: 7 }, { type: 'text', text: {} }] }] })).not.toThrow()
  const big = 'Contents of '.repeat(100_000)
  const s = requestSources({ messages: [{ role: 'user', content: [{ type: 'text', text: `<system-reminder>\n${big}\n</system-reminder>` }, { type: 'text', text: big }] }] })!
  expect(s.map(c => c.text).join('')).toBe(`<system-reminder>\n${big}\n</system-reminder>${big}`)
})

test('lineLabels: a line maps to its one source; a line two sources share maps to nothing', () => {
  const m = lineLabels(requestSources(fx)!)
  expect(m.get('Keep diffs small.')).toBe('CLAUDE.md')
  expect(m.get('Check for a skill before acting.')).toBe('using-superpowers')
  expect(m.get('- [Stand](stand.md) — window 2 is mine')).toBe('MEMORY.md')
  expect(m.get('Say hello in one word')).toBe('you')
  expect(m.has('---')).toBe(false)
  expect(m.has('')).toBe(false)
})

test('fixtures carry no home paths, emails or account names', () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
  let gitName = ''
  try { gitName = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim() } catch { /* no git identity */ }
  const names = [userInfo().username, gitName].filter(n => n.length > 2)
  for (const f of walk('tests/fixtures')) {
    const t = readFileSync(f, 'utf8')
    expect(t, f).not.toMatch(/\/Users\/|[\w.+-]+@[\w-]+\.[\w.]+/)
    for (const n of names) expect(t.includes(n), `${f} contains an account name`).toBe(false)
  }
})
