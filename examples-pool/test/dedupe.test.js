import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupe } from '../src/dedupe.js'

test('dedupe: keeps the first occurrence', () => {
  assert.deepEqual(dedupe(['a', 'b', 'a']), ['a', 'b'])
  assert.deepEqual(dedupe(['A', 'a', 'a']), ['A', 'a'])
})
test('dedupe: ignoreCase treats "A" and "a" as one item', () => {
  assert.deepEqual(dedupe(['A', 'a', 'b'], { ignoreCase: true }), ['A', 'b'])
})
