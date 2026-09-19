import { test, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TASKS } from '../src/core/tasks.js'
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
