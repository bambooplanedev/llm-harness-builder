import { test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

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
