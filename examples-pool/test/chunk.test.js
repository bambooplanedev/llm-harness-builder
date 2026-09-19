import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunk } from '../src/chunk.js'

test('chunk: an exact multiple gives full pieces', () => {
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]])
})
test('chunk: the last piece may be shorter', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})
