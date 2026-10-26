import { test, expect } from 'vitest'

import { join } from 'node:path'
import { tmp } from './helpers.js'
import { execSync, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { bash, runShell } from '../src/core/tools/bash.js'

const ctx = async () => ({ workdir: await tmp('lhb-sh-'), maxToolOutputChars: 4000 })

test('runs in workdir, returns output and exit code', async () => {
  const c = await ctx()
  const out = await bash({ command: 'pwd; echo err 1>&2; exit 3' }, c)
  expect(out).toContain(c.workdir.split('/').pop()!)
  expect(out).toContain('err')
  expect(out.trim().endsWith('[exit 3]')).toBe(true)
})

test('timeout kills the whole process group', async () => {
  const c = await ctx()
  const marker = `lhb-${Date.now()}`
  const sleepCmd = `sleep 100.${Date.now() % 1000}`
  const out = await bash({ command: `${sleepCmd} & ${sleepCmd}; echo ${marker}` }, c, { timeoutMs: 300 })
  expect(out).toMatch(/killed: timeout/)
  await new Promise(r => setTimeout(r, 100))
  const ps = execSync('ps -ax -o command').toString()
  expect(ps.split('\n').filter(l => l.includes(sleepCmd)).length).toBe(0)
})

test('maxBuffer caps output', async () => {
  const c = await ctx()
  const out = await bash({ command: 'yes | head -c 200000' }, c, { maxBuffer: 1000 })
  expect(out.length).toBeLessThan(1200)
})

test('multibyte output is decoded correctly across chunks', async () => {
  const c = await ctx()
  // 200k of a 3-byte char forces several pipe chunks; every char must survive
  const out = await bash({ command: `node -e "process.stdout.write('€'.repeat(200000))"` }, c)
  expect(out).not.toContain('�')
  expect(out.split('€').length - 1).toBe(200000)
})

test('a running command dies with the parent process (SIGINT)', { timeout: 20_000 }, async () => {
  const pidFile = join((await ctx()).workdir, 'pid')
  const parent = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/bash-hold.ts', pidFile], { stdio: 'ignore' })
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  let shPid = 0
  for (let i = 0; i < 100 && !shPid; i++) { await sleep(100); shPid = Number(await readFile(pidFile, 'utf8').catch(() => 0)) }
  expect(shPid).toBeGreaterThan(0)
  parent.kill('SIGINT')
  await new Promise(r => parent.on('exit', r))
  for (let i = 0; i < 30; i++) { try { process.kill(shPid, 0) } catch { return }; await sleep(100) }
  throw new Error(`sh ${shPid} outlived its parent`)
})

test('a variable of ours that is neither in the base set nor in bashEnv does not reach the command', async () => {
  process.env.LHB_BASH_SECRET = 'synthetic-s3cr3t'
  try {
    const out = await bash({ command: 'echo "[$LHB_BASH_SECRET]"; env' }, await ctx())
    expect(out).toContain('[]')
    expect(out).not.toContain('synthetic-s3cr3t')
    expect(out).toMatch(/^PATH=/m)
    expect(out).toMatch(/^HOME=/m)
  } finally { delete process.env.LHB_BASH_SECRET }
})

test('a name in bashEnv reaches the command with its value', async () => {
  process.env.LHB_BASH_NAMED = 'named-value'
  try {
    const out = await bash({ command: 'echo "[$LHB_BASH_NAMED]"' }, { ...(await ctx()), bashEnv: ['LHB_BASH_NAMED'] })
    expect(out).toContain('[named-value]')
  } finally { delete process.env.LHB_BASH_NAMED }
})

test('ctx.bashMaxBytes and ctx.bashTimeoutS replace the defaults; absent keeps them', async () => {
  const c = await ctx()
  expect(await bash({ command: 'printf 0123456789' }, { ...c, bashMaxBytes: 4 })).toBe('0123\n[output truncated]\n[exit 0]')
  expect(await bash({ command: 'sleep 5' }, { ...c, bashTimeoutS: 1 })).toContain('[killed: timeout after 1s]')
  expect(await bash({ command: 'printf 0123456789' }, c)).toBe('0123456789\n[exit 0]')
})

const sh = (command: string, o: Partial<Parameters<typeof runShell>[1]> = {}) =>
  runShell(command, { cwd: process.cwd(), env: process.env, timeoutMs: 10_000, maxBuffer: 1 << 20, ...o })

test('runShell: the exit code', async () => {
  expect(await sh('exit 3')).toMatchObject({ code: 3, killed: false, capped: false })
})

test('runShell: a timeout kills the whole group, background children too', async () => {
  const r = await sh('sleep 5 & echo $!; wait', { timeoutMs: 300 })
  expect(r.killed).toBe(true)
  const pid = Number(r.out.trim().split('\n')[0])
  await new Promise(res => setTimeout(res, 1000))
  expect(() => process.kill(pid, 0)).toThrow()
})

test('runShell: keep tail keeps the end of a long output', async () => {
  const r = await sh(`node -e "for (let i = 0; i < 300000; i++) console.log('line ' + i)"`, { keep: 'tail', maxBuffer: 1 << 20 })
  expect(r.capped).toBe(true)
  expect(r.out.trimEnd().endsWith('line 299999')).toBe(true)
  expect(Buffer.byteLength(r.out)).toBeLessThanOrEqual(1 << 20)
})
