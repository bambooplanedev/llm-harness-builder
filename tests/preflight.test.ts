import { test, expect } from 'vitest'
import { preflight, windowWarning } from '../src/core/preflight'
import { BackendError, type Backend, type ServerInfo } from '../src/core/backends/types'
import { harness } from './helpers'

const be = (models: string[] | Error, info?: ServerInfo): Backend => ({
  async listModels() { if (models instanceof Error) throw models; return models },
  buildPayload: r => r,
  async send() { throw new Error('preflight must not generate') },
  ...(info !== undefined ? { async serverInfo() { return info } } : {}),
})
const openai = (model = 'm') => ({ ...harness().backend, baseUrl: 'http://127.0.0.1:8080/v1', model })
const ollama = (model: string, numCtx?: number) => ({ kind: 'ollama' as const, baseUrl: 'http://localhost:11434', model, temperature: 0, ...(numCtx ? { numCtx } : {}) })

test('a server that does not answer fails with the url and the error, before any generation', async () => {
  const r = await preflight(be(new Error('fetch failed')), openai())
  expect(r).toEqual({ ok: false, message: 'preflight: http://127.0.0.1:8080/v1 (openai) does not answer: fetch failed' })
  const b = await preflight(be(new BackendError('GET /models: 404', 'Not Found')), openai())
  expect(b.ok).toBe(false); expect(!b.ok && b.message).toContain('GET /models: 404')
})

test('ollama: the model has to be pulled; a name without a tag is :latest', async () => {
  expect(await preflight(be(['qwen3:8b', 'gemma3:latest']), ollama('qwen3:14b'))).toEqual({
    ok: false, message: 'preflight: model qwen3:14b is not on http://localhost:11434 (ollama); it has: qwen3:8b, gemma3:latest',
  })
  expect(await preflight(be(['qwen3:8b', 'gemma3:latest']), ollama('gemma3'))).toMatchObject({ ok: true })
  expect(await preflight(be(['qwen3:8b']), ollama('qwen3:8b', 8192))).toEqual({ ok: true, server: { nCtx: 8192 } })
  // no numCtx: Ollama's own default holds, and the harness does not know it
  expect(await preflight(be(['qwen3:8b']), ollama('qwen3:8b'))).toEqual({ ok: true, server: {} })
})

test('openai: one-model llama-server ignores the model name, a router does not', async () => {
  expect(await preflight(be(['unsloth/Qwen3-8B-GGUF:Q4_K_M'], { nCtx: 4096, build: 'b1', router: false }), openai('qwen3:8b')))
    .toEqual({ ok: true, server: { nCtx: 4096, build: 'b1' } })
  const miss = await preflight(be(['a', 'b'], { build: 'b1', router: true }), openai('c'))
  expect(miss).toEqual({ ok: false, message: 'preflight: model c is not on http://127.0.0.1:8080/v1 (openai); it has: a, b' })
  expect(await preflight(be(['a', 'c'], { nCtx: 40960, build: 'b1', router: true }), openai('c'))).toEqual({ ok: true, server: { nCtx: 40960, build: 'b1' } })
  // no /props at all (LM Studio, vLLM): window unknown, no model check
  expect(await preflight(be(['x'], undefined), openai('m'))).toEqual({ ok: true, server: {} })
})

test('windowWarning: budget plus response cap over the window; nothing when either is unknown or the budget is off', () => {
  const c = (budgetTokens: number, maxTokens?: number) => harness({ context: { maxToolOutputChars: 4000, budgetTokens }, backend: { ...harness().backend, ...(maxTokens ? { maxTokens } : {}) } })
  expect(windowWarning(c(2670, 1024), 5120)).toBeUndefined()
  expect(windowWarning(c(4500, 1024), 5120)).toBe('warning: h: budgetTokens 4500 + maxTokens 1024 = 5524 is over the server window 5120; the budget cannot hold the window')
  expect(windowWarning(c(6000), 5120)).toBe('warning: h: budgetTokens 6000 is over the server window 5120; the budget cannot hold the window')
  expect(windowWarning(c(0, 1024), 512)).toBeUndefined()
  expect(windowWarning(c(6000), undefined)).toBeUndefined()
})
