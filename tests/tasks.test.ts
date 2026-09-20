import { test, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TASKS, POOL, POOL2, verdictSchema } from '../src/core/tasks.js'
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

// sift: step 3b of a news curator. The reference answer is what `grep` would write; the fixture is synthetic.
const SIFT = readFileSync(new URL('../examples-sift/screen.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean)
const siftAnswer = (dir: string, size: number) => {
  const rows = SIFT.slice(0, size).map(l => [l, JSON.parse(l)] as const)
  writeFileSync(join(dir, 'pass.jsonl'), rows.filter(([, o]) => o.verdict === 'PASS').map(([l]) => l + '\n').join(''))
  writeFileSync(join(dir, 'drops.txt'), rows.filter(([, o]) => o.verdict === 'DROP').map(([, o]) => `${o.id}: ${o.reason}\n`).join(''))
}

test('sift: the fixture is byte for byte what it was, and a workdir holds the first N lines and nothing else', async () => {
  expect(createHash('sha256').update(SIFT.join('\n') + '\n').digest('hex')).toBe('352ba7ea80f49e3f52c90617534c812c04b26e2ab2a262038f6670003a8076a2')
  expect(TASKS.sift.max).toBe(12)
  const dir = await TASKS.sift.prepare(8)
  expect(readdirSync(dir)).toEqual(['screen.jsonl'])
  expect(readFileSync(join(dir, 'screen.jsonl'), 'utf8')).toBe(SIFT.slice(0, 8).join('\n') + '\n')
  expect(TASKS.sift.check(dir, 8)).toBe(false) // nothing written yet
  await expect(TASKS.sift.prepare(0)).rejects.toThrow(RangeError)
  await expect(TASKS.sift.prepare(13)).rejects.toThrow(RangeError)
})

test('sift: the reference answer is PASS at every size, in any line order, and with the keys of a line in any order', async () => {
  for (const size of [1, 2, 8, 12]) {
    const dir = await TASKS.sift.prepare(size)
    siftAnswer(dir, size)
    expect([size, TASKS.sift.check(dir, size)]).toEqual([size, true])
  }
  const dir = await TASKS.sift.prepare(8)
  siftAnswer(dir, 8)
  const lines = readFileSync(join(dir, 'pass.jsonl'), 'utf8').split('\n').filter(Boolean).reverse()
  writeFileSync(join(dir, 'pass.jsonl'), lines.map(l => { const o = JSON.parse(l); return JSON.stringify({ quotes: o.quotes, reason: o.reason, verdict: o.verdict, id: o.id }) }).join('\n'))
  expect(TASKS.sift.check(dir, 8)).toBe(true)
})

test('sift: one changed character in a quote, a missing DROP, a PASS among the drops, a line that is not JSON — each is FAIL', async () => {
  const broken = async (file: string, edit: (text: string) => string) => {
    const dir = await TASKS.sift.prepare(8)
    siftAnswer(dir, 8)
    const before = readFileSync(join(dir, file), 'utf8'), after = edit(before)
    expect(after).not.toBe(before)
    writeFileSync(join(dir, file), after)
    return TASKS.sift.check(dir, 8)
  }
  expect(await broken('pass.jsonl', t => t.replace('from 41% to 6%', 'from 41% to 6 %'))).toBe(false)
  expect(await broken('pass.jsonl', t => t.replace(' — the agent', ' - the agent'))).toBe(false) // the retyped dash
  expect(await broken('pass.jsonl', t => t + SIFT[1] + '\n')).toBe(false)                          // a DROP line among the passes
  expect(await broken('pass.jsonl', t => t + 'done\n')).toBe(false)
  expect(await broken('drops.txt', t => t.split('\n').slice(1).join('\n'))).toBe(false)
  expect(await broken('drops.txt', t => t + '7001: Claims that a read-before-edit guard removes most failed edits of a small local model.\n')).toBe(false)
  expect(await broken('drops.txt', t => t.replace('7004: would PASS on topic', '7004: on topic'))).toBe(false)
})

// triage: step 2 of the curator. The key travels with the fixture and never reaches a workdir.
const TRIAGE = readFileSync(new URL('../examples-triage/posts.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).slice(1).map(l => JSON.parse(l))
/** An answer that follows the key: the first post of a duplicate pair is kept, a post the key leaves open gets `open`. */
const triageAnswer = (dir: string, size: number, open: 'KEEP' | 'DROP' = 'DROP', edit: (rows: any[]) => any[] = r => r) => {
  const seen = new Set<string>()
  const rows = TRIAGE.slice(0, size).map(p => {
    const first = p.dup !== undefined && !seen.has(p.dup)
    if (p.dup !== undefined) seen.add(p.dup)
    return { id: p.message_id, verdict: p.key === 'DUP' ? (first ? 'KEEP' : 'DROP') : p.key === 'EITHER' ? open : p.key, reason: 'x' }
  })
  writeFileSync(join(dir, 'triage.jsonl'), edit(rows).map(r => (typeof r === 'string' ? r : JSON.stringify(r)) + '\n').join(''))
}

test('triage: the fixture is byte for byte what it was, and the workdir holds posts.txt in the form the curator prints, without the key', async () => {
  expect(createHash('sha256').update(readFileSync(new URL('../examples-triage/posts.jsonl', import.meta.url))).digest('hex')).toBe('1113ade1cdccf6fa0a59aa052cff581635e1a08f5f5ce9d703ab1e5e0475d524')
  expect(TASKS.triage.max).toBe(12)
  const dir = await TASKS.triage.prepare(3)
  expect(readdirSync(dir)).toEqual(['posts.txt'])
  const text = readFileSync(join(dir, 'posts.txt'), 'utf8')
  expect(text).toContain('--- 8002 · 2026-09-18 · Agent Weekly\nFoxglove Agent 2.0 is now available\nWe are excited')
  expect(text).not.toMatch(/8005|"key"|KEEP|DROP|EITHER|no claim|off topic/)
  expect(TRIAGE.some(p => p.source === 'manual')).toBe(false) // a post added by hand never reaches the model
  expect(text.trimEnd().split('\n').at(-1)).toMatch(/: 3$/)
  expect(TASKS.triage.check(dir, 3)).toBe(false) // nothing written yet
  await expect(TASKS.triage.prepare(0)).rejects.toThrow(RangeError)
  await expect(TASKS.triage.prepare(13)).rejects.toThrow(RangeError)
})

test('triage: an answer that follows the key is PASS at every size; an open post and the choice within a duplicate pair do not matter', async () => {
  for (const size of [1, 3, 8, 12]) for (const open of ['KEEP', 'DROP'] as const) {
    const dir = await TASKS.triage.prepare(size)
    triageAnswer(dir, size, open)
    expect([size, open, TASKS.triage.check(dir, size)]).toEqual([size, open, true])
  }
  const dir = await TASKS.triage.prepare(12)
  const flip = (rows: any[]) => rows.map(r => r.id === 8001 ? { ...r, verdict: 'DROP' } : r.id === 8005 ? { ...r, verdict: 'KEEP', extra: 1 } : r)
  triageAnswer(dir, 12, 'DROP', flip)
  expect(TASKS.triage.check(dir, 12)).toBe(true)
  // At size 3 the pair of 8001 is not in the list: 8001 is then a plain KEEP.
  const alone = await TASKS.triage.prepare(3)
  triageAnswer(alone, 3, 'DROP', rows => rows.map(r => r.id === 8001 ? { ...r, verdict: 'DROP' } : r))
  expect(TASKS.triage.check(alone, 3)).toBe(false)
})

test('triage: a wrong verdict, both or neither of a duplicate pair, a missing or repeated id, a verdict outside KEEP/DROP, a line that is not JSON — each is FAIL', async () => {
  const broken = async (edit: (rows: any[]) => any[]) => { const dir = await TASKS.triage.prepare(12); triageAnswer(dir, 12, 'DROP', edit); return TASKS.triage.check(dir, 12) }
  const set = (id: number, verdict: string) => (rows: any[]) => rows.map(r => r.id === id ? { ...r, verdict } : r)
  expect(await broken(set(8011, 'DROP'))).toBe(false)   // a post worth reading thrown away
  expect(await broken(set(8004, 'KEEP'))).toBe(false)   // the car review let through
  expect(await broken(set(8005, 'KEEP'))).toBe(false)   // both of a pair kept
  expect(await broken(rows => rows.map(r => r.id === 8001 || r.id === 8005 ? { ...r, verdict: 'DROP' } : r))).toBe(false) // neither of a pair kept
  expect(await broken(set(8009, 'DROP'))).toBe(false)   // another article about the same report is not a duplicate
  expect(await broken(rows => rows.slice(1))).toBe(false)
  expect(await broken(rows => [...rows, rows[0]])).toBe(false)
  expect(await broken(set(8002, 'drop'))).toBe(false)
  expect(await broken(rows => [...rows, 'done'])).toBe(false)
})

// judge: the same step and the same key as triage, as one request. The posts are in the task text and the verdicts are the final answer.
const judgeAnswer = (size: number, edit: (o: Record<string, any>) => unknown = o => o) => {
  const seen = new Set<string>()
  return JSON.stringify(edit(Object.fromEntries(TRIAGE.slice(0, size).map(p => {
    const first = p.dup !== undefined && !seen.has(p.dup)
    if (p.dup !== undefined) seen.add(p.dup)
    return [String(p.message_id), { reason: 'x', verdict: p.key === 'DUP' ? (first ? 'KEEP' : 'DROP') : p.key === 'EITHER' ? 'DROP' : p.key }]
  }))))
}

test('judge: says what triage says about what to keep, shows the posts triage puts in posts.txt, and leaves the workdir empty', async () => {
  const rules = (p: string) => p.slice(p.indexOf('Triage them'), p.indexOf('If you cannot tell, DROP.') + 'If you cannot tell, DROP.'.length)
  expect(rules(TASKS.judge.prompt)).toBe(rules(TASKS.triage.prompt))
  expect(rules(TASKS.judge.prompt).length).toBeGreaterThan(400)
  expect(TASKS.judge.prompt).not.toMatch(/posts\.txt|triage\.jsonl|Write/)
  expect(TASKS.judge.input!(3)).toBe(readFileSync(join(await TASKS.triage.prepare(3), 'posts.txt'), 'utf8'))
  expect(readdirSync(await TASKS.judge.prepare(3))).toEqual([])
  expect(() => TASKS.judge.input!(13)).toThrow(RangeError)
})

test('judge: the schema has one required key per shown post and no other, a reason and then a verdict of KEEP or DROP under each', () => {
  const s = TASKS.judge.answerSchema!(3) as any
  expect([s.required, Object.keys(s.properties), s.additionalProperties]).toEqual([['8001', '8002', '8004'], ['8001', '8002', '8004'], false])
  expect(s.properties['8001']).toEqual({ type: 'object', additionalProperties: false, required: ['reason', 'verdict'], properties: { reason: { type: 'string', maxLength: 200 }, verdict: { enum: ['KEEP', 'DROP'] } } })
  expect(verdictSchema([7, 5])).toMatchObject({ required: ['7', '5'] })
})

test('judge: an answer that follows the key is PASS at every size; no answer, prose around it, a missing or unshown id, a wrong or absent verdict — each is FAIL', async () => {
  const dir = await TASKS.judge.prepare(12)
  for (const size of [1, 3, 8, 12]) expect([size, TASKS.judge.check(dir, size, judgeAnswer(size))]).toEqual([size, true])
  const bad = (edit: (o: Record<string, any>) => unknown) => TASKS.judge.check(dir, 12, judgeAnswer(12, edit))
  expect(TASKS.judge.check(dir, 12)).toBe(false)
  expect(TASKS.judge.check(dir, 12, 'Here it is:\n' + judgeAnswer(12))).toBe(false)
  expect(TASKS.judge.check(dir, 12, '```json\n' + judgeAnswer(12) + '\n```')).toBe(false)
  expect(bad(o => Object.values(o))).toBe(false)
  expect(bad(o => { delete o['8009']; return o })).toBe(false)
  expect(bad(o => ({ ...o, 101: { reason: 'x', verdict: 'KEEP' } }))).toBe(false)
  expect(bad(o => ({ ...o, 8009: { reason: 'x', verdict: 'DROP' } }))).toBe(false)
  expect(bad(o => ({ ...o, 8009: { reason: 'x', verdict: 'MAYBE' } }))).toBe(false)
  expect(bad(o => ({ ...o, 8009: null }))).toBe(false)
  expect(bad(o => ({ ...o, 8005: { reason: 'x', verdict: 'KEEP' } }))).toBe(false) // both of a duplicate pair
})
