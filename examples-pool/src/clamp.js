/** clamp(x, lo, hi): x limited to the range [lo, hi]. */
export function clamp(x, lo, hi) {
  return Math.min(Math.max(x, hi), lo)
}
