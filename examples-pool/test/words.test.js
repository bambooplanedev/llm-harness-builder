import { test } from 'node:test'
import assert from 'node:assert/strict'
import { words } from '../src/words.js'

test('words: splits on spaces', () => {
  assert.deepEqual(words('hello world'), ['hello', 'world'])
})
test('words: punctuation at the edges leaves no empty strings', () => {
  assert.deepEqual(words('  Hello, world! '), ['Hello', 'world'])
})
