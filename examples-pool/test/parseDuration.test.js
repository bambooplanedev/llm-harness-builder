import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration } from '../src/parseDuration.js'

test('parseDuration: hours alone', () => {
  assert.equal(parseDuration('2h'), 7200)
})
test('parseDuration: hours, minutes and seconds together', () => {
  assert.equal(parseDuration('1h30m15s'), 5415)
})
