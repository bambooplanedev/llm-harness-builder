import type { HarnessConfig } from '../config.js'
import type { Backend } from './types.js'
import { OpenAIBackend } from './openai.js'
import { OllamaBackend } from './ollama.js'
export * from './types.js'

export function createBackend(b: HarnessConfig['backend']): Backend {
  return b.kind === 'ollama' ? new OllamaBackend(b.baseUrl) : new OpenAIBackend(b.baseUrl)
}
