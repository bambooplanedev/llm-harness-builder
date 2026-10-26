import { test, expect } from 'vitest'
import { COMMANDS, isCommand, usage, commandHelp, overview, type CommandName } from '../src/cli-help.js'
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
