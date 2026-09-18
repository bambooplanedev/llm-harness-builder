<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { api, type Delta, type HarnessConfig, type HarnessEvent, type RunSummary } from './api'
import { PRESETS, DEFAULT_PROMPTED_TEMPLATE, DEFAULT_PARSE_ERROR_HINT, DEMO_TASK } from '../../src/core/prompts'
import ConfigForm from './ConfigForm.vue'
import ContextBar from './ContextBar.vue'
import Trace from './Trace.vue'
import Bench from './Bench.vue'

const tab = ref<'workbench' | 'bench'>('workbench')
const config = ref<HarnessConfig>({
  name: 'new', backend: { kind: 'ollama', baseUrl: 'http://localhost:11434', model: '', numCtx: 8192, temperature: 0.2 },
  systemPrompt: PRESETS.minimal, tools: { enabled: ['list_dir', 'read_file', 'write_file', 'edit_file', 'bash'], approveBash: true },
  toolCalls: { mode: 'native', format: 'json', enforceSchema: false, promptedTemplate: DEFAULT_PROMPTED_TEMPLATE, parseErrorHint: DEFAULT_PARSE_ERROR_HINT },
  context: { maxToolOutputChars: 4000, budgetTokens: 0 }, loop: { maxTurns: 15 },
})
const harnessNames = ref<string[]>([])
const models = ref<string[]>([]); const modelsError = ref('')
const workdir = ref(''); const task = ref(DEMO_TASK)
const runs = ref<RunSummary[]>([]); const runId = ref(''); const events = ref<HarnessEvent[]>([]); const error = ref('')
/** Non-empty while the form's mcpServers box holds unparseable JSON: the config then still carries
 *  the last valid value, so running would use something the user cannot see. */
const mcpError = ref('')
const live = ref<Delta>({}) // the current turn's streamed text; live-only, never in the trace
let unsub: (() => void) | null = null
const running = () => runId.value && !events.value.some(e => e.type === 'done')

async function refreshModels() {
  modelsError.value = ''
  try { models.value = await api.models(config.value.backend.kind, config.value.backend.baseUrl); if (!config.value.backend.model && models.value[0]) config.value.backend.model = models.value[0] }
  catch (e) { models.value = []; modelsError.value = `cannot list models: ${(e as Error).message}` }
}
async function refreshLists() { harnessNames.value = (await api.harnesses()).map(h => h.name); runs.value = await api.runs() }
/** Normalises a config from either door (saved harness, bench JSON) before it lands in the form. */
function setConfig(c: HarnessConfig) { c.toolCalls.format ??= 'json'; config.value = c }
/** A harness describes how the agent thinks; the backend is what it runs on. Switching the first
 *  leaves the second alone — unless no model is picked yet (models never listed), when the
 *  harness's own backend is the only usable one. */
async function load(name: string) {
  if (!name) return
  const c = await api.harness(name)
  setConfig({ ...c, backend: config.value.backend.model ? config.value.backend : c.backend })
}
async function saveAs(name: string) { error.value = ''; try { config.value.name = name; await api.saveHarness(name, outbound(config.value)); await refreshLists() } catch (e) { error.value = (e as Error).message } }
function open(id: string) {
  unsub?.(); events.value = []; live.value = {}; runId.value = id
  unsub = api.events(id,
    e => { events.value.push(e); if (e.type === 'done') refreshLists(); else if (e.type !== 'error') live.value = {} }, // keep partial text visible after an abort
    msg => (error.value = msg),
    d => { live.value = { reasoning: (live.value.reasoning ?? '') + (d.reasoning ?? ''), content: (live.value.content ?? '') + (d.content ?? '') } })
}
async function start() {
  error.value = ''
  try { const { runId: id } = await api.startRun(outbound(config.value), task.value, workdir.value); open(id) }
  catch (e) { error.value = (e as Error).message }
}
const approve = (callId: string, ok: boolean) => api.approve(runId.value, callId, ok).catch(e => (error.value = e.message))
const abort = () => api.abort(runId.value).catch(e => (error.value = e.message))

/** v-model.number leaves numCtx as '' when the field is cleared; drop it so validateConfig sees undefined, not a bad number. */
function outbound(c: HarnessConfig): HarnessConfig {
  const n = c.backend.numCtx as unknown
  const numCtx = Number.isInteger(n) && (n as number) > 0 ? (n as number) : undefined
  return { ...c, backend: { ...c.backend, numCtx } }
}

/** Loads a bench run's harness and workdir into the form; the user presses Run themselves. */
function toWorkbench(c: HarnessConfig, wd: string) { setConfig(c); workdir.value = wd; tab.value = 'workbench' }

onMounted(async () => { await refreshLists(); await refreshModels() })
watch(() => [config.value.backend.kind, config.value.backend.baseUrl], refreshModels)
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
        <ConfigForm v-model="config" v-model:mcp-error="mcpError" :models="models" :models-error="modelsError" :harness-names="harnessNames" @refresh-models="refreshModels" @load="load" @save-as="saveAs" />
      </div>
      <div class="col">
        <label>Workdir (absolute path to a scratch project; not / or your home)</label>
        <input type="text" v-model="workdir" placeholder="/path/to/project">
        <label>Task</label>
        <textarea v-model="task" style="min-height:50px"></textarea>
        <div class="row" style="margin:8px 0">
          <button @click="start" :disabled="!!running() || !!mcpError">Run</button>
          <button @click="abort" :disabled="!running()">Abort</button>
          <span class="err">{{ error }}</span>
        </div>
        <ContextBar :events="events" :num-ctx="config.backend.kind === 'ollama' ? config.backend.numCtx : undefined" />
        <Trace v-if="runId" :events="events" :live="live" :task="task" @approve="approve" />
        <h4>Runs</h4>
        <div class="runs">
          <div v-for="r in runs" :key="r.id" @click="open(r.id)">
            {{ r.harness }} · {{ r.reason ?? 'running' }} · {{ r.turns ?? '-' }} turns · {{ r.toolCallCount ?? '-' }} tool calls · {{ new Date(r.started).toLocaleTimeString() }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
