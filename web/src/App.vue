<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { api, type Delta, type HarnessConfig, type HarnessEvent, type RunSummary, type ServerInfo } from './api'
import { PRESETS, DEFAULT_PROMPTED_TEMPLATE, DEFAULT_PARSE_ERROR_HINT, DEMO_TASK } from '../../src/core/prompts'
import { isLoopbackUrl, listsModelsByItself } from '../../src/core/config'
import { knobsOff } from '../../src/core/knobs'
import ConfigForm from './ConfigForm.vue'
import ContextBar from './ContextBar.vue'
import Trace from './Trace.vue'
import Bench from './Bench.vue'
import { H } from './hints'

const tab = ref<'workbench' | 'bench'>('workbench')
const config = ref<HarnessConfig>({
  name: 'new', backend: { kind: 'ollama', baseUrl: 'http://localhost:11434', model: '', numCtx: 8192, temperature: 0.2 },
  systemPrompt: PRESETS.minimal, tools: { enabled: ['list_dir', 'read_file', 'write_file', 'edit_file', 'bash'], approveBash: true },
  toolCalls: { mode: 'native', format: 'json', enforceSchema: false, promptedTemplate: DEFAULT_PROMPTED_TEMPLATE, parseErrorHint: DEFAULT_PARSE_ERROR_HINT },
  context: { maxToolOutputChars: 4000 }, loop: { maxTurns: 15 },
})
const harnessNames = ref<string[]>([])
const models = ref<string[]>([]); const modelsError = ref('')
/** What the server says the picked model takes; undefined is unknown, and nothing is locked. */
const modelInfo = ref<ServerInfo>()
const workdir = ref(''); const task = ref(DEMO_TASK)
const runs = ref<RunSummary[]>([]); const runId = ref(''); const events = ref<HarnessEvent[]>([]); const error = ref('')
/** Non-empty while the form's mcpServers box holds unparseable JSON: the config then still carries
 *  the last valid value, so running would use something the user cannot see. */
const mcpError = ref('')
const live = ref<Delta>({}) // the current turn's streamed text; live-only, never in the trace
let unsub: (() => void) | null = null
/** The task of the run on screen; the form's textarea is the next run's, not this one's. */
const runTask = ref('')
/** The run this page started. Run is about it, not about any run opened from the list (a live proxy session among them). */
const ownRun = ref('')
/** Whether the opened run's own RunSummary reported `active` when it was opened: a run this page
 *  did not start itself, but that the server still tracks as running (its own run reopened after
 *  a reload, or another tab's) and so can still abort. A live proxy session is never active this
 *  way, since serve never started it. */
const openActive = ref(false)
const isDone = () => events.value.some(e => e.type === 'done')
const running = () => !!ownRun.value && runId.value === ownRun.value && !isDone()
/** Abort is enabled for a run this page started, or for any opened run the server still marks active — never for a run that only looks live because it has no `done` yet (a proxy session), which would 404. */
const canAbort = () => !!runId.value && !isDone() && (running() || openActive.value)

async function refreshModels() {
  modelsError.value = ''
  const b = config.value.backend, picked = b.model
  try {
    models.value = await api.models(b.kind, b.baseUrl, b.apiKeyEnv)
    // A list from elsewhere is hundreds of models at every price, and a hosted one is public, so it arrives before the key is typed:
    // the form picks by itself only from a keyless list on this machine.
    if (!b.model && !b.apiKeyEnv && isLoopbackUrl(b.baseUrl) && models.value[0]) b.model = models.value[0]
  }
  catch (e) { models.value = []; modelsError.value = `cannot list models: ${(e as Error).message}` }
  if (b.model === picked) await refreshInfo() // a model picked from the list above is asked for by the model watch
}
const INFO_ERROR = 'cannot read what the model takes: '
let infoAsk = 0
/** Also drops an answer still on its way: it is about the backend or model before this change. */
function forgetInfo() { infoAsk++; modelInfo.value = undefined }
/** With a key: on the refresh button only, as the list. Without one, only Ollama: an OpenAI-compatible server's answer
 *  holds no `takes` (llama-server's /props), and a llama router loads the model it is asked about. */
async function refreshInfo() {
  forgetInfo()
  const b = config.value.backend, ask = infoAsk
  if (!b.model || (listsModelsByItself(b) && b.kind !== 'ollama')) return
  try {
    const info = await api.modelInfo(b.kind, b.baseUrl, b.model, b.apiKeyEnv)
    if (ask !== infoAsk) return // the backend or the model changed meanwhile: a later ask owns the answer
    modelInfo.value = info
    if (modelsError.value.startsWith(INFO_ERROR)) modelsError.value = ''
  } catch (e) { if (ask === infoAsk) modelsError.value ||= INFO_ERROR + (e as Error).message }
}
/** A structural knob the model does not take: the run would be refused, so the form says it before Run. */
const refusal = computed(() => modelInfo.value && knobsOff(config.value, modelInfo.value).refuse) // unknown: nothing to say yet
async function refreshLists() { harnessNames.value = (await api.harnesses()).map(h => h.name); runs.value = await api.runs() }
/** Normalises a config from either door (saved harness, bench JSON) before it lands in the form. */
/** A harness without toolCalls.format stays without it: the form shows json for a missing key, and only a choice made there writes one. */
function setConfig(c: HarnessConfig) { config.value = c }
/** A harness describes how the agent thinks; the backend is what it runs on. Switching the first
 *  leaves the second alone — unless no model is picked yet (models never listed), when the
 *  harness's own backend is the only usable one. */
async function load(name: string) {
  if (!name) return
  const c = await api.harness(name)
  setConfig({ ...c, backend: config.value.backend.model ? config.value.backend : c.backend })
}
async function saveAs(name: string) { error.value = ''; try { config.value.name = name; await api.saveHarness(name, outbound(config.value)); await refreshLists() } catch (e) { error.value = (e as Error).message } }
function open(id: string, runTaskText: string, active = false) {
  unsub?.(); events.value = []; live.value = {}; runId.value = id; runTask.value = runTaskText; openActive.value = active
  unsub = api.events(id,
    e => { events.value.push(e); if (e.type === 'done') refreshLists(); else if (e.type !== 'error') live.value = {} }, // keep partial text visible after an abort
    msg => (error.value = msg),
    d => { live.value = { reasoning: (live.value.reasoning ?? '') + (d.reasoning ?? ''), content: (live.value.content ?? '') + (d.content ?? '') } })
}
async function start() {
  error.value = ''
  try { const { runId: id } = await api.startRun(outbound(config.value), task.value, workdir.value); ownRun.value = id; open(id, task.value, true) }
  catch (e) { error.value = (e as Error).message }
}
const approve = (callId: string, ok: boolean) => api.approve(runId.value, callId, ok).catch(e => (error.value = e.message))
const abort = () => api.abort(runId.value).catch(e => (error.value = e.message))
/** The folder picker: the server lists folders, since a browser never tells a page an absolute path. */
const browse = ref<Awaited<ReturnType<typeof api.dirs>> | null>(null)
const browseTo = (p: string) => api.dirs(p).then(d => (browse.value = d)).catch(e => (error.value = e.message))

/** v-model.number leaves numCtx as '' when the field is cleared; drop it so validateConfig sees undefined, not a bad number. */
function outbound(c: HarnessConfig): HarnessConfig {
  const n = c.backend.numCtx as unknown
  const numCtx = Number.isInteger(n) && (n as number) > 0 ? (n as number) : undefined
  return { ...c, backend: { ...c.backend, numCtx } }
}

/** Loads a bench run's harness and workdir into the form; the user presses Run themselves. */
function toWorkbench(c: HarnessConfig, wd: string) { setConfig(c); workdir.value = wd; tab.value = 'workbench' }

onMounted(async () => { await refreshLists(); if (listsModelsByItself(config.value.backend)) await refreshModels() })
watch(() => [config.value.backend.kind, config.value.backend.baseUrl, config.value.backend.apiKeyEnv], () => {
  // With a key, asking for the list sends the key to baseUrl: that waits for the refresh button, so opening a harness
  // or a bench run sends nothing, and a list from the previous host is not kept.
  if (listsModelsByItself(config.value.backend)) refreshModels()
  else { models.value = []; modelsError.value = ''; forgetInfo() }
})
watch(() => config.value.backend.model, () => {
  if (listsModelsByItself(config.value.backend)) refreshInfo()
  else forgetInfo()
})
</script>

<template>
  <div class="app">
    <div class="tabs">
      <button :class="{ on: tab === 'workbench' }" @click="tab = 'workbench'">Workbench</button>
      <button :class="{ on: tab === 'bench' }" @click="tab = 'bench'">Bench</button>
    </div>
    <Bench v-if="tab === 'bench'" @to-workbench="toWorkbench" />
    <div class="layout" v-else>
      <div class="col left">
        <ConfigForm v-model="config" v-model:mcp-error="mcpError" :models="models" :models-error="modelsError" :model-info="modelInfo" :harness-names="harnessNames" @refresh-models="refreshModels" @load="load" @save-as="saveAs" />
      </div>
      <div class="col">
        <label :title="H.workdir">Workdir (absolute path to a scratch project; not / or your home)</label>
        <div class="browse" @keydown.esc="browse = null">
        <div class="row">
          <input type="text" v-model="workdir" placeholder="/path/to/project">
          <button @click="browse ? (browse = null) : browseTo(workdir)">{{ browse ? 'Close' : 'Browse…' }}</button>
        </div>
        <div v-if="browse" class="backdrop" @click="browse = null"></div><!-- a click anywhere else closes the dropdown -->
        <div v-if="browse" class="picker">
          <div class="row"><code>{{ browse.path }}</code><button @click="workdir = browse.path; browse = null">Use this folder</button></div>
          <div class="dirs">
            <div v-if="browse.parent" @click="browseTo(browse.parent)">..</div>
            <div v-for="d in browse.dirs" :key="d.path" @click="browseTo(d.path)">{{ d.name }}/</div>
            <div v-if="!browse.dirs.length" class="muted">no folders here</div>
          </div>
        </div>
        </div>
        <label :title="H.task">Task</label>
        <textarea v-model="task" class="task"></textarea>
        <div v-if="refusal" class="warn">{{ refusal }}</div>
        <div class="row" style="margin:8px 0">
          <button @click="start" :disabled="!!running() || !!mcpError">Run</button>
          <button @click="abort" :disabled="!canAbort()">Abort</button>
          <span class="err">{{ error }}</span>
        </div>
        <ContextBar :events="events" :num-ctx="config.backend.kind === 'ollama' ? config.backend.numCtx : undefined" />
        <Trace v-if="runId" :events="events" :live="live" :task="runTask" @approve="approve" />
        <h4>Runs</h4>
        <div class="runs">
          <div v-for="r in runs" :key="r.id" @click="open(r.id, r.task, r.active)">
            <div class="line"><span><b>{{ r.harness }}</b> · {{ r.reason ?? 'running' }}</span><span>{{ r.turns ?? '-' }} turns · {{ r.toolCallCount ?? '-' }} tool calls · {{ new Date(r.started).toLocaleTimeString() }}</span></div>
            <div class="muted">{{ r.task.slice(0, 60) }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
