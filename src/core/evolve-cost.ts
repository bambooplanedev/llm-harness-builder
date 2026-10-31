// The cost rule of `evolve`: a candidate may cost a little more than the base, but not past the noise.
// Pure — no fs, no process — so the Bench tab can import it. RunLite is a type-only import: no cycle with evolve.ts.
import type { RunLite } from './evolve.js'
import { signFlipP } from './stats.js'

export const MIN_SHARED = 5 // fewer shared tasks say nothing about cost
export const COST_ALPHA = 0.10 // looser than the win test: a dear candidate is refused on weaker evidence
export type Cost = 'turns' | 'tokens' | 'time'
export type CostCheck = { shared: number; before: number; after: number; allowed: number; ratio: number; p: number; over: boolean }

/** Turns: +20% up to 10 (at least +1), +10% beyond (at least +2). */
export const allowedTurns = (base: number): number => base <= 10 ? Math.max(base * 1.2, base + 1) : Math.max(base * 1.1, base + 2)
export const allowedTenth = (base: number): number => base * 1.1

const read = (r: RunLite, cost: Cost) => cost === 'turns' ? r.turns : cost === 'tokens' ? r.tokens : r.modelMs
const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length

/** Per task, the mean of its eligible runs: passes with the metric (the candidate's also within the old turn cap). */
function perTask(runs: RunLite[], cost: Cost, cap: number): Map<string, number> {
  const by = new Map<string, number[]>()
  for (const r of runs) {
    const v = read(r, cost)
    // A candidate pass past the old cap is a new win, not a dearer harness; a run without the metric has no cost.
    if (r.verdict !== 'PASS' || v === undefined || (r.turns ?? 0) > cap) continue
    by.set(r.task, [...(by.get(r.task) ?? []), v])
  }
  return new Map([...by].map(([t, vs]) => [t, mean(vs)]))
}

export function costCheck(base: RunLite[], cand: RunLite[], cost: Cost, baseMaxTurns: number): CostCheck | undefined {
  const b = perTask(base, cost, Infinity), c = perTask(cand, cost, baseMaxTurns)
  const tasks = [...b.keys()].filter(t => c.has(t) && b.get(t)! > 0 && c.get(t)! > 0)
  if (tasks.length < MIN_SHARED) return undefined
  const before = mean(tasks.map(t => b.get(t)!)), after = mean(tasks.map(t => c.get(t)!))
  const logs = tasks.map(t => Math.log(c.get(t)! / b.get(t)!))
  const ratio = Math.exp(mean(logs))
  const allowed = cost === 'turns' ? allowedTurns(before) : allowedTenth(before)
  const tol = allowed / before
  const p = signFlipP(logs.map(l => l - Math.log(tol)))
  // The bound is inclusive (float dust aside), and over needs the noise test too.
  return { shared: tasks.length, before, after, allowed, ratio, p, over: ratio > tol + 1e-9 && p < COST_ALPHA }
}

export const costReason = (c: CostCheck, cost: Cost): string => {
  const f = (x: number) => cost === 'turns' ? x.toFixed(1) : cost === 'tokens' ? String(Math.round(x)) : (x / 1000).toFixed(1) + 's'
  return `${cost} ${f(c.before)} → ${f(c.after)}, allowed up to ${f(c.allowed)} (p=${c.p.toFixed(2)})`
}
