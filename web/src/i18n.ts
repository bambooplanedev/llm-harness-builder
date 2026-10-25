import { ref, h, Fragment, defineComponent, type PropType, type VNodeChild } from 'vue'
import { autoApproves } from '../../src/core/bench'
import { uk } from './uk'

export type Lang = 'en' | 'uk'
export const LANGS: readonly Lang[] = ['en', 'uk']

/** The English catalog: the source of truth for keys and the fallback for anything `uk` lacks. */
export const en = {
  'lang.name': 'English',
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.close': 'Close',
  'app.pickModel': 'pick or type a model first',
  'app.noFolders': 'no folders here',
  'app.checkNote': 'runs node --test on the code the model wrote',
  'start.title': 'Start here',
  'start.example': 'Open an example run: {pass} and {fail} — no model needed.',
  'start.bench': 'Open the {bench}: the PASS table, intervals, ⇄ Diff.',
  'start.benchLink': 'example bench',
  'start.run': 'Pick a model on the left, then Create demo project → Run.',
  'bench.killed': '{msg} — if the run was killed, runs/{id}.jsonl.part is left behind; rename it to .jsonl',
  'bench.comparedRun': '{msg} — the compared run',
  'bench.againConfirm': 'Run this bench again: the same harnesses, task, n and timeout, into a new JSON.',
  'bench.autoApproves': autoApproves('bench'),
  'bench.exampleNote': 'a recorded bench shipped with the package: read-only, no model needed',
  'bench.stopTitle': 'SIGINT, like Ctrl-C: the finished runs stay in the JSON; can take up to a minute',
  'bench.empty': 'no benches yet: run {cmd} or New bench, or open the {examples}',
  'bench.emptyRuns': 'this page reads only {runs} — a bench written with {out} elsewhere will not show up here',
  'bench.round1': 'round 1 still running, no results yet',
  'bench.redTests': 'the model answered, tests are red',
  'bench.noTrace': 'no trace written (JSON predates v2.0.3)',
  'bench.compareTitle': 'compare with the open run',
  'bench.fromHarnesses': 'from ./harnesses',
  'bench.runsUnasked': 'runs unasked · {cmd}',
  'bench.modelFrom': "the Workbench form's: {model}",
  'bench.wilsonNote': '95% interval = Wilson interval of the PASS rate; two harnesses whose intervals overlap are not told apart by this bench.',
  'form.ollamaV1': 'Ollama via /v1 ignores num_ctx and silently truncates the prompt. Pick kind "ollama".',
  'form.refreshKey': 'press ↻ to list the models: that request carries the key',
  'form.locked': '{knobs}: this knob is not available for this model',
  'form.familyNone': 'nothing to change, the form already matches it',
  'form.bashEnv': 'bash gets from your environment: {list}',
  'trace.askMcp': 'start mcp server {name}: {cmd}?',
  'trace.askUntil': 'run {cmd} each time the model says it is done, on files the model has written?',
  'trace.askRun': 'run {cmd}?',
  'trace.autoApproved': 'bench: auto-approved',
  'trace.checkFailed': 'failed, the run goes on',
  'trace.quit': 'final after 0 tool calls: the model quit without doing anything',
  'diff.closeTitle': 'close the comparison',
  'diff.samePath': 'same path all the way — but identical steps do not mean identical words',
  'diff.split': '{at} · click a turn to read both sides',
  'diff.splitAt': 'paths split at t{n}',
  'diff.noEvents': "one side's events have not loaded — nothing to draw the path from",
}
export type Key = keyof typeof en

const catalog: Record<Lang, Partial<Record<Key, string>>> = { en, uk }
/** Starts at English whatever the browser says: main.ts sets the real one, so tests render English. */
export const lang = ref<Lang>('en')

/** A stored en/uk wins; anything else follows the browser. */
export function initialLang(stored: string | null | undefined, navigatorLanguage: string | undefined): Lang {
  if (stored === 'en' || stored === 'uk') return stored
  return navigatorLanguage?.toLowerCase().startsWith('uk') ? 'uk' : 'en'
}
export function readLang(storage?: Pick<Storage, 'getItem'>): string | null {
  try { return (storage ?? localStorage).getItem('lhb.lang') } catch { return null }
}
export function setLang(l: Lang, storage?: Pick<Storage, 'setItem'>): void {
  lang.value = l
  try { (storage ?? localStorage).setItem('lhb.lang', l) } catch { /* private window: the choice lasts until reload */ }
}
export function t(key: Key, params?: Record<string, string | number>): string {
  const s = catalog[lang.value][key] ?? en[key]
  return params ? s.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m)) : s
}
export const langName = (l: Lang): string => catalog[l]['lang.name'] ?? en['lang.name']

/** `t(k)` with each `{name}` filled by the slot of that name (markup stays in the template) or else by `p`. Text and vnodes only, never HTML. */
export const T = defineComponent({
  props: { k: { type: String as PropType<Key>, required: true }, p: Object as PropType<Record<string, string | number>> },
  setup: (props, { slots }) => () => h(Fragment, t(props.k).split(/\{(\w+)\}/).flatMap<VNodeChild>((s, i) =>
    i % 2 ? [slots[s]?.() ?? String(props.p?.[s] ?? `{${s}}`)] : s ? [s] : [])),
})
