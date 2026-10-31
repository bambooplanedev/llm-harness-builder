<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { api, type ActiveTrace, type AnalysisCells, type BenchFile, type BenchHarness, type BenchResult, type BenchRun, type HarnessConfig, type HarnessEvent } from './api'
import { cellsLine } from '../../src/core/analyze'
import { formatTable, wideCells, WIDE_HEAD, pCells, P_HEAD, rowNames, benchModels, mmss, wilson, benchTotal, runTitle, BENCH_TASKS, defaultSize } from '../../src/core/bench'
import Trace from './Trace.vue'
import { t, tn, T, lang } from './i18n'
import Diff from './Diff.vue'
import type { DiffSide } from '../../src/core/diff'
import { shown } from './film'

const emit = defineEmits<{ toWorkbench: [config: HarnessConfig, workdir: string]; example: [on: boolean] }>()
/** The Workbench form's model: New bench always runs on it. `example`: the shipped recorded bench, read-only — its backend is not yours. */
const props = defineProps<{ backend: HarnessConfig['backend']; example: boolean }>()

const files = ref<BenchFile[]>([])
const file = ref('')
const result = ref<BenchResult | null>(null)
const analysis = ref<Record<string, AnalysisCells>>({})
const active = ref<ActiveTrace | null>(null)
const events = ref<HarnessEvent[]>([])
/** 'live' follows the running trace; { id } pins the panel to one finished run (SSE). */
const sel = ref<'live' | { id: string }>('live')
const error = ref('')
const now = ref(Date.now())
const pane = ref<HTMLElement | null>(null)
let unsub: (() => void) | null = null

/** Side B of the comparison: side A is whatever `sel` has open. */
const diff = ref<{ name: string; run: BenchRun; config: HarnessConfig } | null>(null)
const diffEvents = ref<HarnessEvent[]>([])
let diffUnsub: (() => void) | null = null

const TITLE = 'llm-harness-builder'
/** An SSE stream that never opens usually means a killed run: its trace is still a .part file. */
const killedHint = (msg: string, id: string) => t('bench.killed', { msg, id })

function compare(name: string, run: BenchRun, config: HarnessConfig) {
  diffUnsub?.(); diffEvents.value = []
  diff.value = { name, run, config }
  diffUnsub = api.events(run.trace!, e => diffEvents.value.push(e),
    m => (error.value = killedHint(t('bench.comparedRun', { msg: m }), run.trace!)), undefined, props.example)
}
function closeDiff() { diffUnsub?.(); diffUnsub = null; diff.value = null; diffEvents.value = [] }

let gen = 0
let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false
/** Set by the tick's own catch; only the tick clears its own failure, never an SSE error it did not cause. */
let fetchFailed = false

const runs = computed(() => result.value?.harnesses.flatMap(h => h.runs) ?? [])
/** A is the open run: its row in the JSON carries the verdict, its harness carries the config. */
const sideA = computed<DiffSide | null>(() => {
  if (sel.value === 'live' || !result.value) return null
  const id = sel.value.id
  for (const [i, h] of result.value.harnesses.entries()) {
    const run = h.runs.find(r => r.trace === id)
    if (run) return { name: labels.value[i], run, config: h.config, events: events.value }
  }
  return null
})
const sideB = computed<DiffSide | null>(() => diff.value && { ...diff.value, events: diffEvents.value })
const total = computed(() => result.value ? benchTotal(result.value) : 0)
const msDone = computed(() => runs.value.reduce((a, r) => a + r.ms, 0))
const backend = computed(() => result.value?.harnesses[0].config.backend)
const modelsLine = computed(() => result.value ? benchModels(result.value.harnesses).join(', ') : '')
/** Film mode hides every model and server the page names. */
const names = computed(() => {
  const be = [props.backend, ...result.value?.harnesses.map(h => h.config.backend) ?? []]
  return { models: [...files.value.flatMap(f => f.model), ...be.map(b => b.model)].filter(Boolean), urls: be.map(b => b.baseUrl) }
})
const nCtx = computed(() => result.value?.harnesses.find(h => h.server?.nCtx)?.server?.nCtx)
const hasCost = computed(() => runs.value.some(r => r.costUsd !== undefined))
/** The harness of the open run: its row in the table is marked. */
const openHarness = computed(() => sideA.value?.name)
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const ci = (pass: number, n: number) => wilson(pass, n) ?? [0, 0]
/** PASS ends green, a run that ran into a wall red, the rest (turns, loop, abort) amber. */
const reasonTone = (r: string) => r === 'final' ? 'ok' : r.endsWith('error') ? 'err' : 'warn'
/** The biggest prompt + reply of any run: the one that came closest to the window. */
const hasPeak = computed(() => runs.value.some(r => r.peakTokens !== undefined))
const peak = (h: BenchHarness) => Math.max(0, ...h.runs.map(r => r.peakTokens ?? 0)) || undefined
const starting = ref(false)
async function again() {
  if (!confirm(`${t('bench.againConfirm')}\n\n${t('bench.autoApproves')}.`)) return
  await start(() => api.benchAgain(file.value))
}
/** The bench JSON this server started, while it runs (from every tick, so a reload keeps it): Stop bench shows for it. */
const own = ref('')
const stopping = ref(false)
async function start(call: () => Promise<{ file: string }>) {
  starting.value = true; error.value = ''
  try { const f = (await call()).file; own.value = f; openFile(f); return true }
  catch (e) { error.value = (e as Error).message; return false }
  finally { starting.value = false }
}
async function stop() {
  stopping.value = true; error.value = ''
  try { await api.benchStop() } catch (e) { error.value = (e as Error).message; stopping.value = false }
  restart()
}
watch(() => !starting.value && !own.value, idle => { if (idle) stopping.value = false })

/** New bench: harnesses from ./harnesses, the model from the Workbench form, nothing else from anywhere. */
const newOpen = ref(false)
const list = ref<{ name: string; description?: string }[]>([])
const picked = ref<string[]>([])
/** What each picked harness runs without asking, besides the model's commands. */
const runsUnasked = ref<Record<string, string[]>>({})
const task = ref('slug')
const size = ref(0)
const runsPer = ref(3)
watch(task, t => { size.value = defaultSize(t) })
async function toggleNew() {
  newOpen.value = !newOpen.value
  if (!newOpen.value) return
  // Read afresh on every open: a harness file edited since may run something else unasked now.
  runsUnasked.value = {}
  try { list.value = await api.harnesses() } catch (e) { error.value = (e as Error).message; return }
  picked.value = picked.value.filter(n => list.value.some(h => h.name === n))
  await loadUnasked(picked.value)
}
async function loadUnasked(names: string[]) {
  for (const n of names) if (!runsUnasked.value[n]) {
    try {
      const c = await api.harness(n)
      runsUnasked.value[n] = [...Object.entries(c.mcpServers ?? {}).map(([k, m]) => `mcpServers.${k}: ${[m.command, ...m.args ?? []].join(' ')}`),
        ...c.loop?.untilBash ? [`loop.untilBash: ${c.loop.untilBash}`] : []]
    } catch (e) { error.value = (e as Error).message }
  }
}
watch(picked, loadUnasked)
async function startNew() {
  const b = props.backend
  const ok = await start(() => api.benchNew({ harnesses: picked.value, task: task.value, ...BENCH_TASKS[task.value] ? { size: size.value } : {}, n: runsPer.value,
    backend: { kind: b.kind, baseUrl: b.baseUrl, model: b.model, ...b.apiKeyEnv ? { apiKeyEnv: b.apiKeyEnv } : {} } }))
  if (ok) newOpen.value = false
}
// Per-success costs against the first harness on the same model (the same rule as evolve) and the tool-use means; '-' where a run did not report.
// p is up to 20000 shuffles per number per harness, and a poll hands over a new result every two seconds: it is redone only when a run came in or the file changed.
let pKey = '', pMemo: string[][] = []
const wide = computed(() => {
  const hs = result.value?.harnesses ?? [], key = `${result.value?.date}/${runs.value.length}`
  if (key !== pKey) { pMemo = pCells(hs); pKey = key }
  return wideCells(hs).map((c, i) => [...c, ...pMemo[i]])
})
/** A row's name: with --models the same harness name stands on several models, so the model is part of it (and of every key). */
const labels = computed(() => result.value ? rowNames(result.value.harnesses) : [])
const medCost = (h: BenchHarness) => { const c = h.runs.flatMap(r => r.costUsd ?? []).sort((a, b) => a - b); return c.length ? `$${Number(c[(c.length - 1) >> 1].toPrecision(3))}` : '-' }

/**
 * One poll. A setTimeout chain, not setInterval: a tick reads the whole .part and every bench JSON,
 * and an overlapping pair of responses arriving out of order would rewind the trace. `gen` covers the
 * other three races at once — switching file, switching tab, unmount.
 */
async function tick() {
  const my = ++gen
  try {
    const r = await api.bench(file.value || undefined, props.example)
    if (my !== gen || stopped) return
    files.value = r.files
    own.value = r.own ?? ''
    now.value = Date.now()
    if (file.value) {
      result.value = r.result ?? null
      analysis.value = r.analysis ?? {}
      const prev = active.value?.id
      active.value = r.active ?? null // always tracks reality; only `events` freezes below
      if (sel.value === 'live') {
        // The run we were watching just ended: freeze the panel on it. `{ id }` is the ordinary SSE
        // path, so its tail — llm_response and done — is read in for free, and from here on the tick
        // no longer touches `events`. Never clear on a missing `active`: between rounds it is normal.
        if (prev && r.active?.id !== prev) sel.value = { id: prev }
        else if (r.active) events.value = r.active.events
      }
    }
    if (fetchFailed) { fetchFailed = false; error.value = '' }
  } catch (e) {
    if (my === gen) { fetchFailed = true; error.value = (e as Error).message }
  } finally {
    if (!stopped && my === gen) timer = setTimeout(tick, 2000)
  }
}

function restart() { if (timer) clearTimeout(timer); timer = null; void tick() }

function openFile(f: string) {
  closeDiff()
  file.value = f; sel.value = 'live'; result.value = null; analysis.value = {}; active.value = null; events.value = []
  unsub?.(); unsub = null
  restart()
}

watch(sel, s => {
  closeDiff()
  unsub?.(); unsub = null
  error.value = ''
  if (s === 'live') { events.value = active.value?.events ?? [] ; return }
  events.value = []
  unsub = api.events(s.id, e => events.value.push(e),
    m => (error.value = killedHint(m, s.id)), undefined, props.example)
})

const age = computed(() => active.value ? now.value - active.value.started : 0)
const silence = computed(() => active.value ? now.value - (active.value.events.at(-1)?.ts ?? active.value.started) : 0)

// A bench run takes up to 30 minutes: without this, "live" means "scroll it yourself".
watch(() => events.value.length, async () => {
  const el = pane.value
  if (!el || el.scrollHeight - el.scrollTop - el.clientHeight > 80) return // measured before the patch: flush is 'pre'
  await nextTick()
  el.scrollTop = el.scrollHeight
})

// Show progress in the browser tab title; reset on unmount handled by existing onUnmounted.
watch([runs, total, () => result.value?.complete], () => {
  document.title = result.value ? `${runs.value.length}/${total.value}${result.value.complete ? ' done' : ''} · bench` : TITLE
})

onMounted(() => props.example ? openFile('bench-example.json') : void tick())
onUnmounted(() => { stopped = true; if (timer) clearTimeout(timer); unsub?.(); diffUnsub?.(); document.title = TITLE })
</script>

<template>
  <div class="layout bench">
    <div class="col left">
      <h4>Bench <button class="link" @click="emit('example', !example)">{{ example ? 'your benches' : 'Examples' }}</button></h4>
      <div v-if="example" class="hint">{{ t('bench.exampleNote') }}</div>
      <div v-else class="actions">
        <button @click="toggleNew">New bench</button>
        <button v-if="starting || own" :disabled="stopping" :title="t('bench.stopTitle')" @click="stop">{{ stopping ? 'stopping…' : 'Stop bench' }}</button>
      </div>
      <div v-if="!files.length && !example" class="hint">
        <T k="bench.empty"><template #cmd><code>llm-harness-builder bench</code></template><template #examples><button class="link" @click="emit('example', true)">Examples</button></template></T><br>
        <T k="bench.emptyRuns"><template #runs><code>runs/*.json</code></template><template #out><code>--out</code></template></T>
      </div>
      <details v-if="files.length" :open="!file"><summary class="hint">{{ file || 'pick a bench' }} · {{ files.length }} benches</summary>
      <div class="runs">
        <div v-for="f in files" :key="f.file" :class="{ on: f.file === file }" @click="openFile(f.file)">
          <b>{{ f.file }}</b>
          <div class="line one muted"><span :title="shown(f.model.join(', '), names)">{{ shown(f.model.join(', '), names) || '?' }}<span v-if="!f.complete"> · incomplete</span></span><span>{{ new Date(f.date).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' }) }}</span></div>
        </div>
      </div>
      </details>

      <template v-if="result">
        <div v-if="active" class="ev approval live" @click="sel = 'live'">
          ● {{ active.harness }} #{{ active.round }} · {{ mmss(age) }} of {{ mmss(result.timeoutS * 1000) }} · silent {{ mmss(silence) }}
        </div>
        <div v-if="!runs.length" class="hint">{{ t('bench.round1') }}</div>
        <div class="runs">
          <template v-for="(h, hi) in result.harnesses" :key="labels[hi]">
            <h5 class="group">{{ labels[hi] }} · runs</h5>
            <div v-for="(r, i) in h.runs" :key="labels[hi] + '#' + i" :class="{ notrace: !r.trace, on: !!r.trace && sideA?.run.trace === r.trace, b: !!r.trace && diff?.run.trace === r.trace }"
                 @click="r.trace && (sel = { id: r.trace })">
              <div class="line"><span><b>{{ runTitle(r) }}</b> <span :class="['chip', 'solid', r.verdict === 'PASS' ? 'ok' : 'err']">{{ r.verdict }}</span> {{ r.reason }}</span><span>{{ r.turns }} turns · {{ r.toolCalls }} tool calls · {{ mmss(r.ms) }}</span></div>
              <div v-if="r.verdict === 'FAIL' && r.reason === 'final'">{{ t('bench.redTests') }}</div>
              <div v-if="r.lastError" class="clip" :title="shown(r.lastError, names)">{{ shown(r.lastError, names) }}</div>
              <div v-if="r.trace && analysis[r.trace]" class="analysis">{{ cellsLine(analysis[r.trace]) }}</div>
              <small class="where">
                <template v-if="r.trace">{{ r.trace }}</template>
                <template v-else>{{ t('bench.noTrace') }}</template> · {{ shown(r.workdir, names) }}
              </small>
              <div class="actions">
                <button v-if="!example" @click.stop="emit('toWorkbench', h.config, r.workdir)">to Workbench</button>
                <button v-if="r.trace && sideA && r.trace !== sideA.run.trace && r.trace !== diff?.run.trace" :title="t('bench.compareTitle')" @click.stop="compare(labels[hi], r, h.config)">⇄</button>
              </div>
            </div>
          </template>
        </div>
      </template>
      <div class="err">{{ shown(error, names) }}</div>
    </div>
    <div class="col" ref="pane">
      <div v-if="newOpen" class="table-wrap new-bench">
        <h5 class="group">Harnesses <span class="muted">· {{ t('bench.fromHarnesses') }}</span></h5>
        <div v-for="h in list" :key="h.name">
          <label><input type="checkbox" :value="h.name" v-model="picked"> <b>{{ h.name }}</b></label> <span v-if="h.description" class="muted film-hide">{{ shown(h.description, names) }}</span>
          <div v-for="c in picked.includes(h.name) ? runsUnasked[h.name] ?? [] : []" :key="c" class="hint clip" :title="shown(c, names)">{{ shown(t('bench.runsUnasked', { cmd: c }), names) }}</div>
        </div>
        <div class="row"><b>Model</b> <span class="muted">{{ shown(t('bench.modelFrom', { model: props.backend.model || '(none picked)' }), names) }} · {{ props.backend.kind }} {{ shown(props.backend.baseUrl, names) }}<template v-if="props.backend.apiKeyEnv"> · key {{ props.backend.apiKeyEnv }}</template></span></div>
        <div class="row">
          <label><b>Task</b> <select v-model="task"><option v-for="(_, name) in BENCH_TASKS" :key="name" :value="name">{{ name }}</option></select></label>
          <label v-if="BENCH_TASKS[task]"><b>size</b> <input type="number" min="1" :max="BENCH_TASKS[task]" v-model.number="size"></label>
          <label><b>runs per harness</b> <input type="number" min="1" max="50" v-model.number="runsPer"></label>
        </div>
        <div class="warn">{{ tn('bench.runsWarn', picked.length * runsPer) }}</div>
        <div class="hint">{{ t('bench.autoApproves') }}</div>
        <button :disabled="starting || !picked.length || !props.backend.model" @click="startNew">{{ starting ? 'Starting…' : 'Start' }}</button>
      </div>
      <template v-if="result">
        <div class="bench-head">
          <div>
          <h2>{{ result.taskName ?? 'bench' }}<template v-if="result.size"> · size {{ result.size }}</template> · {{ result.harnesses.length }} harnesses × {{ total / result.harnesses.length }} runs</h2>
          <div class="muted">{{ shown(modelsLine, names) }} · {{ backend?.kind }} {{ shown(backend?.baseUrl ?? '', names) }}<template v-if="nCtx"> · window {{ nCtx.toLocaleString(lang) }}</template> · timeout {{ mmss(result.timeoutS * 1000) }} · {{ new Date(result.date).toLocaleString(lang) }}</div>
          <div class="muted">{{ runs.length }}/{{ total }} runs<template v-if="!result.complete"> · {{ result.stopped ? 'stopped' : 'incomplete' }}</template> · {{ mmss(msDone) }} in</div>
          </div>
          <button v-if="!example" @click="again" :disabled="starting || !!active" :title="active ? t('h.againBusy') : t('h.again')">{{ starting ? 'Starting…' : 'Run bench again' }}</button>
        </div>
        <div v-if="runs.length" class="table-wrap">
          <table class="bench">
            <thead><tr><th>harness</th><th class="n" :title="t('h.pass')">pass</th><th :title="t('h.rate')">rate · 95% interval</th><th class="n" :title="t('h.medTurns')">med turns</th><th class="n" :title="t('h.medTime')">med time</th><th v-if="hasCost" class="n" :title="t('h.medCost')">med cost</th><th v-if="hasPeak" class="n" :title="t('h.peak')">peak tok</th><th v-for="w in [...WIDE_HEAD, ...P_HEAD]" :key="w" class="n" :title="w.startsWith('p ') ? 'p (permutations): two-sided permutation test of the mean against the first harness of the same model, shuffled inside each task. With many columns some p < 0.05 come by chance.' : 'mean per run, or per success on the tasks shared with the first harness of the same model; ! = dearer than evolve allows'">{{ w }}</th><th :title="t('h.reasons')">how runs ended</th></tr></thead>
            <tbody>
              <tr v-for="(h, hi) in result.harnesses" :key="labels[hi]" :class="{ on: labels[hi] === openHarness }">
                <td>{{ labels[hi] }}</td>
                <td class="n"><span :class="['chip', h.runs.length && h.pass === 0 ? 'err' : h.runs.length && h.pass === h.runs.length ? 'ok' : '']">{{ h.pass }} / {{ h.runs.length }}</span></td>
                <td :title="h.runs.length ? `${ci(h.pass, h.runs.length).map(x => x.toFixed(2)).join('–')}` : 'no runs yet'">
                  <div v-if="h.runs.length" class="ci"><div class="axis"></div>
                    <div class="range" :style="{ left: pct(ci(h.pass, h.runs.length)[0]), width: pct(ci(h.pass, h.runs.length)[1] - ci(h.pass, h.runs.length)[0]) }"></div>
                    <div class="pt" :style="{ left: pct(h.pass / h.runs.length) }"></div></div>
                  <span v-else class="muted">-</span>
                </td>
                <td class="n">{{ h.median.turns }}</td>
                <td class="n">{{ mmss(h.median.ms) }}</td>
                <td v-if="hasCost" class="n">{{ medCost(h) }}</td>
                <td v-if="hasPeak" class="n" :class="{ warn: nCtx && (peak(h) ?? 0) > nCtx * 0.9 }">{{ peak(h)?.toLocaleString(lang) ?? '-' }}</td>
                <td v-for="(w, wi) in wide[hi]" :key="wi" class="n">{{ w }}</td>
                <td><span v-for="(v, k) in h.reasons" :key="k" :class="['chip', reasonTone(String(k))]">{{ k }} ×{{ v }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="runs.length" class="hint">{{ t('bench.wilsonNote') }}</p>
        <details v-if="runs.length" class="inspector"><summary class="hint">plain table (every column)</summary><pre>{{ formatTable(result.harnesses, { wide: true }) }}</pre></details>
      </template>
      <h5 v-if="result && events.length && !(sideA && sideB)" class="group">{{ sideA ? `${sideA.name} #${sideA.run.round} · ${sideA.run.verdict} · trace` : `${active?.harness ?? ''} #${active?.round ?? ''} · live trace` }}</h5>
      <Diff v-if="sideA && sideB" :a="sideA" :b="sideB" :task="result!.task" @close="closeDiff" />
      <Trace v-else-if="result && events.length" :events="events" :task="result.task" :approvable="false" :names="names" />
    </div>
  </div>
</template>
