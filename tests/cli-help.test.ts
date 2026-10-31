import { test, expect } from 'vitest'
import { COMMANDS, isCommand, usage, commandHelp, overview, overOf, type CommandName } from '../src/cli-help.js'
import { TASKS } from '../src/core/tasks.js'

const names = Object.keys(COMMANDS) as CommandName[]
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('eight commands, and nothing from Object.prototype counts as one', () => {
  expect(names).toEqual(['serve', 'run', 'demo', 'bench', 'evolve', 'replay', 'analyze', 'proxy'])
  for (const n of ['toString', 'constructor', '__proto__', 'help', '']) expect(isCommand(n)).toBe(false)
})

test('every option but --help has a help line, and the usage line lists each of them', () => {
  for (const n of names) {
    const opts = Object.keys(COMMANDS[n].options).filter(k => k !== 'help')
    expect([n, Object.keys(COMMANDS[n].docs).sort()]).toEqual([n, [...opts].sort()])
    const help = commandHelp(n).split('\n')
    expect(help[0]).toBe(usage(n))
    for (const o of opts) {
      expect(usage(n)).toContain(`[--${o}`)
      const line = help.find(l => l === `  --${o}` || l.startsWith(`  --${o} `))
      expect([n, o, line]).toEqual([n, o, expect.stringMatching(/\S {2,}\S/)])
    }
    expect(help.some(l => /^ {2}-h, --help {2,}show this help$/.test(l))).toBe(true)
  }
})

test('bench --task names exactly the tasks there are', () => {
  expect(COMMANDS.bench.docs.task[1]).toContain(Object.keys(TASKS).join('|'))
})

test('overview: the description first, then each command with its summary', () => {
  const o = overview('See what your harness sends')
  expect(o.split('\n')[0]).toBe('See what your harness sends')
  for (const n of names) expect(o).toMatch(new RegExp(`^  ${n}\\s+${esc(COMMANDS[n].summary)}$`, 'm'))
  // serve is what no arguments at all do; `--port 0` alone is an unknown command, so "no command" would overpromise
  expect(o).toContain('[options]   (no arguments: serve)')
})

test('--kind names anthropic in every command that takes it', () => {
  for (const n of ['run', 'demo', 'bench'] as const) expect(commandHelp(n)).toMatch(/--kind[^\n]*anthropic/)
})

test('README usage lines match --help: every command has its line, word for word', async () => {
  const { readFileSync } = await import('node:fs')
  for (const f of ['README.md', 'README.uk.md']) {
    const all = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n')
    const from = all.findIndex(l => l.includes('--help | --version')) // the CLI block: the indented lines from here on
    expect(from, f).toBeGreaterThan(-1)
    const lines: string[] = []
    for (let i = from; all[i]?.startsWith('    llm-harness-builder '); i++) lines.push(all[i].trim())
    const seen = new Set<string>()
    for (const line of lines) {
      const cmd = line.split(' ')[1]
      if (!isCommand(cmd)) continue // the `--help | --version | help <command>` line
      expect([f, 'usage: ' + line]).toEqual([f, usage(cmd)])
      seen.add(cmd)
    }
    expect([f, [...seen].sort()]).toEqual([f, [...names].sort()])
  }
})

// evolve's pin hashes this JSON: another key order or spelling and every saved journal refuses to resume.
test('overOf: the exact JSON evolve pins, whatever order the flags came in; a flag not given drops out', () => {
  expect(JSON.stringify(overOf({ 'api-key-env': 'K_API_KEY', kind: 'openai', 'base-url': 'http://h/v1', model: 'm' })))
    .toBe('{"model":"m","baseUrl":"http://h/v1","kind":"openai","apiKeyEnv":"K_API_KEY"}')
  expect(JSON.stringify(overOf({ kind: 'ollama' }))).toBe('{"kind":"ollama"}')
  expect(JSON.stringify(overOf({}))).toBe('{}')
})
