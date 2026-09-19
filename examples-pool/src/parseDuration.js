/** parseDuration("1h30m15s"): the duration in seconds. Units are h, m and s; any of them may be missing. */
export function parseDuration(s) {
  const unit = { h: 3600, m: 3600, s: 1 }
  let total = 0
  for (const [, n, u] of s.matchAll(/(\d+)([hms])/g)) total += Number(n) * unit[u]
  return total
}
