import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paginate } from '../src/paginate.js'

test('paginate: page 1 is the first perPage items', () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 1, 2), [1, 2])
})
test('paginate: the last page may be short, and a page out of range is empty', () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 3, 2), [5])
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 4, 2), [])
})
