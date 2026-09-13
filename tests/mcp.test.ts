import { test, expect } from 'vitest'
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
