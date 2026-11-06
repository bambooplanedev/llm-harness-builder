import { test, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConnections, pickConnection, stripTask } from '../src/core/proxy/connections.js'
import { tmpSync } from './helpers.js'

const CONNS = loadConnections()

test('the shipped files load: claude-code first, generic last', () => {
  expect(CONNS.map(c => c.name)).toEqual(['claude-code', 'generic'])
})

test('pickConnection: any one valid Claude Code header picks it', () => {
  const a = pickConnection(CONNS, { 'x-claude-code-request-class': 'compaction' })
  expect([a.conn.name, a.hints]).toEqual(['claude-code', { requestClass: 'compaction' }])
  const b = pickConnection(CONNS, {})
  expect([b.conn.name, b.hints]).toEqual(['generic', {}])
  expect(pickConnection(CONNS, { 'x-claude-code-session-id': 'x'.repeat(129) }).conn.name).toBe('generic')
})

test('stripTask removes closed and unclosed reminders', () => {
  const c = CONNS[1]
  expect(stripTask(c, 'fix it <system-reminder>a</system-reminder>')).toBe('fix it')
  expect(stripTask(c, 'fix it<system-reminder>secret')).toBe('fix it')
})

test('refusals', () => {
  const root = tmpSync('lhb-conns-')
  expect(() => loadConnections(join(root, 'nope'))).toThrow(/nope/)
  const empty = join(root, 'empty'); mkdirSync(empty)
  expect(() => loadConnections(empty)).toThrow(/empty/)
  const one = (dir: string, files: Record<string, object | string>) => {
    const d = join(root, dir); mkdirSync(d)
    for (const [f, v] of Object.entries(files)) writeFileSync(join(d, f), typeof v === 'string' ? v : JSON.stringify(v))
    return d
  }
  const fallback = { name: 'g', hints: {}, taskStrip: [] }
  expect(() => loadConnections(one('upper', { 'a.json': { name: 'a', hints: { session: 'Authorization' }, taskStrip: [] }, 'g.json': fallback }))).toThrow(/a\.json/)
  expect(() => loadConnections(one('key', { 'k.json': { name: 'k', hints: { session: 'x-api-key' }, taskStrip: [] }, 'g.json': fallback }))).toThrow(/k\.json/)
  expect(() => loadConnections(one('two', { 'g1.json': fallback, 'g2.json': fallback }))).toThrow(/two/)
  expect(() => loadConnections(one('bad', { 'b.json': '{', 'g.json': fallback }))).toThrow(/b\.json/)
  expect(() => loadConnections(one('short', { 's.json': { name: 's', hints: {} }, 'g.json': fallback }))).toThrow(/s\.json/)
})
