import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/slugify.js'

test('collapses non-alphanumerics into single dashes', () => {
  assert.equal(slugify('Hello   World'), 'hello-world')
})
test('strips leading and trailing dashes', () => {
  assert.equal(slugify('  Hello, World!  '), 'hello-world')
})
