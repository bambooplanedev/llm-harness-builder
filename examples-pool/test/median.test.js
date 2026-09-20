import { test } from 'node:test'
import assert from 'node:assert/strict'
import { median } from '../src/median.js'

test('median: the middle of an odd count', () => {
  assert.equal(median([3, 1, 2]), 2)
})
test('median: numeric order, not the order of the digits', () => {
  assert.equal(median([10, 9, 100]), 10)
  assert.equal(median([1, 2, 3, 4]), 2.5)
})
