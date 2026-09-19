import { test } from 'node:test'
import assert from 'node:assert/strict'
import { titleCase } from '../src/titleCase.js'

test('titleCase: capitalises each word', () => {
  assert.equal(titleCase('hello world'), 'Hello World')
})
test('titleCase: lowers the rest of a word and collapses the separators', () => {
  assert.equal(titleCase('the  qUICK fox'), 'The Quick Fox')
})
