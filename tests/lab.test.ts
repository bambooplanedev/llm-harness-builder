import { test, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { validateConfig } from '../src/core/config.js'

/** Every file under docs/lab whose name ends in ext, recursively. */
export const labFiles = (ext: string, d = 'docs/lab'): string[] =>
  readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? labFiles(ext, p) : p.endsWith(ext) ? [p] : [] })

const read = (f: string) => readFileSync(f, 'utf8')
const repo = 'bambooplanedev/llm-harness-builder'
const UK = '\u0423\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430' // the language's own name
const without = ({ name, description, ...rest }: any) => rest

test('lab pages come in en/uk pairs with a switch line, the same headings and the same commands', () => {
  const en = labFiles('.md').filter(f => !f.endsWith('.uk.md'))
  expect(en.length).toBeGreaterThan(0)
  const headings = (f: string) => read(f).split('\n').filter(l => /^#{1,6} /.test(l)).length
  for (const f of en) {
    const uk = f.replace(/\.md$/, '.uk.md'), base = f.split('/').at(-1)!.replace(/\.md$/, '')
    expect([uk, existsSync(uk)]).toEqual([uk, true])
    expect(read(f).split('\n')[0]).toBe(`**English** · [${UK}](${base}.uk.md)`)
    expect(read(uk).split('\n')[0]).toBe(`[English](${base}.md) · **${UK}**`)
    expect([uk, headings(uk)]).toEqual([uk, headings(f)])
    const code = (p: string) => read(p).split('\n').filter(l => /^ {4,}\S/.test(l)) // indented code blocks: commands stay identical
    expect([uk, code(uk)]).toEqual([uk, code(f)])
  }
})

test('every link and download in the lab points at a file in the repo', () => {
  for (const f of labFiles('.md')) {
    const s = read(f)
    for (const [, t] of s.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^https?:/.test(t)) continue
      const p = join(dirname(f), t.replace(/#.*$/, ''))
      expect([f, t, existsSync(p)]).toEqual([f, t, true])
    }
    const gh = new RegExp(`https://(?:raw\\.githubusercontent\\.com/${repo}/main|github\\.com/${repo}/(?:tree|blob)/main)/([^)\\s\`#]+)`, 'g')
    for (const [u, p] of s.matchAll(gh)) expect([f, u, existsSync(p)]).toEqual([f, u, true])
  }
  expect(read('docs/lab/02-make-bare-pass/README.md')).toContain(`https://raw.githubusercontent.com/${repo}/main/docs/lab/02-make-bare-pass/start.json`)
})

test('every run id the lab names is in example-runs', () => {
  const ids = labFiles('.md').flatMap(f => [...read(f).matchAll(/`([0-9a-f]{8})`|([0-9a-f]{8})\.jsonl/g)].map(m => m[1] ?? m[2]))
  expect(ids.length).toBeGreaterThan(0)
  for (const id of ids) expect([id, existsSync(`example-runs/${id}.jsonl`)]).toEqual([id, true])
})

test('the starter is bare under another name, and it loads locally and on a hosted API', () => {
  const start = JSON.parse(read('docs/lab/02-make-bare-pass/start.json'))
  expect(start.name).toBe('lab-start')
  expect(start.description).toBe('Lab exercise 2: bare under its own name. Change only this file until bench passes.')
  expect(without(start)).toEqual(without(JSON.parse(read('harnesses/bare.json'))))
  expect(validateConfig(start)).toEqual([])
  // What `bench --kind --base-url --api-key-env --model` does to the file in loadHarness (src/cli.ts, not exported).
  const cloud = { ...start, backend: { ...start.backend, kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', model: 'm' } }
  expect(validateConfig(cloud)).toEqual([])
})

test('the lab is on GitHub, not in the npm package', () => {
  const pkg = JSON.parse(read('package.json'))
  expect(pkg.files.filter((f: string) => f.startsWith('docs'))).toEqual([])
})

test('both READMEs link the lab kit by its GitHub URL', () => {
  for (const f of ['README.md', 'README.uk.md']) expect([f, read(f).includes(`https://github.com/${repo}/tree/main/docs/lab`)]).toEqual([f, true])
})
