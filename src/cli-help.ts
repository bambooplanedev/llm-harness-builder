// src/cli-help.ts — each command's options, usage line and help text, in one place. cli.ts parses
// with these options, so --help can never describe a flag the parser does not take, or miss one.
import type { ParseArgsConfig } from 'node:util'

type Options = NonNullable<ParseArgsConfig['options']>
/** One entry per option except --help: the value placeholder ('' for a flag) and what it does. */
type Docs<O extends Options> = { readonly [K in Exclude<keyof O, 'help'>]: readonly [value: string, text: string] }
type Command<O extends Options> = { summary: string; args: string; options: O; docs: Docs<O> }
const command = <O extends Options>(c: Command<O>): Command<O> => c

const help = { type: 'boolean', short: 'h' } as const
const backend = { model: { type: 'string' }, 'base-url': { type: 'string' }, kind: { type: 'string' }, 'api-key-env': { type: 'string' } } as const
const backendDocs = {
  model: ['<m>', 'model name, overriding the harness file'],
  'base-url': ['<u>', 'server URL, overriding the harness file'],
  kind: ['<k>', 'openai, ollama or anthropic, overriding the harness file'],
  'api-key-env': ['<NAME>', 'environment variable that holds the API key, overriding the harness file'],
} as const

export const COMMANDS = {
  serve: command({
    summary: 'Open the UI: edit harnesses, run them, read traces and bench results.',
    args: '',
    options: { port: { type: 'string', default: '7331' }, 'no-open': { type: 'boolean', default: false }, help },
    docs: { port: ['<n>', 'port to listen on, 0 for any free one (default 7331)'], 'no-open': ['', 'do not open a browser'] },
  }),
  run: command({
    summary: 'Run one harness on one task in a workdir; exit 0 only on a final answer.',
    args: '<harness.json> "task"',
    options: { workdir: { type: 'string' }, yes: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, 'answer-schema': { type: 'string' }, ...backend, help },
    docs: {
      workdir: ['<dir>', 'directory the agent works in (default: the current one)'],
      yes: ['', 'approve every command without asking'],
      json: ['', 'print the event stream as JSONL on stdout'],
      'answer-schema': ['<file.json>', 'JSON schema the final answer is held to'],
      ...backendDocs,
    },
  }),
  demo: command({
    summary: 'Run bare, tuned-nothink and tuned-hermes on the demo task and print PASS or FAIL for each (tuned instead of tuned-nothink with --kind openai and --api-key-env: a hosted API refuses thinking off).',
    args: '',
    options: { json: { type: 'boolean', default: false }, ...backend, help },
    docs: { json: ['', 'print the event stream as JSONL on stdout'], ...backendDocs },
  }),
  bench: command({
    summary: 'Run harnesses n times each on a task; print PASS rates and write a JSON.',
    args: '[harness.json ...]',
    options: {
      n: { type: 'string', default: '3' }, timeout: { type: 'string', default: '1800' }, out: { type: 'string' },
      task: { type: 'string' }, size: { type: 'string' }, tasks: { type: 'string' }, yes: { type: 'boolean', default: false }, 'max-turns': { type: 'string' }, ...backend, help,
    },
    docs: {
      n: ['<n>', 'runs per harness (default 3)'],
      timeout: ['<s>', 'seconds per run (default 1800)'],
      out: ['<file>', 'where the JSON goes (default runs/bench-<ts>.json)'],
      task: ['<name>', 'slug|pool|pool2|pool3|sift|triage|judge (default slug)'],
      size: ['<N>', 'task size, for a task that has sizes'],
      tasks: ['<repo>', 'run your own tasks from <repo>/lhb-tasks.json (the last commit) instead of --task'],
      yes: ['', 'accept the commands of --tasks without asking (needed without a terminal)'],
      'max-turns': ['<N>', 'turn limit, overriding the harness files'],
      ...backendDocs,
    },
  }),
  replay: command({
    summary: 'Send one recorded turn again n times and count the distinct replies.',
    args: '<run-id | trace.jsonl>',
    options: {
      turn: { type: 'string' }, n: { type: 'string', default: '5' }, temperature: { type: 'string' }, 'max-tokens': { type: 'string' },
      'base-url': { type: 'string' }, kind: { type: 'string' }, 'api-key-env': { type: 'string' }, json: { type: 'boolean', default: false }, help,
    },
    docs: {
      turn: ['<N>', 'the turn to send again (required)'],
      n: ['<n>', 'how many times (default 5)'],
      temperature: ['<t>', 'temperature from 0 to 2 (default: as recorded)'],
      'max-tokens': ['<m>', 'cap on each reply'],
      'base-url': ['<u>', 'server URL (required)'],
      kind: ['<k>', 'openai or ollama (required)'],
      'api-key-env': ['<NAME>', 'environment variable that holds the API key of a hosted API'],
      json: ['', 'print the result as JSON'],
    },
  }),
  analyze: command({
    summary: 'Read traces: what each budget stub removed, the first edit, the file a run looped on.',
    args: '<bench.json | run-id | trace.jsonl> ...',
    options: { json: { type: 'boolean', default: false }, help },
    docs: { json: ['', 'print the rows as JSON'] },
  }),
  proxy: command({
    summary: 'Record what another agent sends a server, live, into ./runs.',
    args: '',
    options: { upstream: { type: 'string', default: 'http://127.0.0.1:8080' }, port: { type: 'string', default: '8090' }, name: { type: 'string', default: 'proxy' }, help },
    docs: {
      upstream: ['<url>', 'server root to forward to (default http://127.0.0.1:8080)'],
      port: ['<n>', 'port to listen on (default 8090)'],
      name: ['<label>', 'harness name of the recorded runs (default proxy)'],
    },
  }),
}

export type CommandName = keyof typeof COMMANDS
export const isCommand = (s: string): s is CommandName => Object.hasOwn(COMMANDS, s)

const docsOf = (name: CommandName) => Object.entries(COMMANDS[name].docs as Record<string, readonly [string, string]>)
const flag = (name: string, value: string) => `--${name}${value ? ` ${value}` : ''}`

/** One line: `usage: llm-harness-builder run <harness.json> "task" [--workdir <dir>] ...` */
export function usage(name: CommandName): string {
  return ['usage: llm-harness-builder', name, COMMANDS[name].args, ...docsOf(name).map(([k, [v]]) => `[${flag(k, v)}]`)].filter(Boolean).join(' ')
}

/** The usage line, the summary, and one line per option. */
export function commandHelp(name: CommandName): string {
  const rows: [string, string][] = [...docsOf(name).map(([k, [v, text]]): [string, string] => [flag(k, v), text]), ['-h, --help', 'show this help']]
  const w = Math.max(...rows.map(([f]) => f.length))
  return [usage(name), '', COMMANDS[name].summary, '', 'options:', ...rows.map(([f, t]) => `  ${f.padEnd(w)}  ${t}`)].join('\n')
}

/** What `--help` prints: the package's description, the commands, and where to read more. */
export function overview(description: string): string {
  const names = Object.keys(COMMANDS) as CommandName[]
  const w = Math.max(...names.map(n => n.length))
  return [
    description,
    '',
    'usage: llm-harness-builder <command> [options]   (no arguments: serve)',
    '',
    'commands:',
    ...names.map(n => `  ${n.padEnd(w)}  ${COMMANDS[n].summary}`),
    '',
    'llm-harness-builder <command> --help   the options of one command',
    'llm-harness-builder --version          the installed version',
  ].join('\n')
}
