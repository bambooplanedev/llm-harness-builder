import { test, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync('npx', ['tsx', 'src/cli.ts', ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

test('run --json prints jsonl and exits 0 on final', async () => {
  const wd = await mkdtemp(join(tmpdir(), 'lhb-cli-'))
  const fake = join(wd, 'fake.json')
  // a large final response makes truncation observable if the process exits before stdout drains
  await writeFile(fake, JSON.stringify([{ toolCalls: [{ name: 'bash', args: { command: 'echo hi' } }] }, { content: 'x'.repeat(200_000) }]))
  const r = cli(['run', 'harnesses/bare.json', '--workdir', wd, '--yes', '--json', 'say hi'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  const lines = r.stdout.trim().split('\n').map(l => JSON.parse(l))
  const last = lines.at(-1)
  expect(last).toMatchObject({ type: 'done', reason: 'final' })
  expect(last.text).toHaveLength(200_000)
  expect(r.stderr).toContain('tool_call')
}, 30_000)

test('run exits 1 on parse_failed', async () => {
  const wd = await mkdtemp(join(tmpdir(), 'lhb-cli-'))
  const fake = join(wd, 'fake.json')
  await writeFile(fake, JSON.stringify([{ content: '' }, { content: '' }]))
  const r = cli(['run', 'harnesses/bare.json', '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(1)
}, 30_000)

test('demo prints PASS/FAIL per harness', async () => {
  const fake = join(await mkdtemp(join(tmpdir(), 'lhb-cli-')), 'fake.json')
  // bare: model answers without doing anything -> check.sh fails. tuned: fixes the bug via edit_file.
  await writeFile(fake, JSON.stringify([
    { content: 'Done.' },
    { content: '{"calls":[{"name":"edit_file","args":{"path":"src/slugify.js","old":"replace(/[^a-z0-9]+/g, \'-\')","new":"replace(/[^a-z0-9]+/g, \'-\').replace(/^-+|-+$/g, \'\')"}}],"final":null}' },
    { content: '{"calls":[],"final":"Fixed."}' },
    { content: '<tool_call>\n{"name":"edit_file","arguments":{"path":"src/slugify.js","old":"replace(/[^a-z0-9]+/g, \'-\')","new":"replace(/[^a-z0-9]+/g, \'-\').replace(/^-+|-+$/g, \'\')"}}\n</tool_call>' },
    { content: 'Fixed.' },
  ]))
  const r = cli(['demo'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  expect(r.stdout).toMatch(/bare\s+FAIL/)
  expect(r.stdout).toMatch(/tuned\s+PASS/)
  expect(r.stdout).toMatch(/tuned-hermes\s+PASS/)
}, 60_000)

test('demo --json keeps stdout pure JSONL and prints the summary on stderr', async () => {
  const fake = join(await mkdtemp(join(tmpdir(), 'lhb-cli-')), 'fake.json')
  await writeFile(fake, JSON.stringify([
    { content: 'Done.' },
    { content: '{"calls":[{"name":"edit_file","args":{"path":"src/slugify.js","old":"replace(/[^a-z0-9]+/g, \'-\')","new":"replace(/[^a-z0-9]+/g, \'-\').replace(/^-+|-+$/g, \'\')"}}],"final":null}' },
    { content: '{"calls":[],"final":"Fixed."}' },
    { content: '<tool_call>\n{"name":"edit_file","arguments":{"path":"src/slugify.js","old":"replace(/[^a-z0-9]+/g, \'-\')","new":"replace(/[^a-z0-9]+/g, \'-\').replace(/^-+|-+$/g, \'\')"}}\n</tool_call>' },
    { content: 'Fixed.' },
  ]))
  const r = cli(['demo', '--json'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  const lines = r.stdout.trim().split('\n')
  for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
  expect(r.stdout).not.toMatch(/PASS|FAIL/)
  expect(r.stderr).toMatch(/bare\s+FAIL/)
  expect(r.stderr).toMatch(/tuned\s+PASS/)
  expect(r.stderr).toMatch(/tuned-hermes\s+PASS/)
}, 60_000)

test('run flags a final answer with zero tool calls', async () => {
  const wd = await mkdtemp(join(tmpdir(), 'lhb-cli-'))
  const fake = join(wd, 'fake.json')
  await writeFile(fake, JSON.stringify([{ content: 'Let me look at that first.' }]))
  const r = cli(['run', 'harnesses/tuned-hermes.json', '--workdir', wd, '--yes', 'x'], { LHB_FAKE_BACKEND: fake })
  expect(r.status).toBe(0)
  expect(r.stderr).toMatch(/! final after 0 tool calls/)
}, 30_000)
