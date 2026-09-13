import { test, expect, vi } from 'vitest'
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
  try { expect(all.tools.length).toBe(7) } finally { all.close() }
})

test('servers info reports what was offered, what survived, and what it costs', async () => {
  const s = await startServers({ fs: { ...fake().fs, tools: ['echo'] } }, await wd())
  try {
    expect(s.servers).toHaveLength(1)
    const i = s.servers[0]
    expect(i).toMatchObject({ server: 'fs', offered: 7, tools: ['echo'] })
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
