import { test } from 'node:test'
import assert from 'node:assert/strict'
import { range } from '../src/range.js'

test('range: counts up to but not including end', () => {
  assert.deepEqual(range(0, 3), [0, 1, 2])
  assert.deepEqual(range(0, 5, 2), [0, 2, 4])
})
test('range: a negative step counts down', () => {
  assert.deepEqual(range(3, 0, -1), [3, 2, 1])
  assert.deepEqual(range(5, 0, -2), [5, 3, 1])
})
