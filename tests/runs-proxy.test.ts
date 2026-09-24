import { test, expect } from 'vitest'
import { writeFile, readFile, appendFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { RunStore, TraceWriter } from '../src/server/runs.js'
import { startServer } from '../src/server/index.js'
import { tmp } from './helpers.js'

const deadPid = spawnSync(process.execPath, ['-e', '0']).pid!
const proxyRun = (dir: string, id: string, pid: number) => writeFile(join(dir, `${id}.jsonl`), [
  { meta: { id, harness: 'oc', task: 't', workdir: '', started: 1, proxy: { upstream: 'http://u', pid } } },
  { seq: 0, turn: 1, ts: 1, type: 'llm_request', payload: {} },
].map(l => JSON.stringify(l) + '\n').join(''))

test('ensureDone leaves a proxy run alone while its proxy lives, and repairs it once the proxy is gone', async () => {
  const dir = await tmp('lhb-runs-')
  await proxyRun(dir, 'live0001', process.pid); await proxyRun(dir, 'dead0001', deadPid)
  const store = new RunStore(dir)
  expect(await store.ensureDone('live0001')).toBeNull()
  expect(await readFile(join(dir, 'live0001.jsonl'), 'utf8')).not.toContain('"done"')
  expect(await store.ensureDone('dead0001')).toMatchObject({ type: 'done', reason: 'aborted', seq: 1 })
})

test('TraceWriter takes its id from the caller', async () => {
  const dir = await tmp('lhb-runs-')
  const w = new TraceWriter(dir, false, 'abcd1234')
  await w.open({ harness: 'h', task: 't', workdir: '', started: 1, proxy: { upstream: 'http://u', pid: 1 } })
  const meta = JSON.parse((await readFile(join(dir, 'abcd1234.jsonl'), 'utf8')).split('\n')[0]).meta
  expect(meta).toMatchObject({ id: 'abcd1234', proxy: { upstream: 'http://u', pid: 1 } })
})

test('the events stream of a live proxy run ends without done, and a reconnect sends only newer events', async () => {
  const dir = await tmp('lhb-runs-'), hd = await tmp('lhb-h-')
  await proxyRun(dir, 'live0002', process.pid)
  const srv = await startServer({ port: 0, runsDir: dir, harnessesDir: hd })
  try {
    const url = `http://127.0.0.1:${srv.port}/api/runs/live0002/events`
    const first = await (await fetch(url)).text()
    expect(first).toContain('"llm_request"'); expect(first).not.toContain('"done"')
    await appendFile(join(dir, 'live0002.jsonl'), JSON.stringify({ seq: 1, turn: 1, ts: 2, type: 'llm_response', raw: {}, content: 'x', latencyMs: 1 }) + '\n')
    const again = await (await fetch(url, { headers: { 'last-event-id': '0' } })).text()
    expect(again).not.toContain('"llm_request"'); expect(again).toContain('"llm_response"')
    expect(await readFile(join(dir, 'live0002.jsonl'), 'utf8')).not.toContain('"done"')
  } finally { srv.close() }
})
