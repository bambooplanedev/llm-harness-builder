// The numbers behind `evolve`: which tasks train, gate and test, the sign test, and the gate a candidate has to pass.
// Pure — no fs, no process — so every rule is a function of runs and can be tested without a model.
import { createHash } from 'node:crypto'
import type { RepoTask } from './repo-tasks.js'

export const ROUNDS = 3
export const CANDIDATES = 2
export const TOLERANCE = 0.10
export const CEILING = 0.25
export const MIN_TRAIN_GATE = 16
export const MIN_TEST = 8
export const ALPHA = 0.05
export const PARA_MAX = 600

export type SetName = 'train' | 'gate' | 'test'

/** A task's own `set` wins; the rest go by the first byte of sha1(name), so adding a task never moves another. */
export function splitSets(tasks: RepoTask[]): Record<SetName, string[]> {
  const out: Record<SetName, string[]> = { train: [], gate: [], test: [] }
  for (const t of tasks) {
    const b = createHash('sha1').update(t.name).digest()[0]! % 4
    out[t.set ?? (b < 2 ? 'train' : b === 2 ? 'gate' : 'test')].push(t.name)
  }
  return out
}

export type Mode = { strict: boolean; trainGate: number; test: number }

export function modeOf(sets: Record<SetName, string[]>): Mode | string {
  const [t, g, x] = [sets.train.length, sets.gate.length, sets.test.length]
  if (!t || !g || !x) return `evolve needs at least one task in each of train, gate and test (have ${t}/${g}/${x})`
  return { strict: t + g >= MIN_TRAIN_GATE && x >= MIN_TEST, trainGate: t + g, test: x }
}

/** The label a reference-mode result carries: too few tasks to tell a gain from luck. */
export const referenceLabel = (m: Mode): string =>
  `ОРІЄНТИР, НЕ ДОКАЗ — too few tasks (${m.trainGate + m.test} of ${MIN_TRAIN_GATE + MIN_TEST}) for a statistical conclusion; add ${Math.max(0, MIN_TRAIN_GATE - m.trainGate) + Math.max(0, MIN_TEST - m.test)} more tasks`

/** One-sided exact sign test: P(X >= b) for X ~ Binomial(b + c, 1/2). */
export function signP(b: number, c: number): number {
  const n = b + c
  let p = 0, term = 1 // C(n, 0)
  for (let k = 0; k <= n; k++) {
    if (k >= b) p += term
    term = term * (n - k) / (k + 1)
  }
  return p / 2 ** n
}

/** Flips in one direction and none back that the strict gate needs. */
export function neededFlips(): number {
  let b = 0
  while (signP(b, 0) >= ALPHA) b++
  return b
}

export type RunLite = { task: string; verdict: 'PASS' | 'FAIL'; tokens?: number; firstPromptTokens?: number; trace?: string; reason?: string; lastError?: string }
export type Numbers = { pass: number; tokensPerSuccess?: number; tokens?: number; weight?: number }

const sum = (runs: RunLite[], k: 'tokens' | 'firstPromptTokens'): number | undefined =>
  runs.every(r => r[k] !== undefined) ? runs.reduce((a, r) => a + r[k]!, 0) : undefined

export function numbersOf(runs: RunLite[]): Numbers {
  const pass = runs.filter(r => r.verdict === 'PASS').length
  const tokens = sum(runs, 'tokens')
  const n: Numbers = { pass }
  if (tokens !== undefined) { n.tokens = tokens; if (pass) n.tokensPerSuccess = tokens / pass }
  const weight = sum(runs, 'firstPromptTokens')
  if (weight !== undefined) n.weight = weight
  return n
}

const pct = (ratio: number) => Math.round((ratio - 1) * 100)

/** cur = the current version's runs, cand = the candidate's, orig = the original's, all on train + gate. */
export function decide(cur: RunLite[], cand: RunLite[], orig: RunLite[], gateNames: string[], mode: Mode): { accepted: boolean; reason: string; numbers: Numbers } {
  const numbers = numbersOf(cand)
  const no = (reason: string) => ({ accepted: false, reason, numbers })
  const o = numbersOf(orig)
  const usage = (rs: RunLite[]) => rs.every(r => r.tokens !== undefined && r.firstPromptTokens !== undefined)
  if (!usage(cand) || !usage(orig)) return no('the server gave no usage')
  if (!numbers.pass) return no('0 PASS')
  const c = numbersOf(cur)
  if (mode.strict) {
    const was = new Map(cur.map(r => [r.task, r.verdict]))
    let b = 0, w = 0
    for (const r of cand) {
      const v = was.get(r.task)
      if (v === 'FAIL' && r.verdict === 'PASS') b++
      else if (v === 'PASS' && r.verdict === 'FAIL') w++
    }
    const p = signP(b, w)
    if (!(p < ALPHA)) return no(`within noise (p=${p.toFixed(2)})`)
  } else if (numbers.pass <= c.pass) return no('fewer PASS than current')
  const gate = (rs: RunLite[]) => numbersOf(rs.filter(r => gateNames.includes(r.task))).pass
  if (gate(cand) < gate(cur)) return no('worse on gate')
  if (o.pass) {
    const r = numbers.tokensPerSuccess! / o.tokensPerSuccess!
    if (r > 1 + TOLERANCE) return no(`costs ${pct(r)}% more tokens per success than the original`)
  } else {
    const r = numbers.tokens! / o.tokens!
    if (r > 1 + TOLERANCE) return no(`costs ${pct(r)}% more tokens than the original`)
  }
  const wr = numbers.weight! / o.weight!
  if (wr > 1 + CEILING) return no(`first request ${pct(wr)}% heavier than the original`)
  return { accepted: true, reason: 'accepted', numbers }
}
