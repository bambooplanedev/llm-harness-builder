import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clamp } from '../src/clamp.js'

test('clamp: a value inside the range is unchanged', () => {
  assert.equal(clamp(5, 0, 10), 5)
})
test('clamp: a value outside the range becomes the nearer bound', () => {
  assert.equal(clamp(-3, 0, 10), 0)
  assert.equal(clamp(42, 0, 10), 10)
})
