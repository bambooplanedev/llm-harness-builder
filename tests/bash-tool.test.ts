import { test, expect } from 'vitest'

import { join } from 'node:path'
import { tmp } from './helpers.js'
import { execSync, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { bash } from '../src/core/tools/bash.js'

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
