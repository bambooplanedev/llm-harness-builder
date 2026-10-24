<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { api, type ActiveTrace, type AnalysisCells, type BenchFile, type BenchHarness, type BenchResult, type BenchRun, type HarnessConfig, type HarnessEvent } from './api'
import { cellsLine } from '../../src/core/analyze'
import { formatTable, mmss, wilson } from '../../src/core/bench'
import Trace from './Trace.vue'
import Diff from './Diff.vue'
import type { DiffSide } from '../../src/core/diff'

const emit = defineEmits<{ toWorkbench: [config: HarnessConfig, workdir: string] }>()

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
const killedHint = (msg: string, id: string) => `${msg} — if the run was killed, runs/${id}.jsonl.part is left behind; rename it to .jsonl`

function compare(name: string, run: BenchRun, config: HarnessConfig) {
  diffUnsub?.(); diffEvents.value = []
  diff.value = { name, run, config }
  diffUnsub = api.events(run.trace!, e => diffEvents.value.push(e),
    m => (error.value = killedHint(`${m} — the compared run`, run.trace!)))
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
  for (const h of result.value.harnesses) {
    const run = h.runs.find(r => r.trace === id)
    if (run) return { name: h.name, run, config: h.config, events: events.value }
  }
  return null
})
const sideB = computed<DiffSide | null>(() => diff.value && { ...diff.value, events: diffEvents.value })
const total = computed(() => result.value ? result.value.n * result.value.harnesses.length : 0)
const msDone = computed(() => runs.value.reduce((a, r) => a + r.ms, 0))
const backend = computed(() => result.value?.harnesses[0].config.backend)
const nCtx = computed(() => result.value?.harnesses.find(h => h.server?.nCtx)?.server?.nCtx)
const hasCost = computed(() => runs.value.some(r => r.costUsd !== undefined))
/** The harness of the open run: its row in the table is marked. */
const openHarness = computed(() => sideA.value?.name)
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const ci = (pass: number, n: number) => wilson(pass, n) ?? [0, 0]
/** PASS ends green, a run that ran into a wall red, the rest (turns, loop, abort) amber. */
const reasonTone = (r: string) => r === 'final' ? 'ok' : r.endsWith('error') ? 'err' : 'warn'
const medCost = (h: BenchHarness) => { const c = h.runs.flatMap(r => r.costUsd ?? []).sort((a, b) => a - b); return c.length ? `$${Number(c[(c.length - 1) >> 1].toPrecision(3))}` : '-' }

/**
 * One poll. A setTimeout chain, not setInterval: a tick reads the whole .part and every bench JSON,
 * and an overlapping pair of responses arriving out of order would rewind the trace. `gen` covers the
 * other three races at once — switching file, switching tab, unmount.
 */
async function tick() {
  const my = ++gen
  try {
    const r = await api.bench(file.value || undefined)
    if (my !== gen || stopped) return
    files.value = r.files
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
    m => (error.value = killedHint(m, s.id)))
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

onMounted(() => void tick())
onUnmounted(() => { stopped = true; if (timer) clearTimeout(timer); unsub?.(); diffUnsub?.(); document.title = TITLE })
</script>

<template>
  <div class="layout bench">
    <div class="col left">
      <h4>Bench</h4>
      <div v-if="!files.length" class="hint">
        no benches yet: run <code>llm-harness-builder bench</code><br>
        this page reads only <code>runs/*.json</code> — a bench written with <code>--out</code> elsewhere will not show up here
      </div>
      <details v-if="files.length" :open="!file"><summary class="hint">{{ file || 'pick a bench' }} · {{ files.length }} benches</summary>
      <div class="runs">
        <div v-for="f in files" :key="f.file" :class="{ on: f.file === file }" @click="openFile(f.file)">
          <b>{{ f.file }}</b>
          <div class="line one muted"><span :title="f.model">{{ f.model || '?' }}<span v-if="!f.complete"> · incomplete</span></span><span>{{ new Date(f.date).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) }}</span></div>
        </div>
      </div>
      </details>

      <template v-if="result">
        <div v-if="active" class="ev approval live" @click="sel = 'live'">
          ● {{ active.harness }} #{{ active.round }} · {{ mmss(age) }} of {{ mmss(result.timeoutS * 1000) }} · silent {{ mmss(silence) }}
        </div>
        <div v-if="!runs.length" class="hint">round 1 still running, no results yet</div>
        <div class="runs">
          <template v-for="h in result.harnesses" :key="h.name">
            <h5 class="group">{{ h.name }} · runs</h5>
            <div v-for="r in h.runs" :key="h.name + '#' + r.round" :class="{ notrace: !r.trace, on: !!r.trace && sideA?.run.trace === r.trace }"
                 @click="r.trace && (sel = { id: r.trace })">
              <div class="line"><span><b>#{{ r.round }}</b> <span :class="['chip', 'solid', r.verdict === 'PASS' ? 'ok' : 'err']">{{ r.verdict }}</span> {{ r.reason }}</span><span>{{ r.turns }} turns · {{ r.toolCalls }} tool calls · {{ mmss(r.ms) }}</span></div>
              <div v-if="r.verdict === 'FAIL' && r.reason === 'final'">the model answered, tests are red</div>
              <div v-if="r.lastError" class="clip" :title="r.lastError">{{ r.lastError }}</div>
              <div v-if="r.trace && analysis[r.trace]" class="analysis">{{ cellsLine(analysis[r.trace]) }}</div>
              <small>
                <template v-if="r.trace">{{ r.trace }}</template>
                <template v-else>no trace written (JSON predates v2.0.3)</template> · {{ r.workdir }}
                <button @click.stop="emit('toWorkbench', h.config, r.workdir)">to Workbench</button>
                <button v-if="r.trace && sideA && r.trace !== sideA.run.trace && r.trace !== diff?.run.trace" @click.stop="compare(h.name, r, h.config)">⇄</button>
              </small>
            </div>
          </template>
        </div>
      </template>
      <div class="err">{{ error }}</div>
    </div>
    <div class="col" ref="pane">
      <template v-if="result">
        <div class="bench-head">
          <h2>{{ result.taskName ?? 'bench' }}<template v-if="result.size"> · size {{ result.size }}</template> · {{ result.harnesses.length }} harnesses × {{ result.n }} runs</h2>
          <div class="muted">{{ backend?.model }} · {{ backend?.kind }} {{ backend?.baseUrl }}<template v-if="nCtx"> · window {{ nCtx.toLocaleString() }}</template> · timeout {{ mmss(result.timeoutS * 1000) }} · {{ new Date(result.date).toLocaleString() }}</div>
          <div class="muted">{{ runs.length }}/{{ total }} runs<template v-if="!result.complete"> · incomplete</template> · {{ mmss(msDone) }} in</div>
        </div>
        <div v-if="runs.length" class="table-wrap">
          <table class="bench">
            <thead><tr><th>harness</th><th class="n">pass</th><th>rate · 95% interval</th><th class="n">med turns</th><th class="n">med time</th><th v-if="hasCost" class="n">med cost</th><th>how runs ended</th></tr></thead>
            <tbody>
              <tr v-for="h in result.harnesses" :key="h.name" :class="{ on: h.name === openHarness }">
                <td>{{ h.name }}</td>
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
                <td><span v-for="(v, k) in h.reasons" :key="k" :class="['chip', reasonTone(String(k))]">{{ k }} ×{{ v }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="runs.length" class="hint">95% interval = Wilson interval of the PASS rate; two harnesses whose intervals overlap are not told apart by this bench.</p>
        <details v-if="runs.length" class="inspector"><summary class="hint">plain table (every column)</summary><pre>{{ formatTable(result.harnesses) }}</pre></details>
      </template>
      <h5 v-if="result && events.length && !(sideA && sideB)" class="group">{{ sideA ? `${sideA.name} #${sideA.run.round} · ${sideA.run.verdict} · trace` : `${active?.harness ?? ''} #${active?.round ?? ''} · live trace` }}</h5>
      <Diff v-if="sideA && sideB" :a="sideA" :b="sideB" :task="result!.task" @close="closeDiff" />
      <Trace v-else-if="result && events.length" :events="events" :task="result.task" :approvable="false" />
    </div>
  </div>
</template>
