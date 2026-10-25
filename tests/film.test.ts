import { test, expect } from 'vitest'
import { filmText, filmDeep, namesIn } from '../web/src/film'

const n = { models: ['qwen3', 'qwen3:8b', 'm'], urls: ['http://localhost:11434'] }
test('model names, longest first, and short names left alone', () => {
  expect(filmText('qwen3:8b and qwen3 by m', n)).toBe('model and model by m')
})
test('the server url and its bare host', () => {
  expect(filmText('POST http://localhost:11434/api/chat; host localhost:11434', n)).toBe('POST server/api/chat; host server')
})
test('paths under a machine root go, routes and regex literals stay', () => {
  expect(filmText('at (/tmp/lhb-example-1/test/a.js:9:10)', n)).toBe('at (…/:9:10)')
  expect(filmText('"/Users/someone/project"', n)).toBe('"…/"')
  expect(filmText('cd /home/u/x && ls /var/folders/ab /private/tmp/q', n)).toBe('cd …/ && ls …/ …/')
  expect(filmText('at file:///tmp/lhb-example-1/test/a.js:9:10', n)).toBe('at file://…/:9:10') // node's stack traces
  for (const s of ['src/slugify.js', '/no_think', 'replace(/[^a-z0-9]+/g, "-")', 'https://example.com/a/b', 'GET /api/users/42 path=/api/users/42', 's.replace(/a\\/b/g, "")', '/tmp', '/tmpx/y'])
    expect(filmText(s, n)).toBe(s)
})
test('every model in a trace is found, and the copy leaves the input alone', () => {
  const evs: any[] = [{ type: 'llm_request', payload: { model: 'big-model' } }, { type: 'llm_response', raw: { model: 'small-model' } }]
  expect(namesIn(evs).models.sort()).toEqual(['big-model', 'small-model'])
  const copy = filmDeep(evs, namesIn(evs))
  expect(JSON.stringify(copy)).not.toMatch(/big-model|small-model/)
  expect(evs[0].payload.model).toBe('big-model')
})
