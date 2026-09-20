import { test, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TASKS, POOL, POOL2 } from '../src/core/tasks.js'
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
  chunk: ['arr.slice(i, size)', 'arr.slice(i, i + size)'],
  paginate: ['chunk(perPage, items)', 'chunk(items, perPage)'],
  parseDuration: ["if (u === 'm') total += Number(n) * 3600", "if (u === 'm') total += Number(n) * 60"],
  dedupe: ['const key = x', 'const key = ignoreCase ? x.toLowerCase() : x'],
  range: ['x < end;', 'step > 0 ? x < end : x > end;'],
  formatBytes: ['n > 1024', 'n >= 1024'],
  median: ['.sort()', '.sort((a, b) => a - b)'],
}
const fixAllBut = (dir: string, order: readonly string[], size: number, skip?: string) => {
  for (const name of order.slice(0, size)) {
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

// Every pool row in the README was measured at a size of 8 or less. The literal was taken before pool2 existed.
test('pool: the first eight units are byte for byte what they were', async () => {
  const dir = await TASKS.pool.prepare(8), u = POOL.slice(0, 8)
  const h = createHash('sha256')
  for (const f of ['package.json', ...u.map(n => `src/${n}.js`), ...u.map(n => `test/${n}.test.js`)]) { h.update(f + '\0'); h.update(readFileSync(join(dir, f))); h.update('\0') }
  expect(h.digest('hex')).toBe('5dcf23dd8ffe7b338f226d4bfc89dbd32681ae97d428aa01093da8bdac6d68a8')
})

// pool2 is the same ten units with chunk and paginate, which imports it, moved to the back.
test('pool2: the order is its own literal, a permutation of pool, and the prompt is the same text', async () => {
  expect([...POOL2]).toEqual(['clamp', 'words', 'titleCase', 'parseDuration', 'dedupe', 'range', 'formatBytes', 'median', 'chunk', 'paginate'])
  expect([...POOL2].sort()).toEqual([...POOL].sort())
  expect(TASKS.pool2.max).toBe(10)
  expect(TASKS.pool2.prompt).toBe(TASKS.pool.prompt)
  const dir = await TASKS.pool2.prepare(7)
  const seven = ['clamp', 'dedupe', 'formatBytes', 'parseDuration', 'range', 'titleCase', 'words']
  expect(readdirSync(dir).sort()).toEqual(['package.json', 'src', 'test'])
  expect(readdirSync(join(dir, 'src')).sort()).toEqual(seven.map(n => `${n}.js`))
  expect(readdirSync(join(dir, 'test')).sort()).toEqual(seven.map(n => `${n}.test.js`))
})

const POOLS = [['pool', POOL], ['pool2', POOL2]] as const

// The slug oracle once let 11 half fixes of 14 through. Here: every unit has a bug of its own, the
// tests pin it, and the reference fix — all ten of them, and nothing less — turns the suite green.
test.each(POOLS)('%s: leave-one-out — any nine fixes are FAIL, all ten are PASS', async (name, order) => {
  for (const skip of order) {
    const dir = await TASKS[name].prepare(order.length)
    fixAllBut(dir, order, order.length, skip)
    expect([skip, TASKS[name].check(dir, order.length)]).toEqual([skip, false])
  }
  const dir = await TASKS[name].prepare(order.length)
  fixAllBut(dir, order, order.length)
  expect(TASKS[name].check(dir, order.length)).toBe(true)
}, 60_000)

// 1000 against 1024 is the confusion this function invites; the test used not to tell them apart.
test('pool2: formatBytes fixed with 1000 instead of 1024 is FAIL', async () => {
  const dir = await TASKS.pool2.prepare(7)
  fixAllBut(dir, POOL2, 7, 'formatBytes')
  const f = join(dir, 'src', 'formatBytes.js')
  writeFileSync(f, readFileSync(f, 'utf8').replace('n > 1024', 'n >= 1000'))
  expect(TASKS.pool2.check(dir, 7)).toBe(false)
  writeFileSync(f, readFileSync(f, 'utf8').replace('n >= 1000', 'n >= 1024'))
  expect(TASKS.pool2.check(dir, 7)).toBe(true)
})

test.each(POOLS)('%s: the verdict does not depend on what the model did to test/', async (name, order) => {
  const green = await TASKS[name].prepare(2)
  fixAllBut(green, order, 2)
  writeFileSync(join(green, 'test', 'extra.test.js'), "import { test } from 'node:test'\ntest('added by the model', () => { throw new Error('red') })\n")
  expect(TASKS[name].check(green, 2)).toBe(true)  // a test the model added cannot fail a correct fix
  const red = await TASKS[name].prepare(2)
  writeFileSync(join(red, 'test', 'clamp.test.js'), "import { test } from 'node:test'\ntest('clamp: rewritten to pass', () => {})\n")
  writeFileSync(join(red, 'test', 'words.test.js'), "import { test } from 'node:test'\ntest('words: rewritten to pass', () => {})\n")
  expect(TASKS[name].check(red, 2)).toBe(false)   // rewriting the tests does not make the bugs go away
})

test.each(POOLS)('%s: a size that is not an integer from 1 to 10 is refused, by prepare and by check', async (name) => {
  const dir = await TASKS[name].prepare(1)
  for (const bad of [0, -1, 11, 2.5]) {
    await expect(TASKS[name].prepare(bad)).rejects.toThrow(RangeError)
    expect(() => TASKS[name].check(dir, bad)).toThrow(RangeError)
  }
  expect(readdirSync(join(dir, 'test'))).toEqual(['clamp.test.js']) // a refused check has not touched the workdir
  for (const bad of ['', 'relative/dir']) expect(() => TASKS[name].check(bad, 1)).toThrow(RangeError)
})
