// src/core/proxy/dialects/index.ts — the formats the proxy records, tried in order by route.
import type { Dialect } from './dialect.js'
import { openaiChat } from './openai-chat.js'
import { anthropic } from './anthropic.js'

export { openaiChat, anthropic }
export const DIALECTS: readonly Dialect[] = [openaiChat, anthropic]
