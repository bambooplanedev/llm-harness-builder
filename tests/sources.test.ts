import { test, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { execFileSync } from 'node:child_process'
import { requestSources, lineLabels, groupDiff, runSummary, type Source } from '../src/core/sources'
import type { HarnessEvent } from '../src/core/events'
import { partLine, leadingSystem } from '../src/core/diff'

const fx = JSON.parse(readFileSync('tests/fixtures/cc-request.json', 'utf8'))
const pairs = (s: Source[]) => s.map(x => [x.kind, x.label])

test('a Claude Code request: every part gets its origin, in order', () => {
  const want = [
    ['harness', 'billing header'], ['harness', 'system prompt'], ['harness', '12 tools'],
    ['file', '.claude/CLAUDE.md'], ['file', 'MEMORY.md'],
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
  expect(s.filter(c => c.kind === 'file').map(c => c.label)).toEqual(['.claude/CLAUDE.md', 'MEMORY.md'])
  const md = s.find(c => c.label === '.claude/CLAUDE.md')!
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

test('a file in a dot folder keeps the folder in its label, so the global and project CLAUDE.md differ', () => {
  const t = '<system-reminder>\nContents of /home/u/.claude/CLAUDE.md (global):\n\nA\nContents of /home/u/proj/CLAUDE.md (project):\n\nB\nContents of ~/.config/x/notes.md (n):\n\nC\n</system-reminder>'
  const s = requestSources({ messages: [{ role: 'user', content: [{ type: 'text', text: t }] }] })!
  expect(s.filter(c => c.kind === 'file').map(c => c.label)).toEqual(['.claude/CLAUDE.md', 'CLAUDE.md', 'notes.md'])
})

test('a successful Skill call: the skill text Claude Code puts next to the result is the skill', () => {
  const s = requestSources({
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'superpowers:brainstorming' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Launching skill: superpowers:brainstorming' }, { type: 'text', text: 'Base directory for this skill: /home/u/s\n\nAsk one question at a time.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /home/u/t\n\nnot after a Skill call' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'keys' } }] },
      // a built-in skill has no base directory; a reminder before its text stays the harness's, and only one block is the skill
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Launching skill: keys' }, { type: 'text', text: '<system-reminder>\nnote\n</system-reminder>' }, { type: 'text', text: '# Keys\n\nbind' }, { type: 'text', text: 'more' }] },
    ],
  })!
  expect(s.map(c => [c.where, c.kind, c.label])).toEqual([
    ['#1 block 0', 'you', 'you'],
    ['#2 block 0', 'history', 'history'],
    ['#3 block 0', 'skill', 'brainstorming'],
    ['#3 block 1', 'skill', 'brainstorming'],
    ['#4 block 0', 'you', 'you'],
    ['#5 block 0', 'history', 'history'],
    ['#6 block 0', 'skill', 'keys'],
    ['#6 block 1', 'harness', 'reminder'],
    ['#6 block 2', 'skill', 'keys'],
    ['#6 block 3', 'history', 'history'],
  ])
  expect(lineLabels(s).get('Ask one question at a time.')).toBe('brainstorming')
})

test('a failed Skill call is the harness reply, history, not the skill', () => {
  const s = requestSources({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'nope' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Unknown skill: nope' }] },
    ],
  })!
  expect(s.map(c => [c.kind, c.label])).toEqual([['history', 'history'], ['history', 'result of Skill']])
})

test('a system message that starts with # Environment is split like the attachments after the hook', () => {
  const t = '# Environment\nYou run on linux.\n# MCP Server Instructions\nUse x.\nThe following skills are available:\n- a: one\n- b: two\nToday is Monday.'
  const s = requestSources({ messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: t }] })!
  expect(s.map(c => [c.kind, c.label])).toEqual([['you', 'you'], ['harness', 'environment'], ['harness', 'MCP instructions'], ['harness', 'skills list'], ['harness', 'reminder']])
  expect(s.slice(1).map(c => c.text).join('')).toBe(t)
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
  expect(m.get('Keep diffs small.')).toBe('.claude/CLAUDE.md')
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

// ---- groupDiff / runSummary ----
const md = (body: string) => `<system-reminder>\nContents of /home/u/proj/CLAUDE.md (project):\n\n${body}\n</system-reminder>`
const body = (run: string, temperature: number, tools: string[], messages: unknown[]) => ({
  model: 'm', temperature, metadata: { user_id: run },
  system: [{ type: 'text', text: `x-anthropic-billing-header: cc_version=${run}` }, { type: 'text', text: 'You are a coding agent.' }],
  tools: tools.map(name => ({ name, input_schema: {} })),
  messages,
})
const first = (run: string, rules: string, temperature = 0.2, tools = ['Read']) => body(run, temperature, tools, [{ role: 'user', content: [{ type: 'text', text: md(rules) }, { type: 'text', text: 'fix it' }] }])
/** A run whose third request carries a Skill result: the skill's text shows up only there. */
const withSkill = (run: string, rules: string, temperature: number) => {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: md(rules) }, { type: 'text', text: 'fix it' }] }]
  const call = { role: 'assistant', content: [{ type: 'tool_use', id: `s-${run}`, name: 'Skill', input: { skill: 'superpowers:brainstorming' } }] }
  const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: `s-${run}`, content: 'Launching skill: superpowers:brainstorming' }, { type: 'text', text: 'Ask one question at a time.' }] }
  return [
    body(run, temperature, ['Read', 'Write'], msgs),
    body(run, temperature, ['Read', 'Write'], [...msgs, { role: 'assistant', content: 'thinking' }, { role: 'user', content: 'go on' }]),
    body(run, temperature, ['Read', 'Write'], [...msgs, call, result]),
  ]
}

test('groupDiff: only what every run of one group has and no run of the other, with its source', () => {
  const a = [[first('a1', 'Rule A\nflaky line')], [first('a2', 'Rule A')]]
  const b = [withSkill('b1', 'Rule B', 0.7), withSkill('b2', 'Rule B', 0.7)]
  const d = groupDiff(a, b)
  expect(d.onlyA).toEqual([{ line: 'Rule A', label: 'CLAUDE.md' }])
  expect(d.onlyB).toContainEqual({ line: 'Rule B', label: 'CLAUDE.md' })
  expect(d.onlyB).toContainEqual({ line: 'tool Write' })
  // the skill body is only in each B run's third request
  expect(d.onlyB).toContainEqual({ line: 'Ask one question at a time.', label: 'brainstorming' })
  expect(d.onlyB.map(l => l.line).indexOf('Rule B')).toBeLessThan(d.onlyB.map(l => l.line).indexOf('Ask one question at a time.'))
  // differs per run inside each group: not a difference
  expect([...d.onlyA, ...d.onlyB].some(l => l.line.startsWith('x-anthropic-billing-header'))).toBe(false)
  expect(d.params).toEqual([{ path: 'temperature', a: '0.2', b: '0.7' }])
})

test('groupDiff: a param counts only when each group agrees on it; metadata never counts', () => {
  const a = [[first('a1', 'R', 0.2)], [first('a2', 'R', 0.5)]]
  const b = [[first('b1', 'R', 0.7)], [first('b2', 'R', 0.7)]]
  expect(groupDiff(a, b).params).toEqual([])
})

test('groupDiff: a request already seen is not read again when a new one arrives', () => {
  let reads = 0
  const counted = (p: Record<string, unknown>) => { const { messages, ...rest } = p; return Object.defineProperty(rest, 'messages', { get: () => (reads++, messages), enumerable: true }) }
  const a = [[counted(first('a1', 'Rule A'))]], b = [[counted(first('b1', 'Rule B'))]]
  groupDiff(a, b)
  const once = reads
  expect(once).toBeGreaterThan(0)
  a[0].push(first('a1', 'Rule A\nMore'))
  expect(groupDiff(a, b).onlyA).toContainEqual({ line: 'Rule A', label: 'CLAUDE.md' })
  expect(reads).toBe(once)
})

test('groupDiff: runs without readable requests give empty lists', () => {
  expect(groupDiff([[]], [[]])).toEqual({ onlyA: [], onlyB: [], params: [] })
  expect(groupDiff([[{}, null]], [[first('b1', 'R')]]).onlyA).toEqual([])
})

const ev = (turn: number, e: Record<string, unknown>) => ({ seq: 0, ts: 0, turn, ...e }) as HarnessEvent

test('runSummary: the path of calls, the last answer, the recorded reasoning', () => {
  const v = runSummary([
    ev(1, { type: 'llm_request', payload: {} }),
    ev(1, { type: 'llm_response', raw: {}, content: 'reading', latencyMs: 1 }),
    ev(1, { type: 'tool_call', call: { callId: 'c1', name: 'Read', args: { file_path: '/w/a.ts' } } }),
    ev(2, { type: 'llm_request', payload: {} }),
    ev(2, { type: 'llm_response', raw: {}, content: 'done', reasoning: 'r2', latencyMs: 1 }),
    ev(2, { type: 'tool_call', call: { callId: 'c2', name: 'Bash', args: { command: 'ls' } } }),
  ])
  expect(v.chips.map(c => [c.label, c.detail])).toEqual([['Read', '/w/a.ts'], ['Bash', 'ls']])
  expect(v).toMatchObject({ result: 'done', reasoning: 'r2', empty: false })
})

test('runSummary: nothing recorded is empty', () => {
  expect(runSummary([])).toEqual({ chips: [], result: '', reasoning: '', empty: true })
  expect(runSummary([ev(1, { type: 'llm_request', payload: {} })]).empty).toBe(true)
})
