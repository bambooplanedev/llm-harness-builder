<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { api, type Delta, type HarnessConfig, type HarnessEvent, type RunSummary, type ServerInfo } from './api'
import { PRESETS, DEFAULT_PROMPTED_TEMPLATE, DEFAULT_PARSE_ERROR_HINT, DEMO_TASK } from '../../src/core/prompts'
import { isLoopbackUrl, listsModelsByItself } from '../../src/core/config'
import { knobsOff } from '../../src/core/knobs'
import { NEW_HARNESS } from './advanced'
import ConfigForm from './ConfigForm.vue'
import ContextBar from './ContextBar.vue'
import Trace from './Trace.vue'
import Bench from './Bench.vue'
import { t, T, lang, LANGS, langName, setLang } from './i18n'
import { shown } from './film'

const tab = ref<'workbench' | 'bench'>('workbench')
/** The Bench tab shows the recorded bench shipped with the package instead of ./runs: read-only, no model. */
const benchExample = ref(false)
const openExamples = () => { benchExample.value = true; tab.value = 'bench' }
const config = ref<HarnessConfig>(structuredClone(NEW_HARNESS))
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
const refusal = computed(() => {
  const r = modelInfo.value && knobsOff(config.value, modelInfo.value) // unknown: nothing to say yet
  return r?.refuseKind && t(`refuse.${r.refuseKind}`, { model: config.value.backend.model, from: modelInfo.value!.takesFrom ? ` (${modelInfo.value!.takesFrom})` : '' })
})
/** A Claude Code session is one group at the place of its newest run: mains first, then subagents, each oldest first. A group without a main still gets its head, on its first member. */
const listed = computed(() => {
  const groups = new Map<string, RunSummary[]>(), seen = new Set<string>()
  for (const r of runs.value) if (r.session) groups.set(r.session, [...(groups.get(r.session) ?? []), r])
  const out: { r: RunSummary; head?: { session: string; subagents: number }; sub?: boolean }[] = []
  for (const r of runs.value) {
    if (!r.session) { out.push({ r }); continue }
    if (seen.has(r.session)) continue
    seen.add(r.session)
    const g = groups.get(r.session)!.sort((a, b) => a.started - b.started)
    const members = [...g.filter(x => x.agent === 'main'), ...g.filter(x => x.agent !== 'main')]
    members.forEach((x, i) => out.push({ r: x, head: i ? undefined : { session: r.session!, subagents: g.filter(y => y.agent !== 'main').length }, sub: x.agent !== 'main' }))
  }
  return out
})
async function refreshLists() { harnessNames.value = (await api.harnesses()).map(h => h.name); runs.value = await api.runs() }
/** A harness describes how the agent thinks; the backend is what it runs on. Switching the first
 *  leaves the second alone — unless no model is picked yet (models never listed), when the
 *  harness's own backend is the only usable one. */
async function load(name: string) {
  if (!name) return
  const c = await api.harness(name)
  config.value = { ...c, backend: config.value.backend.model ? config.value.backend : c.backend }
}
async function saveAs(name: string) { error.value = ''; try { config.value.name = name; await api.saveHarness(name, outbound(config.value)); await refreshLists() } catch (e) { error.value = (e as Error).message } }
function open(id: string, runTaskText: string, active = false, example = false) {
  unsub?.(); events.value = []; live.value = {}; verdict.value = ''; runId.value = id; runTask.value = runTaskText; openActive.value = active
  unsub = api.events(id,
    e => { events.value.push(e); if (e.type === 'done') refreshLists(); else if (e.type !== 'error') live.value = {} }, // keep partial text visible after an abort
    msg => (error.value = msg),
    d => { live.value = { reasoning: (live.value.reasoning ?? '') + (d.reasoning ?? ''), content: (live.value.content ?? '') + (d.content ?? '') } },
    example)
}
/** Start here, step 1: a recorded trace in this panel, read-only. */
const openExample = (id: string) => api.runs(true).then(rs => open(id, rs.find(r => r.id === id)?.task ?? '', false, true)).catch(e => (error.value = e.message))
async function start() {
  error.value = ''
  try { const { runId: id } = await api.startRun(outbound(config.value), task.value, workdir.value); ownRun.value = id; open(id, task.value, true) }
  catch (e) { const m = (e as Error).message; error.value = m === 'backend.model is required' ? t('app.pickModel') : m }
}
const approve = (callId: string, ok: boolean) => api.approve(runId.value, callId, ok).catch(e => (error.value = e.message))
const abort = () => api.abort(runId.value).catch(e => (error.value = e.message))
/** The folder picker: the server lists folders, since a browser never tells a page an absolute path. */
const browse = ref<Awaited<ReturnType<typeof api.dirs>> | null>(null)
const browseTo = (p: string) => api.dirs(p).then(d => (browse.value = d)).catch(e => (error.value = e.message))
/** The demo project made from this page, and Check's verdict on it: shown here only, never written to the trace. */
const demoDir = ref(''); const verdict = ref<'PASS' | 'FAIL' | ''>('')
const createDemo = () => api.demo().then(d => { workdir.value = demoDir.value = d.workdir; browse.value = null }).catch(e => (error.value = e.message))
const canCheck = () => isDone() && runId.value === ownRun.value && !!demoDir.value && workdir.value === demoDir.value && runTask.value === DEMO_TASK
const check = () => { verdict.value = ''; api.demoCheck(workdir.value, outbound(config.value)).then(r => (verdict.value = r.verdict)).catch(e => (error.value = e.message)) }

/** v-model.number leaves numCtx as '' when the field is cleared; drop it so validateConfig sees undefined, not a bad number. */
function outbound(c: HarnessConfig): HarnessConfig {
  const n = c.backend.numCtx as unknown
  const numCtx = Number.isInteger(n) && (n as number) > 0 ? (n as number) : undefined
  return { ...c, backend: { ...c.backend, numCtx } }
}

/** Loads a bench run's harness and workdir into the form; the user presses Run themselves. */
function toWorkbench(c: HarnessConfig, wd: string) { config.value = c; workdir.value = wd; tab.value = 'workbench' }

const settings = ref<HTMLDialogElement | null>(null)
onMounted(async () => { await refreshLists(); if (listsModelsByItself(config.value.backend)) await refreshModels() })
// Three sources, not one getter returning an array: a new array never equals the last, so a family button, which swaps the
// whole config, would ask for the model list again and blink the panel with every click.
watch([() => config.value.backend.kind, () => config.value.backend.baseUrl, () => config.value.backend.apiKeyEnv], () => {
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
      <button class="settings" @click="settings?.showModal()">⚙ {{ t('settings.title') }}</button>
    </div>
    <Bench v-if="tab === 'bench'" :key="String(benchExample)" :backend="config.backend" :example="benchExample" @example="v => (benchExample = v)" @to-workbench="toWorkbench" />
    <div class="layout" v-else>
      <div class="col left">
        <ConfigForm v-model="config" v-model:mcp-error="mcpError" :models="models" :models-error="modelsError" :model-info="modelInfo" :harness-names="harnessNames" @refresh-models="refreshModels" @load="load" @save-as="saveAs" />
      </div>
      <div class="col">
        <label class="film-hide" :title="t('h.workdir')">Workdir</label>
        <div class="browse film-hide" @keydown.esc="browse = null">
        <div class="row">
          <input type="text" v-model="workdir" placeholder="/path/to/project">
          <button @click="browse ? (browse = null) : browseTo(workdir)">{{ browse ? 'Close' : 'Browse…' }}</button>
          <button @click="createDemo">Create demo project</button>
        </div>
        <div v-if="browse" class="backdrop" @click="browse = null"></div><!-- a click anywhere else closes the dropdown -->
        <div v-if="browse" class="picker">
          <div class="row"><code>{{ browse.path }}</code><button @click="workdir = browse.path; browse = null">Use this folder</button></div>
          <div class="dirs">
            <div v-if="browse.parent" @click="browseTo(browse.parent)">..</div>
            <div v-for="d in browse.dirs" :key="d.path" @click="browseTo(d.path)">{{ d.name }}/</div>
            <div v-if="!browse.dirs.length" class="muted">{{ t('app.noFolders') }}</div>
          </div>
        </div>
        </div>
        <label :title="t('h.task')">Task</label>
        <textarea v-model="task" class="task"></textarea>
        <div v-if="refusal" class="warn">{{ refusal }}</div>
        <div class="row" style="margin:8px 0">
          <button @click="start" :disabled="!!running() || !!mcpError">Run</button>
          <button @click="abort" :disabled="!canAbort()">Abort</button>
          <span class="err">{{ error }}</span>
        </div>
        <div v-if="canCheck()" class="row" style="margin:8px 0">
          <button @click="check">Check</button>
          <span class="muted">{{ t('app.checkNote') }}</span>
          <span v-if="verdict" :class="['chip', 'solid', verdict === 'PASS' ? 'ok' : 'err']">{{ verdict }}</span>
        </div>
        <ContextBar :events="events" :num-ctx="config.backend.kind === 'ollama' ? config.backend.numCtx : undefined" />
        <Trace v-if="runId" :events="events" :live="live" :task="runTask" @approve="approve" />
        <h4>Runs <button class="link" @click="openExamples">Examples</button></h4>
        <div v-if="!runs.length" class="start">
          <h5 class="group">{{ t('start.title') }}</h5>
          <ol>
            <li><T k="start.example"><template #pass><button class="link" @click="openExample('059867d3')">PASS</button></template><template #fail><button class="link" @click="openExample('d63e9548')">FAIL</button></template></T></li>
            <li><T k="start.bench"><template #bench><button class="link" @click="openExamples">{{ t('start.benchLink') }}</button></template></T></li>
            <li>{{ t('start.run') }}</li>
          </ol>
        </div>
        <div class="runs">
          <div v-for="{ r, head, sub } in listed" :key="r.id" :class="{ session: r.session, sub }" @click="open(r.id, r.task, r.active)">
            <div class="line"><span><b>{{ r.harness }}</b><template v-if="head"> · session {{ head.session.slice(0, 4) }}…</template><template v-if="sub"> · ↳ subagent {{ r.agentType ?? r.agent }}</template><template v-else-if="head"> · main</template> · {{ r.reason ?? 'running' }}</span><span><template v-if="head?.subagents">{{ head.subagents }} subagent{{ head.subagents === 1 ? '' : 's' }} · </template>{{ r.turns ?? '-' }} turns · {{ r.toolCallCount ?? '-' }} tool calls · {{ new Date(r.started).toLocaleTimeString(lang) }}</span></div>
            <div class="muted">{{ shown(r.task, { models: [config.backend.model], urls: [config.backend.baseUrl] }).slice(0, 60) }}</div>
          </div>
        </div>
      </div>
    </div>
    <dialog ref="settings" aria-labelledby="settings-title">
      <form method="dialog">
        <h3 id="settings-title">{{ t('settings.title') }}</h3>
        <fieldset>
          <legend>{{ t('settings.language') }}</legend>
          <label v-for="l in LANGS" :key="l"><input type="radio" name="lang" :value="l" :autofocus="l === lang" :checked="l === lang" @change="setLang(l)"> {{ langName(l) }}</label>
        </fieldset>
        <button>{{ t('settings.close') }}</button>
      </form>
    </dialog>
  </div>
</template>
