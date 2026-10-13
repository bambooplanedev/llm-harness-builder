import { test, expect } from 'vitest'
import { BASE_ENV, childEnv, bashEnvNote } from '../src/core/tools/env.js'

const from = { PATH: '/bin', HOME: '/h', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: '/t', SECRET_KEY: 's3cr3t', GITHUB_TOKEN: 'v4lue', BASH_ENV: '/x' }

test('BASE_ENV is the list the spec names, in that order', () => {
  expect(BASE_ENV).toEqual(['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME', 'TERM', 'TMPDIR'])
})

test('childEnv: the base set only, and only what is set', () => {
  expect(childEnv([], from)).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: '/t' })
})

test('childEnv: a named variable comes through with its value; a name that is not set is left out', () => {
  expect(childEnv(['GITHUB_TOKEN', 'NOT_SET'], from)).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: '/t', GITHUB_TOKEN: 'v4lue' })
})

test('childEnv: reads process.env by default and never hands out the whole of it', () => {
  process.env.LHB_ENV_PROBE = 'probe'
  try {
    expect(childEnv().LHB_ENV_PROBE).toBeUndefined()
    expect(childEnv(['LHB_ENV_PROBE']).LHB_ENV_PROBE).toBe('probe')
  } finally { delete process.env.LHB_ENV_PROBE }
})

test('bashEnvNote: names only, the unset ones marked; nothing to say for an empty or absent list', () => {
  const note = bashEnvNote(['GITHUB_TOKEN', 'NOT_SET'], from)
  expect(note).toBe('bash gets from your environment: GITHUB_TOKEN, NOT_SET (not set)')
  expect(note).not.toContain('v4lue')
  expect(bashEnvNote([], from)).toBeUndefined()
  expect(bashEnvNote(undefined, from)).toBeUndefined()
})
