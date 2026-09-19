import { test, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TASKS, POOL } from '../src/core/tasks.js'
import { DEMO_TASK } from '../src/core/prompts.js'

// Every number in the README before 2026-09-19 was measured on this workdir and this text.
// The literal was taken from the CLI before makeDemoWorkdir moved into tasks.ts.
test('slug: the prepared workdir and the prompt are byte for byte what they were', async () => {
  const dir = await TASKS.slug.prepare()
  const FILES = ['README.md', 'check.sh', 'data/app.log', 'package.json', 'src/slugify.js', 'test/slugify.test.js']
  const h = createHash('sha256')
  for (const f of FILES) { h.update(f + '\0'); h.update(readFileSync(join(dir, f))); h.update('\0') }
  expect(h.digest('hex')).toBe('e5075cb8ff7a2425361fab4d69069c5d30c5658ff5e1bca0d6aa4c03ada247bd')
  expect(readdirSync(dir).sort()).toEqual(['README.md', 'check.sh', 'data', 'package.json', 'src', 'test'])
  expect(TASKS.slug.prompt).toBe(DEMO_TASK)
  expect(TASKS.slug.max).toBeUndefined()
  expect(TASKS.slug.check(dir)).toBe(false) // the shipped bug is still there
})

// One [old, fixed] pair per unit: the reference fix. Never shipped into a workdir.
const FIX: Record<string, [string, string]> = {
  clamp: ['Math.min(Math.max(x, hi), lo)', 'Math.min(Math.max(x, lo), hi)'],
  words: ['.split(/[^A-Za-z0-9]+/)', '.split(/[^A-Za-z0-9]+/).filter(Boolean)'],
  titleCase: ['w.slice(1))', 'w.slice(1).toLowerCase())'],
  chunk: ['i + size <= arr.length', 'i < arr.length'],
  paginate: ['chunk(perPage, items)', 'chunk(items, perPage)'],
  parseDuration: ['m: 3600', 'm: 60'],
  dedupe: ['const key = x', 'const key = ignoreCase ? x.toLowerCase() : x'],
  range: ['x < end;', 'step > 0 ? x < end : x > end;'],
  formatBytes: ['n > 1024', 'n >= 1024'],
  median: ['.sort()', '.sort((a, b) => a - b)'],
}
const fixAllBut = (dir: string, size: number, skip?: string) => {
  for (const name of POOL.slice(0, size)) {
    const f = join(dir, 'src', `${name}.js`), src = readFileSync(f, 'utf8'), [old, fixed] = FIX[name]
    expect([name, src.split(old).length - 1]).toEqual([name, 1]) // the bug is there, exactly once
    if (name !== skip) writeFileSync(f, src.replace(old, fixed))
  }
}

test('pool: the order, the size limit, and a workdir that holds the first N units and nothing else', async () => {
  expect([...POOL]).toEqual(Object.keys(FIX))
  expect(TASKS.pool.max).toBe(POOL.length)
  const dir = await TASKS.pool.prepare(3)
  expect(readdirSync(dir).sort()).toEqual(['package.json', 'src', 'test'])
  expect(readdirSync(join(dir, 'src')).sort()).toEqual(['clamp.js', 'titleCase.js', 'words.js'])
  expect(readdirSync(join(dir, 'test')).sort()).toEqual(['clamp.test.js', 'titleCase.test.js', 'words.test.js'])
  expect(TASKS.pool.prompt).not.toMatch(/grep|tail|read_file|edit_file|write_file|bash/)
})

// The slug oracle once let 11 half fixes of 14 through. Here: every unit has a bug of its own, the
// tests pin it, and the reference fix — all ten of them, and nothing less — turns the suite green.
test('pool: leave-one-out — any nine fixes are FAIL, all ten are PASS', async () => {
  for (const skip of POOL) {
    const dir = await TASKS.pool.prepare(POOL.length)
    fixAllBut(dir, POOL.length, skip)
    expect([skip, TASKS.pool.check(dir, POOL.length)]).toEqual([skip, false])
  }
  const dir = await TASKS.pool.prepare(POOL.length)
  fixAllBut(dir, POOL.length)
  expect(TASKS.pool.check(dir, POOL.length)).toBe(true)
}, 60_000)

test('pool: the verdict does not depend on what the model did to test/', async () => {
  const green = await TASKS.pool.prepare(2)
  fixAllBut(green, 2)
  writeFileSync(join(green, 'test', 'extra.test.js'), "import { test } from 'node:test'\ntest('added by the model', () => { throw new Error('red') })\n")
  expect(TASKS.pool.check(green, 2)).toBe(true)  // a test the model added cannot fail a correct fix
  const red = await TASKS.pool.prepare(2)
  writeFileSync(join(red, 'test', 'clamp.test.js'), "import { test } from 'node:test'\ntest('clamp: rewritten to pass', () => {})\n")
  writeFileSync(join(red, 'test', 'words.test.js'), "import { test } from 'node:test'\ntest('words: rewritten to pass', () => {})\n")
  expect(TASKS.pool.check(red, 2)).toBe(false)   // rewriting the tests does not make the bugs go away
})
