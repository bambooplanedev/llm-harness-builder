<script setup lang="ts">
import { ref, watch } from 'vue'
import type { HarnessConfig, ServerInfo } from './api'
import { PRESETS, FAMILIES, applyFamily, DEFAULT_PROMPTED_TEMPLATE, DEFAULT_PARSE_ERROR_HINT } from '../../src/core/prompts'
import { TOOL_NAMES, keyNote } from '../../src/core/config'
import { H } from './hints'

const config = defineModel<HarnessConfig>({ required: true })
const props = defineProps<{ models: string[]; modelsError: string; harnessNames: string[]; modelInfo?: ServerInfo }>()
const emit = defineEmits<{ refreshModels: []; load: [name: string]; saveAs: [name: string] }>()

const saveName = ref(config.value.name)
watch(() => config.value.name, n => (saveName.value = n))
/** A knob the model does not take cannot be turned; its value stays in the harness, so another model gets it back.
 *  Same pairs as knobsOff: the repeat knobs go with what they change. */
const off = (k: 'temperature' | 'maxTokens' | 'think') => props.modelInfo?.takes?.[k] === false
const lockedThinkTokens = () => off('think') || off('maxTokens')
const locked = () => [off('temperature') && 'temp', off('maxTokens') && 'max_tokens', off('think') && 'think'].filter(Boolean).join(', ')
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
/** Same rule: an empty or useless box removes the key instead of saving a value the validator refuses. */
function setMaxTokens(text: string) {
  const n = Number(text)
  if (Number.isInteger(n) && n > 0) config.value.backend.maxTokens = n
  else delete config.value.backend.maxTokens
}
/** Same rule for the tool limits: empty keeps the built-in one. */
function setToolLimit(k: 'readMaxBytes' | 'bashMaxBytes' | 'bashTimeoutS', text: string) {
  const n = Number(text)
  if (Number.isInteger(n) && n > 0) config.value.tools[k] = n
  else delete config.value.tools[k]
}
/** Same rule for the context limits; an emptied section goes too. */
function setContext(k: 'maxToolOutputChars' | 'budgetTokens', text: string) {
  const n = Number(text)
  const cx = config.value.context ??= {}
  if (text !== '' && Number.isInteger(n) && n >= (k === 'budgetTokens' ? 0 : 1)) cx[k] = n
  else delete cx[k]
  if (!Object.keys(cx).length) delete config.value.context
}

/** Three states, and the first is no key at all: absent, nothing about thinking is sent. */
function setThink(text: string) {
  if (text === '') delete config.value.backend.think
  else config.value.backend.think = text === 'on'
}

/** An empty box removes the key: the backend is keyless again, as before. */
function setKeyEnv(text: string) {
  const t = text.trim()
  if (t) config.value.backend.apiKeyEnv = t
  else delete config.value.backend.apiKeyEnv
}
/** Where the key goes; nothing for a name or a URL validation would refuse, so a key pasted as a name is never shown. */
const keyLine = () => keyNote(config.value.backend)

/** Same rule for the optional loop knobs: an empty box removes the key, so a harness without them saves as before.
 *  What a value may be is validateConfig's to say: its message names the knob and what it needs. */
function setLoop(k: 'maxRepeats' | 'repeatTemperature' | 'repeatThinkTokens' | 'freshContext', text: string) {
  if (text.trim() && Number.isFinite(Number(text))) config.value.loop[k] = Number(text)
  else delete config.value.loop[k]
}
function setEscalation(text: string) {
  const n = Number(text)
  if (text.trim() && Number.isFinite(n)) config.value.tools.editMissEscalation = n
  else delete config.value.tools.editMissEscalation
}
function setUntilBash(text: string) {
  if (text.trim()) config.value.loop.untilBash = text
  else delete config.value.loop.untilBash
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
    <label :title="H.harness">Harness</label>
    <div class="row">
      <select @change="emit('load', ($event.target as HTMLSelectElement).value)">
        <option value="">— load —</option><option v-for="n in harnessNames" :key="n" :value="n">{{ n }}</option>
      </select>
      <input type="text" v-model="saveName" placeholder="name" style="width:120px">
      <button @click="emit('saveAs', saveName)" :disabled="!!mcpErr">Save as</button>
    </div>

    <label :title="H.backend">Backend</label>
    <div class="row">
      <select v-model="config.backend.kind"><option value="openai">openai-compatible</option><option value="ollama">ollama (native)</option><option value="anthropic">anthropic (native)</option></select>
      <input type="text" v-model.lazy="config.backend.baseUrl">
    </div>
    <div v-if="ollamaViaV1()" class="warn">Ollama via /v1 ignores num_ctx and silently truncates the prompt. Pick kind "ollama".</div>
    <div class="row">
      <span :title="H.keyEnv">key env</span>
      <input type="text" :value="config.backend.apiKeyEnv ?? ''" placeholder="none (a local server)" @change="setKeyEnv(($event.target as HTMLInputElement).value)">
    </div>
    <div v-if="keyLine()" class="hint">{{ keyLine() }}</div>
    <div v-if="keyLine() && !models.length" class="hint">press ↻ to list the models: that request carries the key</div>
    <div class="row">
      <select v-model="config.backend.model" :title="H.model"><option v-for="m in models" :key="m" :value="m">{{ m }}</option></select>
      <input type="text" v-model.lazy="config.backend.model" placeholder="or type a model id">
      <button @click="emit('refreshModels')">↻</button>
    </div>
    <div v-if="modelsError" class="err">{{ modelsError }}</div>
    <div class="row">
      <span :title="H.temp">temp</span><input type="number" step="0.1" v-model.number="config.backend.temperature" :disabled="off('temperature')">
      <span :title="H.numCtx">num_ctx</span><input type="number" v-model.number="config.backend.numCtx" :disabled="config.backend.kind !== 'ollama'">
      <span :title="H.maxTokens">max_tokens</span><input type="number" min="1" :value="config.backend.maxTokens ?? ''" :disabled="off('maxTokens')" @change="setMaxTokens(($event.target as HTMLInputElement).value)">
      <span :title="H.think">think</span><select :value="config.backend.think === undefined ? '' : config.backend.think ? 'on' : 'off'" :disabled="off('think')" @change="setThink(($event.target as HTMLSelectElement).value)"><option value="">—</option><option>on</option><option>off</option></select>
    </div>
    <div v-if="locked()" class="hint">{{ locked() }}: this knob is not available for this model<span v-if="modelInfo?.takesFrom"> ({{ modelInfo.takesFrom }})</span></div>

    <div class="label"><span :title="H.systemPrompt">System prompt</span> <span v-for="(_, k) in PRESETS" :key="k"><button @click="applyPreset(k)">{{ k }}</button> </span></div>
    <textarea v-model="config.systemPrompt"></textarea>
    <div class="label"><span :title="H.family">Model family</span> <span v-for="(f, k) in FAMILIES" :key="k"><button :title="f.note" @click="family(k)">{{ k }}</button> </span></div>

    <label :title="H.tools">Tools</label>
    <div class="row" style="flex-wrap:wrap">
      <span v-for="n in TOOL_NAMES" :key="n"><input type="checkbox" :checked="config.tools.enabled.includes(n)" @change="toggleTool(n)"> {{ n }}</span>
    </div>
    <div :title="H.approveBash"><input type="checkbox" v-model="config.tools.approveBash"> ask before running bash</div>
    <div v-if="config.tools.bashEnv?.length" class="hint">bash gets from your environment: {{ config.tools.bashEnv.join(', ') }}</div>
    <div :title="H.guard"><input type="checkbox" :checked="!!config.tools.requireReadBeforeEdit" @change="toggleGuard(($event.target as HTMLInputElement).checked)"> refuse to edit a file that has not been read</div>
    <div class="row"><span :title="H.escalation">edit misses before a re-read note</span><input type="number" min="1" :value="config.tools.editMissEscalation ?? ''" @change="setEscalation(($event.target as HTMLInputElement).value)"></div>
    <div class="row"><span :title="H.readMax">read_file max bytes</span><input type="number" min="1" placeholder="4194304 (default)" :value="config.tools.readMaxBytes ?? ''" @change="setToolLimit('readMaxBytes', ($event.target as HTMLInputElement).value)"></div>
    <div class="row"><span :title="H.bashMax">bash max bytes</span><input type="number" min="1" placeholder="1048576 (default)" :value="config.tools.bashMaxBytes ?? ''" @change="setToolLimit('bashMaxBytes', ($event.target as HTMLInputElement).value)"></div>
    <div class="row"><span :title="H.bashTimeout">bash timeout, s</span><input type="number" min="1" placeholder="30 (default)" :value="config.tools.bashTimeoutS ?? ''" @change="setToolLimit('bashTimeoutS', ($event.target as HTMLInputElement).value)"></div>
    <details><summary :title="H.mcp">MCP servers ({{ mcpCount() }})</summary>
      <textarea :value="mcpText" @input="editMcp(($event.target as HTMLTextAreaElement).value)" style="min-height:80px"
        placeholder='{"fs": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "tools": ["read_text_file"]}}'></textarea>
      <div v-if="mcpErr" class="err">invalid JSON — not saved, Run disabled: {{ mcpErr }}</div>
    </details>

    <label :title="H.toolCalls">Tool calls</label>
    <div class="row">
      <select v-model="config.toolCalls.mode"><option value="native">native (tools[] in API)</option><option value="prompted">prompted (in text)</option></select>
      <select v-if="config.toolCalls.mode === 'prompted'" :title="H.format" :value="config.toolCalls.format ?? 'json'" @change="config.toolCalls.format = ($event.target as HTMLSelectElement).value as 'json' | 'hermes'"><option value="json">json {calls, final}</option><option value="hermes">hermes &lt;tool_call&gt;</option></select>
      <span v-if="config.toolCalls.mode === 'prompted' && !hermes()" :title="H.enforceSchema"><input type="checkbox" v-model="config.toolCalls.enforceSchema"> enforce schema</span>
    </div>
    <details v-if="config.toolCalls.mode === 'prompted'"><summary>prompted template / parse-error hint</summary>
      <textarea v-model="config.toolCalls.promptedTemplate"></textarea>
      <textarea v-model="config.toolCalls.parseErrorHint" style="min-height:50px"></textarea>
    </details>

    <label>Context</label>
    <div class="row">
      <span :title="H.maxToolOutput">max tool output chars (empty = no limit)</span><input type="number" min="1" :value="config.context?.maxToolOutputChars ?? ''" @change="setContext('maxToolOutputChars', ($event.target as HTMLInputElement).value)">
      <span :title="H.budget">budget tokens (empty = no budget)</span><input type="number" min="0" :value="config.context?.budgetTokens ?? ''" @change="setContext('budgetTokens', ($event.target as HTMLInputElement).value)">
    </div>
    <label>Loop</label>
    <div class="row"><span :title="H.maxTurns">max turns</span><input type="number" v-model.number="config.loop.maxTurns"></div>
    <div class="row">
      <span :title="H.maxRepeats">max repeats</span><input type="number" min="0" :value="config.loop.maxRepeats ?? ''" @change="setLoop('maxRepeats', ($event.target as HTMLInputElement).value)">
      <span :title="H.freshContext">fresh context</span><input type="number" min="1" :value="config.loop.freshContext ?? ''" @change="setLoop('freshContext', ($event.target as HTMLInputElement).value)">
    </div>
    <div class="row">
      <span :title="H.repeatTemp">repeat temperature</span><input type="number" min="0" max="2" step="0.1" :value="config.loop.repeatTemperature ?? ''" :disabled="off('temperature')" @change="setLoop('repeatTemperature', ($event.target as HTMLInputElement).value)">
      <span :title="H.repeatThink">repeat think tokens</span><input type="number" min="1" :value="config.loop.repeatThinkTokens ?? ''" :disabled="lockedThinkTokens()" @change="setLoop('repeatThinkTokens', ($event.target as HTMLInputElement).value)">
    </div>
    <div class="row"><span :title="H.untilBash">until bash</span><input type="text" :value="config.loop.untilBash ?? ''" @change="setUntilBash(($event.target as HTMLInputElement).value)"></div>
  </div>
</template>
