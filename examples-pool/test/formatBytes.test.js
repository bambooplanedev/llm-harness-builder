import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatBytes } from '../src/formatBytes.js'

test('formatBytes: bytes and a fraction of a unit', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1000), '1000 B')
  assert.equal(formatBytes(1536), '1.5 KB')
})
test('formatBytes: exactly 1024 of a unit is 1.0 of the next', () => {
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1048576), '1.0 MB')
  assert.equal(formatBytes(1073741824), '1.0 GB')
})
