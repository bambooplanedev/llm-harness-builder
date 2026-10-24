import type { Usage } from './backends/types.js'
import type { Price } from './config.js'

/** Dollars for one reply, or none when there is no usage or no price. Cached tokens are part of promptTokens, so they
 *  leave the plain-input term (never below 0 for a usage that does not add up) and bill at their own price, else input's. */
export function costOf(usage: Usage | undefined, price: Price | undefined): number | undefined {
  if (!usage || !price) return undefined
  const read = usage.cacheReadTokens ?? 0, write = usage.cacheWriteTokens ?? 0
  return (Math.max(0, usage.promptTokens - read - write) * price.input + read * (price.cacheRead ?? price.input)
    + write * (price.cacheWrite ?? price.input) + usage.completionTokens * price.output) / 1e6
}
