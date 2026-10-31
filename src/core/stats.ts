// src/core/stats.ts — seeded permutation tests shared by evolve and the Bench tab. No fs, no process.
export type Stratum = { a: number[]; b: number[] }
export const PERMS = 20000
export const SEED = 20261031
const EPS = 1e-12 // float sums of the same numbers in another order differ in the last bits

// mulberry32: tiny seeded PRNG, so the same input gives the same p on every machine
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const sum = (x: number[]) => x.reduce((s, v) => s + v, 0)
export const mean = (xs: number[]) => sum(xs) / xs.length
/** `value(r)` per key, in row order; a row it answers undefined for is left out. */
export function groupBy<R, T>(rows: R[], key: (r: R) => string, value: (r: R) => T | undefined): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of rows) { const v = value(r); if (v !== undefined) m.set(key(r), [...m.get(key(r)) ?? [], v]) }
  return m
}
const hit = (t: number, obs: number, side: 'greater' | 'two') => side === 'two' ? Math.abs(t) >= Math.abs(obs) - EPS : t >= obs - EPS

/** Stratified permutation test of sum over strata of mean(b) - mean(a): labels are shuffled inside each stratum only. */
export function permP(strata: Stratum[], side: 'greater' | 'two', seed = SEED): { p: number; perms: number; exact: boolean } {
  const ss = strata.filter(s => new Set([...s.a, ...s.b]).size > 1) // a constant stratum has the same statistic under every labelling
  const stat = (s: Stratum, bs: number) => bs / s.b.length - (sum(s.a) + sum(s.b) - bs) / s.a.length
  const obs = sum(ss.map(s => stat(s, sum(s.b))))
  let total = 1
  for (const s of ss) {
    const n = s.a.length + s.b.length, k = s.b.length
    let c = 1
    for (let i = 1; i <= Math.min(k, n - k); i++) c = c * (n - i + 1) / i
    total *= Math.round(c)
    if (total > PERMS) break
  }
  let hits = 0
  if (total <= PERMS) {
    // every way to pick which values of each stratum are labelled b
    const go = (i: number, t: number): void => {
      if (i === ss.length) { if (hit(t, obs, side)) hits++; return }
      const pool = [...ss[i].a, ...ss[i].b], k = ss[i].b.length
      const pick = (from: number, left: number, bs: number): void => {
        if (left === 0) return go(i + 1, t + stat(ss[i], bs))
        for (let j = from; j <= pool.length - left; j++) pick(j + 1, left - 1, bs + pool[j])
      }
      pick(0, k, 0)
    }
    go(0, 0)
    return { p: hits / total, perms: total, exact: true }
  }
  const rand = rng(seed)
  const pools = ss.map(s => [...s.a, ...s.b])
  for (let r = 0; r < PERMS; r++) {
    let t = 0
    ss.forEach((s, i) => {
      const pool = pools[i]
      for (let j = pool.length - 1; j > 0; j--) { const m = Math.floor(rand() * (j + 1)); [pool[j], pool[m]] = [pool[m], pool[j]] }
      t += stat(s, sum(pool.slice(0, s.b.length)))
    })
    if (hit(t, obs, side)) hits++
  }
  return { p: (hits + 1) / (PERMS + 1), perms: PERMS, exact: false }
}

/** One-sided paired test: P(mean of randomly signed diffs >= the observed mean). Exact up to 2^14 patterns. */
export function signFlipP(diffs: number[], seed = SEED): number {
  const n = diffs.length, obs = sum(diffs)
  if (n <= 14) {
    let hits = 0
    for (let m = 0; m < 1 << n; m++) {
      let t = 0
      for (let i = 0; i < n; i++) t += m & (1 << i) ? diffs[i] : -diffs[i]
      if (t >= obs - EPS) hits++
    }
    return hits / (1 << n)
  }
  const rand = rng(seed)
  let hits = 0
  for (let r = 0; r < PERMS; r++) {
    let t = 0
    for (const d of diffs) t += rand() < 0.5 ? d : -d
    if (t >= obs - EPS) hits++
  }
  return (hits + 1) / (PERMS + 1)
}

const Z = 1.644854 + 0.841621 // one-sided ALPHA 0.05 (evolve's), power 0.8

/** The smallest gain in tasks a mode tells from noise, by normal approximation: two arms of N tasks × R repeats, each run of variance p(1−p).
 *  R = 1 gives no within-task variance, so p(1−p) stands in for it: an upper bound. */
export function smallestGain(probe: number, repeats: number, tasks: number): { tasks: number; bound: boolean } {
  const rate = Z * Math.sqrt(2 * probe * (1 - probe) / (tasks * repeats))
  return { tasks: Math.max(1, Math.ceil(rate * tasks)), bound: repeats === 1 }
}
