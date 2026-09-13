<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { api, type ActiveTrace, type BenchFile, type BenchResult, type Delta, type HarnessConfig, type HarnessEvent } from './api'
import { formatTable } from '../../src/core/bench'
import Trace from './Trace.vue'

const emit = defineEmits<{ toWorkbench: [config: HarnessConfig, workdir: string] }>()

const EMPTY: Delta = {} // a stable object: a fresh literal per render would churn the prop
const files = ref<BenchFile[]>([])
const file = ref('')
const result = ref<BenchResult | null>(null)
const active = ref<ActiveTrace | null>(null)
const events = ref<HarnessEvent[]>([])
/** 'live' follows the running trace; { id } pins the panel to one finished run (SSE). */
const sel = ref<'live' | { id: string }>('live')
const error = ref('')
const now = ref(Date.now())
const pane = ref<HTMLElement | null>(null)
let unsub: (() => void) | null = null
let gen = 0
let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false
/** Set by the tick's own catch; only the tick clears its own failure, never an SSE error it did not cause. */
let fetchFailed = false

const runs = computed(() => result.value?.harnesses.flatMap(h => h.runs) ?? [])
const total = computed(() => result.value ? result.value.n * result.value.harnesses.length : 0)
const msDone = computed(() => runs.value.reduce((a, r) => a + r.ms, 0))
const backend = computed(() => result.value?.harnesses[0]?.config?.backend)
/** Four of five `bare` runs are over 900 s: 1800s reads worse than 30:00. */
const mmss = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 120 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

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
  file.value = f; sel.value = 'live'; result.value = null; active.value = null; events.value = []
  unsub?.(); unsub = null
  restart()
}

watch(sel, s => {
  unsub?.(); unsub = null
  error.value = ''
  if (s === 'live') { events.value = active.value?.events ?? [] ; return }
  events.value = []
  unsub = api.events(s.id, e => events.value.push(e),
    m => (error.value = `${m} — якщо прогін убили, у runs/ лишився ${s.id}.jsonl.part; перейменуй його в .jsonl`))
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
  document.title = result.value ? `${runs.value.length}/${total.value}${result.value.complete ? ' готово' : ''} · bench` : 'llm-harness-builder'
})

onMounted(() => void tick())
onUnmounted(() => { stopped = true; if (timer) clearTimeout(timer); unsub?.(); document.title = 'llm-harness-builder' })
</script>

<template>
  <div class="layout bench">
    <div class="col left">
      <h4>Bench</h4>
      <div v-if="!files.length" class="hint">
        ще нема бенчів: запусти <code>llm-harness-builder bench</code><br>
        сторінка читає лише <code>runs/*.json</code> — бенч із <code>--out</code> в іншому каталозі тут не з'явиться
      </div>
      <div class="runs">
        <div v-for="f in files" :key="f.file" :class="{ on: f.file === file }" @click="openFile(f.file)">
          {{ f.file }} · {{ f.model || '?' }} · {{ new Date(f.date).toLocaleString() }}<span v-if="!f.complete"> · не завершено</span>
        </div>
      </div>

      <template v-if="result">
        <div class="hint">
          {{ backend?.model }} · {{ backend?.kind }} {{ backend?.baseUrl }} · n={{ result.n }} · timeout {{ mmss(result.timeoutS * 1000) }} · {{ new Date(result.date).toLocaleString() }}<br>
          {{ runs.length }}/{{ total }} прогонів · {{ mmss(msDone) }} позаду
        </div>
        <div v-if="active" class="ev approval live" @click="sel = 'live'">
          ● {{ active.harness }} #{{ active.round }} · {{ mmss(age) }} з {{ mmss(result.timeoutS * 1000) }} · тиша {{ mmss(silence) }}
        </div>
        <div v-if="!runs.length" class="hint">раунд 1 ще йде, перших результатів нема</div>
        <pre v-else class="bench-table">{{ formatTable(result.harnesses) }}</pre>
        <div class="runs">
          <template v-for="h in result.harnesses" :key="h.name">
            <div v-for="r in h.runs" :key="h.name + '#' + r.round" :class="{ notrace: !r.trace, bad: r.verdict === 'FAIL' }"
                 @click="r.trace && (sel = { id: r.trace })">
              {{ h.name }} #{{ r.round }} {{ r.verdict }} {{ r.reason }} {{ mmss(r.ms) }}<span
                v-if="r.verdict === 'FAIL' && r.reason === 'final'"> — модель відповіла, тести червоні</span>
              <div v-if="r.lastError" class="clip" :title="r.lastError">{{ r.lastError }}</div>
              <small>
                <template v-if="r.trace">{{ r.trace }}</template>
                <template v-else>трейс не писався (JSON до v2.0.3)</template> · {{ r.workdir }}
                <button @click.stop="emit('toWorkbench', h.config, r.workdir)">у Workbench</button>
              </small>
            </div>
          </template>
        </div>
      </template>
      <div class="err">{{ error }}</div>
    </div>
    <div class="col" ref="pane">
      <Trace v-if="result && events.length" :events="events" :live="EMPTY" :task="result.task" :approvable="false" />
    </div>
  </div>
</template>
