<script setup lang="ts">
import { ref, watch } from 'vue'
import type { HarnessConfig } from './api'
import { PRESETS, FAMILIES, applyFamily, DEFAULT_PROMPTED_TEMPLATE, DEFAULT_PARSE_ERROR_HINT } from '../../src/core/prompts'
import { TOOL_NAMES } from '../../src/core/config'

const config = defineModel<HarnessConfig>({ required: true })
const props = defineProps<{ models: string[]; modelsError: string; harnessNames: string[] }>()
const emit = defineEmits<{ refreshModels: []; load: [name: string]; saveAs: [name: string] }>()

const saveName = ref(config.value.name)
watch(() => config.value.name, n => (saveName.value = n))
const ollamaViaV1 = () => config.value.backend.kind === 'openai' && /:11434/.test(config.value.backend.baseUrl)
function applyPreset(k: keyof typeof PRESETS) {
  config.value.systemPrompt = PRESETS[k]
  if (!config.value.toolCalls.promptedTemplate) config.value.toolCalls.promptedTemplate = DEFAULT_PROMPTED_TEMPLATE
  if (!config.value.toolCalls.parseErrorHint) config.value.toolCalls.parseErrorHint = DEFAULT_PARSE_ERROR_HINT
}
function family(k: string) { config.value = applyFamily(config.value, k) }
const hermes = () => config.value.toolCalls.format === 'hermes'
function toggleTool(n: HarnessConfig['tools']['enabled'][number]) {
  const set = new Set(config.value.tools.enabled)
  set.has(n) ? set.delete(n) : set.add(n)
  config.value.tools.enabled = TOOL_NAMES.filter(t => set.has(t))
}
/** Absent, not false, when off: v-model would stamp `false` into every harness saved from the UI
 *  and make configDiff show `undefined vs false` against older runs. Same reason mcpServers is deleted. */
function toggleGuard(on: boolean) {
  if (on) config.value.tools.requireReadBeforeEdit = true
  else delete config.value.tools.requireReadBeforeEdit
}

const fmtMcp = (m: HarnessConfig['mcpServers']) => (m && Object.keys(m).length ? JSON.stringify(m, null, 2) : '')
const mcpText = ref(fmtMcp(config.value.mcpServers))
/** Lifted to App: it disables Run as well as Save as, so the two never disagree. */
const mcpErr = defineModel<string>('mcpError', { default: '' })
const mcpCount = () => Object.keys(config.value.mcpServers ?? {}).length
// Not deep: fires when App replaces the whole config (load, a family button), never while typing here.
watch(config, c => { mcpText.value = fmtMcp(c.mcpServers); mcpErr.value = '' })
/** Empty box means no servers at all, so a harness without MCP saves byte-for-byte as before. */
function editMcp(text: string) {
  mcpText.value = text
  const t = text.trim()
  if (!t || t === '{}') { delete config.value.mcpServers; mcpErr.value = ''; return }
  try {
    const v = JSON.parse(t)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('expected an object of server name -> { command, args?, tools? }')
    config.value.mcpServers = v
    mcpErr.value = ''
  } catch (e) { mcpErr.value = (e as Error).message } // last valid value stays in the config; Run and Save as are disabled meanwhile
}
</script>

<template>
  <div>
    <label>Harness</label>
    <div class="row">
      <select @change="emit('load', ($event.target as HTMLSelectElement).value)">
        <option value="">— load —</option><option v-for="n in harnessNames" :key="n" :value="n">{{ n }}</option>
      </select>
      <input type="text" v-model="saveName" placeholder="name" style="width:120px">
      <button @click="emit('saveAs', saveName)" :disabled="!!mcpErr">Save as</button>
    </div>

    <label>Backend</label>
    <div class="row">
      <select v-model="config.backend.kind"><option value="openai">openai-compatible</option><option value="ollama">ollama (native)</option></select>
      <input type="text" v-model.lazy="config.backend.baseUrl">
    </div>
    <div v-if="ollamaViaV1()" class="warn">Ollama via /v1 ignores num_ctx and silently truncates the prompt. Pick kind "ollama".</div>
    <div class="row">
      <select v-model="config.backend.model"><option v-for="m in models" :key="m" :value="m">{{ m }}</option></select>
      <input type="text" v-model="config.backend.model" placeholder="or type a model id">
      <button @click="emit('refreshModels')">↻</button>
    </div>
    <div v-if="modelsError" class="err">{{ modelsError }}</div>
    <div class="row">
      <span>temp</span><input type="number" step="0.1" v-model.number="config.backend.temperature">
      <span>num_ctx</span><input type="number" v-model.number="config.backend.numCtx" :disabled="config.backend.kind !== 'ollama'">
    </div>

    <label>System prompt <span v-for="(_, k) in PRESETS" :key="k"><button @click="applyPreset(k)">{{ k }}</button> </span></label>
    <textarea v-model="config.systemPrompt"></textarea>
    <label>Model family <span v-for="(f, k) in FAMILIES" :key="k"><button :title="f.note" @click="family(k)">{{ k }}</button> </span></label>

    <label>Tools</label>
    <div class="row" style="flex-wrap:wrap">
      <span v-for="n in TOOL_NAMES" :key="n"><input type="checkbox" :checked="config.tools.enabled.includes(n)" @change="toggleTool(n)"> {{ n }}</span>
    </div>
    <div><input type="checkbox" v-model="config.tools.approveBash"> ask before running bash</div>
    <div><input type="checkbox" :checked="!!config.tools.requireReadBeforeEdit" @change="toggleGuard(($event.target as HTMLInputElement).checked)"> refuse to edit a file that has not been read</div>
    <details><summary>MCP servers ({{ mcpCount() }})</summary>
      <textarea :value="mcpText" @input="editMcp(($event.target as HTMLTextAreaElement).value)" style="min-height:80px"
        placeholder='{"fs": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "tools": ["read_text_file"]}}'></textarea>
      <div v-if="mcpErr" class="err">invalid JSON — not saved, Run disabled: {{ mcpErr }}</div>
    </details>

    <label>Tool calls</label>
    <div class="row">
      <select v-model="config.toolCalls.mode"><option value="native">native (tools[] in API)</option><option value="prompted">prompted (in text)</option></select>
      <select v-if="config.toolCalls.mode === 'prompted'" v-model="config.toolCalls.format"><option value="json">json {calls, final}</option><option value="hermes">hermes &lt;tool_call&gt;</option></select>
      <span v-if="config.toolCalls.mode === 'prompted' && !hermes()"><input type="checkbox" v-model="config.toolCalls.enforceSchema"> enforce schema</span>
    </div>
    <details v-if="config.toolCalls.mode === 'prompted'"><summary>prompted template / parse-error hint</summary>
      <textarea v-model="config.toolCalls.promptedTemplate"></textarea>
      <textarea v-model="config.toolCalls.parseErrorHint" style="min-height:50px"></textarea>
    </details>

    <label>Context</label>
    <div class="row">
      <span>max tool output chars</span><input type="number" v-model.number="config.context.maxToolOutputChars">
      <span>budget tokens (0=off)</span><input type="number" v-model.number="config.context.budgetTokens">
    </div>
    <label>Loop</label>
    <div class="row"><span>max turns</span><input type="number" v-model.number="config.loop.maxTurns"></div>
  </div>
</template>
