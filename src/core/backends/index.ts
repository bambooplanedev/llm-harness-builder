import { apiKey, isHttpUrl, keyErrors, keyProblem, type HarnessConfig } from '../config.js'
import { defaultFetch, type Backend } from './types.js'
import { OpenAIBackend } from './openai.js'
import { OllamaBackend } from './ollama.js'
export * from './types.js'

/** `env`: where the variable `backend.apiKeyEnv` names is read. Every caller asks keyProblem first and refuses with its
 *  own words, so a missing value here is a bug, not a user's mistake. */
export function createBackend(b: HarnessConfig['backend'], env: NodeJS.ProcessEnv = process.env): Backend {
  if (b.kind === 'ollama') return new OllamaBackend(b.baseUrl)
  if (b.kind === 'anthropic' && b.apiKeyEnv === undefined) throw new Error('backend.kind anthropic needs backend.apiKeyEnv')
  if (b.apiKeyEnv === undefined) return new OpenAIBackend(b.baseUrl)
  // A safety net: every caller validates first, but a key must never go out over a URL the rules refuse.
  const refused = isHttpUrl(b.baseUrl) ? keyErrors(b) : ['backend.baseUrl must be an http(s) URL']
  if (refused.length) throw new Error(refused[0])
  const key = apiKey(b, env)
  if (!key) throw new Error(`backend.apiKeyEnv: ${keyProblem(b, env)}`)
  if (b.kind === 'anthropic') throw new Error('backend.kind anthropic: not implemented yet')
  return new OpenAIBackend(b.baseUrl, defaultFetch, key)
}
