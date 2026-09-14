// Shared test fixtures. Not a *.test.ts, so vitest does not collect it: importing one test file
// from another re-registers its tests, which is why these used to be copied per file instead.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessConfig } from '../src/core/config.js'
import type { Backend, ChatRequest, Delta, NormalizedResponse } from '../src/core/backends/types.js'

/** A fresh empty directory under the OS temp dir. */
export const tmp = (prefix: string) => mkdtemp(join(tmpdir(), prefix))

/** A valid HarnessConfig; `over` replaces whole top-level sections. One definition, so a new required field breaks one place. */
export const harness = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  name: 'h',
  backend: { kind: 'openai', baseUrl: 'http://x/v1', model: 'fake-model', temperature: 0 },
  systemPrompt: 'sys',
  tools: { enabled: ['read_file', 'bash'], approveBash: false },
  toolCalls: { mode: 'native', enforceSchema: false, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' },
  context: { maxToolOutputChars: 4000, budgetTokens: 0 },
  loop: { maxTurns: 5 },
  ...over,
})

/**
 * One scripted backend response. Everything a real NormalizedResponse has is optional and defaulted;
 * `deltas` are streamed through onDelta first, and `wait` holds send() until it settles — that is how
 * a test keeps a run open until its SSE client has connected.
 */
export type FakeResponse = Partial<NormalizedResponse> & { deltas?: Delta[]; wait?: Promise<unknown> }

export type FakeBackend = Backend & { requests: ChatRequest[] }

/** A backend that plays `queue` in order and records every request it was asked to build. */
export function fakeBackend(queue: FakeResponse[]): FakeBackend {
  const requests: ChatRequest[] = []
  return {
    requests,
    async listModels() { return ['fake-model'] },
    buildPayload(req: ChatRequest) { requests.push(structuredClone(req)); return req },
    async send(_payload, _signal, onDelta) {
      const r = queue.shift()
      if (!r) throw new Error('fake backend: no more responses')
      const { deltas, wait, ...rest } = r
      if (wait) await wait
      for (const d of deltas ?? []) onDelta?.(d)
      return { content: '', toolCalls: [], raw: {}, ...rest }
    },
  }
}
