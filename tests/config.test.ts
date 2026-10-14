import { test, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateConfig, sendsAnswerSchema, ENV_NAME, keyErrors, keyProblem, apiKey, keyNote, FLAG_WORDS, backendErrors, isLoopbackUrl } from '../src/core/config.js'
import { harness } from './helpers.js'

const validConfig = harness()

test('valid config has no errors', () => {
  expect(validateConfig(validConfig)).toEqual([])
})

test('reports missing model, bad tool, bad mode', () => {
  const bad = structuredClone(validConfig) as any
  bad.backend.model = ''
  bad.tools.enabled.push('grep')
  bad.toolCalls.mode = 'magic'
  const errs = validateConfig(bad)
  expect(errs.some(e => e.includes('model'))).toBe(true)
  expect(errs.some(e => e.includes('grep'))).toBe(true)
  expect(errs.some(e => e.includes('mode'))).toBe(true)
})

test('non-object is an error', () => {
  expect(validateConfig(null).length).toBe(1)
})

test('prompted mode requires {{tools}} in promptedTemplate; native mode does not', () => {
  const prompted = structuredClone(validConfig) as any
  prompted.toolCalls.mode = 'prompted'
  prompted.toolCalls.promptedTemplate = ''
  expect(validateConfig(prompted).some(e => e.includes('{{tools}}'))).toBe(true)

  const native = structuredClone(validConfig) as any
  native.toolCalls.mode = 'native'
  native.toolCalls.promptedTemplate = ''
  expect(validateConfig(native)).toEqual([])
})

test('format is optional; hermes + enforceSchema is valid; unknown format is an error', () => {
  const noFormat = structuredClone(validConfig) as any
  expect(validateConfig(noFormat)).toEqual([])

  const hermes = structuredClone(validConfig) as any
  hermes.toolCalls.mode = 'prompted'
  hermes.toolCalls.format = 'hermes'
  hermes.toolCalls.enforceSchema = true
  expect(validateConfig(hermes)).toEqual([])

  const bad = structuredClone(validConfig) as any
  bad.toolCalls.format = 'xml'
  expect(validateConfig(bad).some(e => e.includes('format'))).toBe(true)
})

test('mcpServers is optional and validated per server', () => {
  const ok = structuredClone(validConfig) as any
  ok.mcpServers = { fs: { command: 'npx', args: ['-y', 'x', '.'], tools: ['read_file'] } }
  expect(validateConfig(ok)).toEqual([])

  const noServers = structuredClone(validConfig) as any
  noServers.mcpServers = undefined
  expect(validateConfig(noServers)).toEqual([])

  const bad = structuredClone(validConfig) as any
  bad.mcpServers = { fs: { command: '', args: 'nope', tools: [1] }, '': { command: 'x' } }
  const errs = validateConfig(bad)
  expect(errs).toContain('mcpServers.fs.command must be a non-empty string')
  expect(errs).toContain('mcpServers.fs.args must be an array of strings')
  expect(errs).toContain('mcpServers.fs.tools must be an array of strings')
  expect(errs).toContain('mcpServers key must be a non-empty string')

  const notObj = structuredClone(validConfig) as any
  notObj.mcpServers = []
  expect(validateConfig(notObj)).toContain('mcpServers must be an object')

  // Test non-object server values
  const serverString = structuredClone(validConfig) as any
  serverString.mcpServers = { fs: 'nope' }
  expect(validateConfig(serverString)).toContain('mcpServers.fs must be an object')

  const serverNumber = structuredClone(validConfig) as any
  serverNumber.mcpServers = { fs: 42 }
  expect(validateConfig(serverNumber)).toContain('mcpServers.fs must be an object')

  const serverArray = structuredClone(validConfig) as any
  serverArray.mcpServers = { fs: [] }
  expect(validateConfig(serverArray)).toContain('mcpServers.fs must be an object')
})

test('requireReadBeforeEdit and explainEditMiss are optional and must be booleans', () => {
  expect(validateConfig(validConfig)).toEqual([])
  for (const key of ['requireReadBeforeEdit', 'explainEditMiss']) {
    const on = structuredClone(validConfig) as any
    on.tools[key] = true
    expect(validateConfig(on)).toEqual([])
    const bad = structuredClone(validConfig) as any
    bad.tools[key] = 'yes'
    expect(validateConfig(bad).some(e => e.includes(key))).toBe(true)
  }
})

test('loop.maxRepeats is optional and must be a non-negative integer', () => {
  for (const ok of [0, 3]) {
    const c = structuredClone(validConfig) as any
    c.loop.maxRepeats = ok
    expect(validateConfig(c)).toEqual([])
  }
  for (const bad of [-1, 1.5, '3', true]) {
    const c = structuredClone(validConfig) as any
    c.loop.maxRepeats = bad
    expect(validateConfig(c).some(e => e.includes('maxRepeats'))).toBe(true)
  }
})

test('backend.think is optional and must be a boolean', () => {
  for (const good of [false, true]) {
    const c = structuredClone(validConfig) as any
    c.backend.think = good
    expect(validateConfig(c)).toEqual([])
  }
  for (const bad of [0, 'false', null]) {
    const c = structuredClone(validConfig) as any
    c.backend.think = bad
    expect(validateConfig(c).some(e => e.includes('backend.think'))).toBe(true)
  }
})

test('backend.maxTokens is optional and must be a positive integer', () => {
  const ok = structuredClone(validConfig) as any
  ok.backend.maxTokens = 1024
  expect(validateConfig(ok)).toEqual([])
  for (const bad of [0, -1, 1.5, '1024']) {
    const c = structuredClone(validConfig) as any
    c.backend.maxTokens = bad
    expect(validateConfig(c).some(e => e.includes('maxTokens'))).toBe(true)
  }
})

test('every section rejects a key it does not know: a misspelt knob would otherwise be silently off', () => {
  const withKey = (put: (c: any) => void) => { const c = structuredClone(validConfig) as any; put(c); return validateConfig(c) }
  expect(withKey(c => { c.loop.freshcontext = 2 })).toEqual(['loop.freshcontext is not a known key'])
  expect(withKey(c => { c.tools.requireReadBeforEdit = true })).toEqual(['tools.requireReadBeforEdit is not a known key'])
  expect(withKey(c => { c.backend.maxToken = 512 })).toEqual(['backend.maxToken is not a known key'])
  expect(withKey(c => { c.context.budgetToken = 3000 })).toEqual(['context.budgetToken is not a known key'])
  expect(withKey(c => { c.toolCalls.formt = 'hermes' })).toEqual(['toolCalls.formt is not a known key'])
  expect(withKey(c => { c.mcpServer = {} })).toEqual(['mcpServer is not a known key'])
  expect(withKey(c => { c.mcpServers = { fs: { command: 'npx', tool: ['read_file'] } } })).toEqual(['mcpServers.fs.tool is not a known key'])
})

test('a known key set to undefined is not an unknown key: the UI sends numCtx that way', () => {
  const c = structuredClone(validConfig) as any
  c.backend.numCtx = undefined
  expect(validateConfig(c)).toEqual([])
})

test('loop.repeatTemperature is a number in [0, 2] and needs loop.maxRepeats', () => {
  for (const ok of [0, 0.7, 2]) {
    const c = structuredClone(validConfig) as any
    c.loop.maxRepeats = 3; c.loop.repeatTemperature = ok
    expect(validateConfig(c)).toEqual([])
  }
  for (const bad of [-0.1, 2.1, NaN, '1', true]) {
    const c = structuredClone(validConfig) as any
    c.loop.maxRepeats = 3; c.loop.repeatTemperature = bad
    expect(validateConfig(c).some(e => e.includes('repeatTemperature'))).toBe(true)
  }
  const alone = structuredClone(validConfig) as any
  alone.loop.repeatTemperature = 1
  expect(validateConfig(alone).some(e => e.includes('repeatTemperature') && e.includes('maxRepeats'))).toBe(true)
})

test('loop.freshContext is an integer from 1 to maxRepeats and needs loop.maxRepeats', () => {
  for (const ok of [1, 3]) {
    const c = structuredClone(validConfig) as any
    c.loop.maxRepeats = 3; c.loop.freshContext = ok
    expect(validateConfig(c)).toEqual([])
  }
  // above maxRepeats the run has ended before the reset could fire; with maxRepeats 0 nothing fits
  for (const [bad, max] of [[0, 3], [4, 3], [1.5, 3], ['2', 3], [1, 0]] as const) {
    const c = structuredClone(validConfig) as any
    c.loop.maxRepeats = max; c.loop.freshContext = bad
    expect(validateConfig(c).some(e => e.includes('freshContext'))).toBe(true)
  }
  const alone = structuredClone(validConfig) as any
  alone.loop.freshContext = 1
  expect(validateConfig(alone).some(e => e.includes('freshContext') && e.includes('maxRepeats'))).toBe(true)
})

test('loop.untilBash is a non-blank string: sh -c "  " exits 0 and would pass on the first claim', () => {
  const ok = structuredClone(validConfig) as any
  ok.loop.untilBash = 'node --test'
  expect(validateConfig(ok)).toEqual([])
  for (const bad of ['', '   ', 1, true]) {
    const c = structuredClone(validConfig) as any
    c.loop.untilBash = bad
    expect(validateConfig(c).some(e => e.includes('untilBash'))).toBe(true)
  }
})

test('loop.repeatThinkTokens is a positive integer, needs loop.maxRepeats and a /no_think line to flip', () => {
  const make = (v: unknown, sys = 'sys\n/no_think', detector = true) => { const c = structuredClone(validConfig) as any; c.systemPrompt = sys; c.loop = { maxTurns: 5, ...(detector ? { maxRepeats: 3 } : {}), repeatThinkTokens: v }; return validateConfig(c) }
  expect(make(2048)).toEqual([])
  for (const bad of [0, -1, 1.5, '2048', null]) expect(make(bad).some(e => e.includes('repeatThinkTokens'))).toBe(true)
  expect(make(2048, 'sys\n/no_think', false)).toEqual(['loop.repeatThinkTokens needs loop.maxRepeats: a repeat is what that detector counts'])
  // without the line there is nothing to flip, and the knob would be silently off
  expect(make(2048, 'sys')).toEqual(['loop.repeatThinkTokens needs a line "/no_think" in systemPrompt: that line is what it turns into "/think"'])
  expect(make(2048, 'never write /no_think in prose')).toHaveLength(1)
})

test('sendsAnswerSchema: native, enforceSchema on, and no tool of any kind', () => {
  const judge = harness({ tools: { enabled: [], approveBash: true }, toolCalls: { mode: 'native', enforceSchema: true, promptedTemplate: '{{tools}}', parseErrorHint: 'h' } })
  expect(sendsAnswerSchema(judge)).toBe(true)
  expect(sendsAnswerSchema({ ...judge, tools: { enabled: ['bash'], approveBash: true } })).toBe(false)
  expect(sendsAnswerSchema({ ...judge, mcpServers: { fs: { command: 'npx' } } })).toBe(false)
  expect(sendsAnswerSchema({ ...judge, toolCalls: { ...judge.toolCalls, enforceSchema: false } })).toBe(false)
  expect(sendsAnswerSchema({ ...judge, toolCalls: { ...judge.toolCalls, mode: 'prompted' } })).toBe(false)
})

test('tools.editMissEscalation is optional and must be a positive integer', () => {
  const on = structuredClone(validConfig) as any
  on.tools.editMissEscalation = 3
  expect(validateConfig(on)).toEqual([])
  for (const bad of [0, -1, 2.5, '3']) {
    const c = structuredClone(validConfig) as any
    c.tools.editMissEscalation = bad
    expect(validateConfig(c)).toContain('tools.editMissEscalation must be a positive integer')
  }
})

test('tools.bashEnv is optional: environment variable names, never values', () => {
  const on = structuredClone(validConfig) as any
  on.tools.bashEnv = ['GITHUB_TOKEN', 'http_proxy', '_X1']
  expect(validateConfig(on)).toEqual([])
  for (const bad of ['GITHUB_TOKEN', [1], ['A-B'], ['1A'], [''], ['A=1'], { GITHUB_TOKEN: 'x' }]) {
    const c = structuredClone(validConfig) as any
    c.tools.bashEnv = bad
    expect(validateConfig(c)).toContain('tools.bashEnv must be an array of environment variable names')
  }
})

test('ENV_NAME: shell variable names only', () => {
  for (const ok of ['A', '_x', 'http_proxy', 'GITHUB_TOKEN', 'X1']) expect(ENV_NAME.test(ok)).toBe(true)
  for (const bad of ['', '1A', 'A-B', 'A B', 'A=1', '$A']) expect(ENV_NAME.test(bad)).toBe(false)
})

const NAME_CONTROL = 'name must not contain control or format characters'
const KEY_CONTROL = 'mcpServers keys must not contain control or format characters'

test('name and every mcpServers key must be free of control and format characters: they are printed to a terminal', () => {
  // a conceal attribute and an 8-bit CSI first, then one of each other kind
  for (const bad of ['a\u001b[8mb', 'a\u009bb', 'a\u007fb', 'a\nb', 'a\rb', 'a\tb', 'a\u202eb', 'a\u200bb', 'a\u2028b', 'a\u2029b', '\ufeff', '\u{e0041}']) {
    const named = structuredClone(validConfig) as any
    named.name = bad
    expect([bad, validateConfig(named)]).toEqual([bad, [NAME_CONTROL]])
    const keyed = structuredClone(validConfig) as any
    keyed.mcpServers = { fs: { command: 'npx' }, [bad]: { command: 'npx' } }
    expect([bad, validateConfig(keyed)]).toEqual([bad, [KEY_CONTROL]])
  }
})

test('the control-character errors do not echo the raw value, and a bad key gets no other message that would', () => {
  const c = structuredClone(validConfig) as any
  c.name = 'x\u001b[8m'
  // the key is wrong in every other way too; its other messages would print it as it is
  c.mcpServers = { 'a\u009b': { command: '', args: 'nope', tools: [1], extra: true }, 'b\u001b[2K': 'nope', ok: { command: '' } }
  const errs = validateConfig(c)
  expect(errs).toEqual([NAME_CONTROL, KEY_CONTROL, 'mcpServers.ok.command must be a non-empty string'])
  expect(errs.join('\n')).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
})

test('plain names and keys pass, letters of any script included', () => {
  for (const name of ['h', 'tuned-hermes', 'my harness 2', 'caf\u00e9', '\u043f\u0440\u0438\u0432\u0456\u0442', 'a\u65e5\u672c\u8a9eb', '\u{1f44d}']) {
    const c = structuredClone(validConfig) as any
    c.name = name
    c.mcpServers = { [name]: { command: 'npx' }, fs: { command: 'npx' } }
    expect([name, validateConfig(c)]).toEqual([name, []])
  }
})

test('every shipped harness still validates', () => {
  const dir = fileURLToPath(new URL('../harnesses/', import.meta.url))
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  expect(files.length).toBeGreaterThan(10)
  for (const f of files) expect([f, validateConfig(JSON.parse(readFileSync(join(dir, f), 'utf8')))]).toEqual([f, []])
})

const keyed = (b: Record<string, unknown>) =>
  validateConfig({ ...validConfig, backend: { ...validConfig.backend, apiKeyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', ...b } })

test('backend.apiKeyEnv: https anywhere, plain http only to this machine, judged on the parsed hostname', () => {
  for (const baseUrl of ['https://openrouter.ai/api/v1', 'http://localhost:8080/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1', 'http://127.1:8080/v1'])
    expect([baseUrl, keyed({ baseUrl })]).toEqual([baseUrl, []])
  const clear = 'backend.apiKeyEnv needs an https baseUrl (http only on localhost, 127.0.0.1 or [::1]): the key would cross the network in clear text'
  for (const baseUrl of ['http://192.168.1.5/v1', 'http://localhost.evil.com/v1', 'http://localhost@evil.com/v1', 'http://127.0.0.1.nip.io/v1', 'http://[::1]:80@evil.com/v1', 'http://localhost./v1'])
    expect([baseUrl, keyed({ baseUrl })]).toEqual([baseUrl, [clear]])
  // What URL cannot parse is the URL's own error, for every harness, with a key or without one.
  for (const baseUrl of ['https://', 'http://[::1']) {
    expect([baseUrl, keyed({ baseUrl })]).toEqual([baseUrl, ['backend.baseUrl must be an http(s) URL']])
    expect([baseUrl, validateConfig({ ...validConfig, backend: { ...validConfig.backend, baseUrl } })]).toEqual([baseUrl, ['backend.baseUrl must be an http(s) URL']])
  }
})

test('backend.apiKeyEnv names an upper-case *_API_KEY variable: nothing else, and never a pasted key', () => {
  const msg = 'backend.apiKeyEnv must be an upper-case variable name ending in _API_KEY (like OPENROUTER_API_KEY)'
  for (const apiKeyEnv of ['openrouter_api_key', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'toString', '_API_KEY', 'sk-or-v1-0123456789abcdef', 'A B_API_KEY', '', 7])
    expect([apiKeyEnv, keyed({ apiKeyEnv })]).toEqual([apiKeyEnv, [msg]])
  expect(keyed({ apiKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY' })).toEqual([])
})

test('backend.apiKeyEnv goes only with kind openai, and never with think', () => {
  expect(keyed({ kind: 'ollama' })).toEqual(['backend.apiKeyEnv needs kind openai: a key goes only to an OpenAI-compatible API'])
  expect(keyed({ think: false })).toEqual(['backend.think cannot go with backend.apiKeyEnv: a hosted API gets only what the OpenAI API defines'])
})

test('keyErrors with the flags\' words is what replay says; backendErrors checks kind, URL and key without a model', () => {
  expect(keyErrors({ kind: 'ollama', baseUrl: 'http://10.0.0.2/v1', apiKeyEnv: 'X_API_KEY' }, FLAG_WORDS)).toEqual([
    '--api-key-env needs --kind openai: a key goes only to an OpenAI-compatible API',
    '--api-key-env needs an https --base-url (http only on localhost, 127.0.0.1 or [::1]): the key would cross the network in clear text',
  ])
  expect(keyErrors({ kind: 'openai', baseUrl: 'https://x.example/v1' })).toEqual([])
  expect(backendErrors({ kind: 'openai', baseUrl: 'https://x.example/v1', apiKeyEnv: 'X_API_KEY' })).toEqual([])
  expect(backendErrors({ kind: 'nope', baseUrl: 'ftp://x' })).toEqual(['backend.kind must be openai|ollama', 'backend.baseUrl must be an http(s) URL'])
})

test('keyProblem names what is wrong with the value and never prints it', () => {
  const b = { apiKeyEnv: 'LHB_TEST_API_KEY' }
  expect(keyProblem(b, {})).toBe('LHB_TEST_API_KEY is not set')
  expect(keyProblem(b, { LHB_TEST_API_KEY: '' })).toBe('LHB_TEST_API_KEY is empty')
  expect(keyProblem(b, { LHB_TEST_API_KEY: '   ' })).toBe('LHB_TEST_API_KEY is empty')
  const bad = 'LHB_TEST_API_KEY holds characters an API key cannot have (spaces, control characters or non-ASCII)'
  expect(keyProblem(b, { LHB_TEST_API_KEY: 'sk-or-v1-AAAA\nBBBB' })).toBe(bad)
  expect(keyProblem(b, { LHB_TEST_API_KEY: 'sk-or-v1-AAAA BBBB' })).toBe(bad)
  expect(keyProblem(b, { LHB_TEST_API_KEY: 'sk-or-v1-abc\u0456' })).toBe(bad) // a Cyrillic i (U+0456) pasted for a Latin one
  expect(keyProblem(b, { LHB_TEST_API_KEY: '  sk-or-v1-abc\n' })).toBeUndefined()
  expect(apiKey(b, { LHB_TEST_API_KEY: '  sk-or-v1-abc\n' })).toBe('sk-or-v1-abc')
  expect(apiKey(b, {})).toBeUndefined()
  // A name every object inherits is not a variable: no function source as a key.
  expect(keyProblem({ apiKeyEnv: 'toString' }, {})).toBe('toString is not set')
  expect(keyProblem({ apiKeyEnv: 'constructor' }, process.env)).toBe('constructor is not set')
  expect(keyProblem({}, {})).toBeUndefined()
})

test('keyNote: the variable and the host it goes to, port included; nothing for a name or a URL validation would refuse', () => {
  expect(keyNote({ apiKeyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' })).toBe('the key in OPENROUTER_API_KEY goes to openrouter.ai')
  expect(keyNote({ apiKeyEnv: 'X_API_KEY', baseUrl: 'http://127.0.0.1:8080/v1' })).toBe('the key in X_API_KEY goes to 127.0.0.1:8080')
  expect(keyNote({ apiKeyEnv: 'X_API_KEY', baseUrl: 'http://127.0.0.1:8080/v1' }, { X_API_KEY: 'short-key' }))
    .toBe('the key in X_API_KEY goes to 127.0.0.1:8080 (shorter than 20 characters, so it is not redacted)')
  expect(keyNote({ apiKeyEnv: 'X_API_KEY', baseUrl: 'http://127.0.0.1:8080/v1' }, { X_API_KEY: 'k'.repeat(20) })).toBe('the key in X_API_KEY goes to 127.0.0.1:8080')
  expect(keyNote({ apiKeyEnv: 'sk-or-v1-pasted', baseUrl: 'https://openrouter.ai/api/v1' })).toBeUndefined()
  expect(keyNote({ apiKeyEnv: 'X_API_KEY', baseUrl: '' })).toBeUndefined()
  expect(keyNote({ baseUrl: 'https://openrouter.ai/api/v1' })).toBeUndefined()
})

test('isLoopbackUrl: this machine only, judged on the parsed hostname; nothing for what URL cannot parse', () => {
  for (const u of ['http://localhost:11434', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1', 'http://127.1:8080/v1'])
    expect([u, isLoopbackUrl(u)]).toEqual([u, true])
  for (const u of ['https://openrouter.ai/api/v1', 'http://192.168.1.5:8080/v1', 'http://localhost@evil.com/v1', 'http://localhost.evil.com/v1', '', 'http://', 'https://', 7, undefined])
    expect([u, isLoopbackUrl(u)]).toEqual([u, false])
})
