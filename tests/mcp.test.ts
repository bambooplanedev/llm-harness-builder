import { test, expect, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServers } from '../src/core/mcp.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))
const wd = () => mkdtemp(join(tmpdir(), 'lhb-mcp-'))
const fake = (args: string[] = []) => ({ fs: { command: process.execPath, args: [FIXTURE, ...args] } })

test('handshake lists tools, and $schema is stripped from every schema', async () => {
  const s = await startServers(fake(), await wd())
  try {
    expect(s.tools.map(t => t.name)).toContain('echo')
    expect(s.has('echo')).toBe(true)
    expect(s.has('nope')).toBe(false)
    const echo = s.tools.find(t => t.name === 'echo')!
    expect(echo.parameters).not.toHaveProperty('$schema')
    expect(echo.parameters).toMatchObject({ type: 'object', required: ['text'] })
  } finally { s.close() }
})

test('a schema that is not an object is replaced with an empty object schema', async () => {
  const s = await startServers(fake(), await wd())
  try {
    expect(s.tools.find(t => t.name === 'weird')!.parameters).toEqual({ type: 'object', properties: {}, required: [] })
  } finally { s.close() }
})

test('the allow-list filters; absent or empty means every tool', async () => {
  const few = await startServers({ fs: { ...fake().fs, tools: ['echo', 'boom'] } }, await wd())
  try { expect(few.tools.map(t => t.name).sort()).toEqual(['boom', 'echo']) } finally { few.close() }
  const all = await startServers({ fs: { ...fake().fs, tools: [] } }, await wd())
  try { expect(all.tools.length).toBe(9) } finally { all.close() }
})

test('servers info reports what was offered, what survived, and what it costs', async () => {
  const s = await startServers({ fs: { ...fake().fs, tools: ['echo'] } }, await wd())
  try {
    expect(s.servers).toHaveLength(1)
    const i = s.servers[0]
    expect(i).toMatchObject({ server: 'fs', offered: 9, tools: ['echo'] })
    expect(i.descriptionChars).toBe('Echo text back.'.length)
    expect(i.schemaChars).toBeGreaterThan(0)
    expect(JSON.stringify(s.tools[0].parameters).length).toBe(i.schemaChars)
  } finally { s.close() }
})

test('a name that is already taken is a collision, and the started server is cleaned up', async () => {
  await expect(startServers(fake(), await wd(), { taken: new Set(['echo']) }))
    .rejects.toThrow(/collision.*"echo".*mcp server "fs"/)
})

// Regression for a review finding: `close()` used to be the only path that called `untrack`, so a
// server that dies on its own (crash, killed out from under us) left its pid in procs.ts's shared
// registry until the whole harness process exits. procs.ts deliberately exposes no way to inspect
// that registry, so this drives it the same way tests/procs.test.ts does: wrap `track`/`untrack`
// via vi.doMock (an ESM named-export cannot be vi.spyOn'd directly — see the module's own error
// message) and observe which pids each is called with, against a fresh module graph so the mock
// is in place before `mcp.js` resolves its import of `procs.js`.
test('a server that dies on its own is untracked, not just one that we close', async () => {
  const tracked: number[] = []
  const untracked: number[] = []
  vi.doMock('../src/core/procs.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/core/procs.js')>()
    return {
      track: (pid: number) => { tracked.push(pid); actual.track(pid) },
      untrack: (pid: number) => { untracked.push(pid); actual.untrack(pid) },
    }
  })
  vi.resetModules()
  try {
    const { startServers: freshStartServers } = await import('../src/core/mcp.js')
    const s = await freshStartServers(fake(), await wd())
    const pid = tracked[0]
    expect(pid).toBeTypeOf('number')

    process.kill(pid, 'SIGKILL')   // the server dies on its own; we never call close()
    const deadline = Date.now() + 2000
    while (!untracked.includes(pid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    expect(untracked).toEqual([pid])   // untracked exactly once, without close() ever running

    expect(() => s.close()).not.toThrow()   // a close() after natural death must not double-untrack
    expect(untracked).toEqual([pid])
  } finally {
    vi.doUnmock('../src/core/procs.js')
    vi.resetModules()
  }
})

test('a text result comes back as text', async () => {
  const s = await startServers(fake(), await wd())
  try { expect(await s.call('echo', { text: 'hi' })).toEqual({ output: 'echo: hi', error: false }) } finally { s.close() }
})

test('isError marks the result as an error without throwing', async () => {
  const s = await startServers(fake(), await wd())
  try { expect(await s.call('boom', {})).toEqual({ output: 'it failed', error: true }) } finally { s.close() }
})

test('a JSON-RPC error is a tool error, not a throw', async () => {
  const s = await startServers(fake(), await wd())
  try {
    const r = await s.call('rpcfail', {})
    expect(r.error).toBe(true)
    expect(r.output).toBe('mcp error -32602: bad arguments')
  } finally { s.close() }
})

test('a non-text block becomes a marker and the text around it survives', async () => {
  const s = await startServers(fake(), await wd())
  try { expect(await s.call('picture', {})).toEqual({ output: 'before\n[image content omitted]', error: false }) } finally { s.close() }
})

test('an empty content list says so instead of returning nothing', async () => {
  const s = await startServers(fake(), await wd())
  try { expect(await s.call('silent', {})).toEqual({ output: '(empty result)', error: false }) } finally { s.close() }
})

test('junk written before a response is skipped and the response still arrives', async () => {
  const s = await startServers(fake(), await wd())
  try { expect(await s.call('noisy', {})).toEqual({ output: 'noisy ok', error: false }) } finally { s.close() }
})

test('calling a tool no server owns is an error, not a throw', async () => {
  const s = await startServers(fake(), await wd())
  try {
    const r = await s.call('nowhere', {})
    expect(r.error).toBe(true)
    expect(r.output).toMatch(/no mcp server provides "nowhere"/)
  } finally { s.close() }
})

test('once the server dies every later call is an error and the run can go on', async () => {
  const s = await startServers(fake(['--die-after=1']), await wd())
  try {
    expect(await s.call('echo', { text: 'one' })).toEqual({ output: 'echo: one', error: false })
    const r = await s.call('echo', { text: 'two' })
    expect(r.error).toBe(true)
    expect(r.output).toMatch(/mcp server "fs" is not running|exited/)
  } finally { s.close() }
})

test('a server that never answers initialize fails with its stderr attached', async () => {
  await expect(startServers(fake(['--hang']), await wd(), { timeoutMs: 300 }))
    .rejects.toThrow(/failed to start[\s\S]*fake mcp server up/)
})

test('close kills the server and every later call fails', async () => {
  const s = await startServers(fake(), await wd())
  expect(await s.call('echo', { text: 'x' })).toEqual({ output: 'echo: x', error: false })
  s.close()
  await new Promise(r => setTimeout(r, 200))
  expect(s.has('echo')).toBe(true)                 // the session still describes what it had
  expect((await s.call('echo', { text: 'y' })).error).toBe(true)
})

test('close kills a grandchild, not just the direct child', async () => {
  // A real server is a grandchild of npx; killing only the direct child would leak it.
  // The marker keeps this test from seeing fixtures started by other test files running
  // in parallel.
  //
  // The brief's `sh -c "fixture & wait"` doesn't reach this environment's shell: a
  // non-interactive `sh` (and `bash`, checked directly — this is not sh-specific)
  // substitutes /dev/null for a backgrounded job's stdin per POSIX 2.9.3.1, so the
  // fixture's readline hits EOF at once and it exits before `count()` ever runs — verified
  // by running that exact form standalone, where `startServers` rejects with "server
  // exited" instead of resolving. So the marked fixture's stdin here is a FIFO whose write
  // end this test holds open, keeping it blocked forever — the same shape its stdin has in
  // every other test in this file (an open pipe to `Conn` that never sends EOF). `sh` then
  // `exec`s into a second, unadorned fixture in its own place (same pid, real stdio) to be
  // the actual MCP server `Conn` talks to; the marked one is purely there to be leaked or
  // reaped as fs's grandchild. Confirmed this still isolates what it claims: with
  // `close()` temporarily changed to `process.kill(this.pid, ...)` (direct child only,
  // no leading `-`), the marked fixture survives — reparented to pid 1 — instead of dying.
  const marker = `lhb-grandchild-${process.pid}-${Date.now()}`
  const count = () => Number(execSync(`pgrep -f ${marker} | wc -l`).toString().trim())
  const dir = await wd()
  const fifo = join(dir, 'stdin.fifo')
  execSync(`mkfifo ${fifo}`)
  const keepOpen = openSync(fifo, 'r+')   // 'r+' never blocks on a FIFO, unlike 'r' or 'w' alone
  try {
    const s = await startServers(
      { fs: { command: 'sh', args: ['-c', `${process.execPath} ${FIXTURE} --marker=${marker} < ${fifo} & exec ${process.execPath} ${FIXTURE}`] } },
      await wd(), { timeoutMs: 2000 },   // happy path measured ~25ms; bounded so a stall fails inside vitest's 5s, not the module's 60s default
    )
    expect(count()).toBeGreaterThan(0)
    s.close()
    await new Promise(r => setTimeout(r, 300))
    expect(count()).toBe(0)
  } finally {
    closeSync(keepOpen)
  }
})

test('when the second server fails the first one is not left running', async () => {
  await expect(startServers(
    { a: fake().fs, b: { command: process.execPath, args: [FIXTURE, '--hang'] } },
    await wd(), { timeoutMs: 300 },
  )).rejects.toThrow(/mcp server "b" failed to start/)
  // If `a` were still alive its group would keep the event loop busy; vitest would hang here.
})

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Regression for a review finding: `die()` used to mark a timed-out connection dead without
// tearing it down, so the pid dropped out of procs.ts's registry (Ctrl-C's exit hook no longer
// covers it) while the child kept running. Reuses the "dies on its own" test's vi.doMock trick to
// get the pid, then checks the process itself, not just what got called.
test('a call that times out actually kills the server, not just marks it dead', async () => {
  const tracked: number[] = []
  vi.doMock('../src/core/procs.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/core/procs.js')>()
    return { track: (pid: number) => { tracked.push(pid); actual.track(pid) }, untrack: actual.untrack }
  })
  vi.resetModules()
  try {
    const { startServers: freshStartServers } = await import('../src/core/mcp.js')
    const s = await freshStartServers(fake(), await wd(), { timeoutMs: 300 })
    const pid = tracked[0]
    expect(pid).toBeTypeOf('number')
    expect(isAlive(pid)).toBe(true)

    const r = await s.call('stall', {})   // fixture never answers -> the call times out at 300ms
    expect(r.error).toBe(true)

    const deadline = Date.now() + 2000
    while (isAlive(pid) && Date.now() < deadline) await sleep(20)
    expect(isAlive(pid)).toBe(false)   // gone, not merely forgotten
  } finally {
    vi.doUnmock('../src/core/procs.js')
    vi.resetModules()
  }
})

// Regression for a review finding: the oversize-line guard used to die() without killing the
// group, so a server that kept flooding stdout kept the accumulator growing without bound. The
// fix's killGroup=true SIGKILLs the server the instant the guard trips, which both tears the
// connection down and (as a side effect) stops any further data from arriving — so the process
// actually being gone is what's externally observable here, the same shape as the timeout test.
// (A prior version of this test asserted bounded heap growth over a 1.5s window instead; a
// mutation check showed it passed even with the `if (this.dead) return` guard in onData deleted,
// because once killGroup SIGKILLs the child no more data arrives regardless — so it wasn't
// pinning what it claimed to. That guard stays in onData as defence-in-depth for data already
// queued in the pipe before the kill lands; it just isn't separately observable from outside once
// the kill happens, so this test doesn't try to reach it.)
test('the oversize-line guard trips and actually kills the server, not just marks it dead', async () => {
  const tracked: number[] = []
  vi.doMock('../src/core/procs.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/core/procs.js')>()
    return { track: (pid: number) => { tracked.push(pid); actual.track(pid) }, untrack: actual.untrack }
  })
  vi.resetModules()
  try {
    const { startServers: freshStartServers } = await import('../src/core/mcp.js')
    const s = await freshStartServers(fake(), await wd())
    const pid = tracked[0]
    expect(pid).toBeTypeOf('number')
    expect(isAlive(pid)).toBe(true)

    const r = await s.call('flood', {})
    expect(r.error).toBe(true)
    expect(r.output).toMatch(/over 1 MB/)

    const deadline = Date.now() + 2000
    while (isAlive(pid) && Date.now() < deadline) await sleep(20)
    expect(isAlive(pid)).toBe(false)   // gone, not merely forgotten
  } finally {
    vi.doUnmock('../src/core/procs.js')
    vi.resetModules()
  }
})
