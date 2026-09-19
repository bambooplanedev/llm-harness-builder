/** parseDuration("1h30m15s"): the duration in seconds. Units are h, m and s; any of them may be missing. */
export function parseDuration(s) {
  let total = 0
  for (const [, n, u] of s.matchAll(/(\d+)([hms])/g)) {
    if (u === 'h') total += Number(n) * 3600
    if (u === 'm') total += Number(n) * 3600
    if (u === 's') total += Number(n)
  }
  return total
}
