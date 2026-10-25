import { test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const files = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : [p] })

test('the Node floor the toolchain supports, and a build every time the package is packed', () => {
  expect(pkg.engines.node).toBe('>=22.12')
  expect(pkg.scripts.prepack).toBe('npm run build')
  expect(pkg.scripts.prepublishOnly).toBeUndefined()
})

test('vue is for the build only: nothing under src/ imports it', () => {
  expect(pkg.dependencies.vue).toBeUndefined()
  expect(pkg.devDependencies.vue).toBeDefined()
  for (const f of files('src').filter(f => f.endsWith('.ts'))) expect([f, /from ['"]vue['"]/.test(readFileSync(f, 'utf8'))]).toEqual([f, false])
})

test('the metadata npm shows', () => {
  expect(pkg.author).toBe('bambooplanedev <vk@bambooplane.dev>')
  expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/bambooplanedev/llm-harness-builder.git' })
  expect(pkg.homepage).toBe('https://github.com/bambooplanedev/llm-harness-builder#readme')
  expect(pkg.bugs).toEqual({ url: 'https://github.com/bambooplanedev/llm-harness-builder/issues' })
  expect(pkg.keywords).toEqual(['llm', 'agent', 'harness', 'local-llm', 'llama.cpp', 'ollama', 'tool-calling', 'tracing', 'benchmark'])
})

test('the recorded example runs ship, small, each trace finished, with nothing that ties them to a machine or an account', () => {
  expect(pkg.files).toContain('example-runs')
  const ex = files('example-runs')
  expect(ex.length).toBeLessThanOrEqual(10)
  expect(ex.reduce((a, f) => a + statSync(f).size, 0)).toBeLessThanOrEqual(500_000)
  const emails = [/<(.+)>/.exec(pkg.author)![1]]
  try { const e = execSync('git config user.email', { encoding: 'utf8' }).trim(); if (e) emails.push(e) } catch {} // CI may have none
  for (const f of ex) {
    const s = readFileSync(f, 'utf8')
    expect([f, /\/Users\/|\/home\/|\/var\/folders|\/private\/var|192\.168\.|10\.\d+\.\d+\.\d+|_API_KEY"\s*:\s*"[^"]/.exec(s)?.[0]]).toEqual([f, undefined])
    for (const e of emails) expect([f, s.includes(e)]).toEqual([f, false])
    if (f.endsWith('.jsonl')) expect([f, JSON.parse(s.trim().split('\n').at(-1)!).type]).toEqual([f, 'done'])
  }
})

test('the Claude Code fixture is hand-built: no path, email, key, bearer, git name or foreign user_id', () => {
  const s = readFileSync('tests/fixtures/claude-code-session.json', 'utf8')
  for (const re of [/\/Users\/|\/home\/|\/private\//, /[\w.+-]+@[\w-]+\.[\w.-]+/, /sk-ant-/, /Bearer /]) expect(re.exec(s)?.[0]).toBeUndefined()
  try { const n = execSync('git config user.name', { encoding: 'utf8' }).trim(); if (n) expect(s).not.toContain(n) } catch {} // CI may have none
  const ids = [...s.matchAll(/"user_id":\s*"([^"]*)"/g)].map(m => m[1])
  expect(ids.length).toBeGreaterThan(0)
  expect(new Set(ids)).toEqual(new Set(['user_fixture_0000']))
})

test('the README GIF is small enough for a first screen', () => {
  expect(statSync('docs/demo.gif').size).toBeLessThanOrEqual(2_000_000)
  for (const f of ['README.md', 'README.uk.md']) expect([f, readFileSync(f, 'utf8').includes('](docs/demo.gif)')]).toEqual([f, true])
})
