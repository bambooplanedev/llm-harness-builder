<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { HarnessConfig, ServerInfo } from './api'
import { PRESETS, FAMILIES, applyFamily, DEFAULT_PROMPTED_TEMPLATE, DEFAULT_PARSE_ERROR_HINT } from '../../src/core/prompts'
import { TOOL_NAMES, REASONING_EFFORTS, keyNote, type ReasoningEffort } from '../../src/core/config'
import { t, type Key } from './i18n'
import { advancedSet } from './advanced'

const config = defineModel<HarnessConfig>({ required: true })
const props = defineProps<{ models: string[]; modelsError: string; harnessNames: string[]; modelInfo?: ServerInfo }>()
const emit = defineEmits<{ refreshModels: []; load: [name: string]; saveAs: [name: string] }>()

const saveName = ref(config.value.name)
watch(() => config.value.name, n => (saveName.value = n))
/** A decimal comma is a decimal point; text that is no number leaves the value alone. */
const setTemp = (v: string) => { const n = Number(v.replace(',', '.')); if (v.trim() && Number.isFinite(n)) config.value.backend.temperature = n }
/** A knob the model does not take cannot be turned; its value stays in the harness, so another model gets it back.
 *  Same pairs as knobsOff: the repeat knobs go with what they change. */
const off = (k: 'temperature' | 'maxTokens' | 'think' | 'reasoningEffort') => props.modelInfo?.takes?.[k] === false
const lockedThinkTokens = () => off('think') || off('maxTokens')
const locked = () => [off('temperature') && 'temp', off('maxTokens') && 'max_tokens', off('think') && 'think', off('reasoningEffort') && 'reasoning'].filter(Boolean).join(', ')
const lockedRepeat = () => off('temperature') || lockedThinkTokens()
const advN = computed(() => advancedSet(config.value))
/** Open or closed is the reader's, kept across reloads; storage may be absent or throw (private window). */
const advOpen = (() => { try { return localStorage.getItem('lhb.advanced') === '1' } catch { return false } })()
const saveAdv = (open: boolean) => { try { localStorage.setItem('lhb.advanced', open ? '1' : '0') } catch { /* not kept */ } }
const ollamaViaV1 = () => config.value.backend.kind === 'openai' && /:11434/.test(config.value.backend.baseUrl)
function applyPreset(k: keyof typeof PRESETS) {
  config.value.systemPrompt = PRESETS[k]
  if (!config.value.toolCalls.promptedTemplate) config.value.toolCalls.promptedTemplate = DEFAULT_PROMPTED_TEMPLATE
  if (!config.value.toolCalls.parseErrorHint) config.value.toolCalls.parseErrorHint = DEFAULT_PARSE_ERROR_HINT
}
/** What the last family button changed, while the config is still the one it made; any other swap (load, a bench run) clears it. */
const familyChanged = ref<{ key: string; changes: { k: Key; p?: Record<string, string> }[]; config: HarnessConfig } | null>(null)
function family(k: keyof typeof FAMILIES) {
  const a = config.value, b = applyFamily(a, k), suffix = FAMILIES[k].systemSuffix
  const lastLine = (p: string) => p.trimEnd().split('\n').at(-1)!.trim()
  type Change = { k: Key; p?: Record<string, string> }
  const ch = (k: Key, p?: Change['p']): Change => ({ k, p })
  const changes = [
    a.toolCalls.mode !== b.toolCalls.mode && ch('family.mode', { a: a.toolCalls.mode, b: b.toolCalls.mode }),
    b.toolCalls.mode === 'prompted' && (a.toolCalls.format ?? 'json') !== b.toolCalls.format && ch('family.format', { a: a.toolCalls.format ?? 'json', b: b.toolCalls.format! }),
    a.toolCalls.promptedTemplate !== b.toolCalls.promptedTemplate && ch('family.template'),
    a.toolCalls.parseErrorHint !== b.toolCalls.parseErrorHint && ch('family.hint'),
    lastLine(a.systemPrompt) !== lastLine(b.systemPrompt) && (suffix && lastLine(b.systemPrompt) === suffix ? ch('family.added', { line: suffix }) : ch('family.removed', { line: lastLine(a.systemPrompt) })),
  ].filter((c): c is Change => !!c)
  config.value = b
  familyChanged.value = { key: k, changes, config: b }
}
const hermes = () => config.value.toolCalls.format === 'hermes'
function toggleTool(n: HarnessConfig['tools']['enabled'][number]) {
  const set = new Set(config.value.tools.enabled)
  set.has(n) ? set.delete(n) : set.add(n)
  config.value.tools.enabled = TOOL_NAMES.filter(t => set.has(t))
}
/** Absent, not false or '', when off or empty: v-model would stamp `false` into every harness saved from the UI and make
 *  configDiff show `undefined vs false` against older runs, and an empty or useless box would save a value the validator
 *  refuses. Same reason mcpServers is deleted. */
function put<T extends object, K extends keyof T>(o: T, k: K, v: T[K] | undefined) {
  if (v === undefined) Reflect.deleteProperty(o, k)
  else o[k] = v
}
const posInt = (text: string) => { const n = Number(text); return Number.isInteger(n) && n > 0 ? n : undefined }
const toggleGuard = (on: boolean) => put(config.value.tools, 'requireReadBeforeEdit', on || undefined)
const setMaxTokens = (text: string) => put(config.value.backend, 'maxTokens', posInt(text))
/** Empty keeps the built-in limit. */
const setToolLimit = (k: 'readMaxBytes' | 'bashMaxBytes' | 'bashTimeoutS', text: string) => put(config.value.tools, k, posInt(text))
/** Same rule for the context limits; an emptied section goes too. */
function setContext(k: 'maxToolOutputChars' | 'budgetTokens', text: string) {
  const n = Number(text)
  const cx = config.value.context ??= {}
  put(cx, k, text !== '' && Number.isInteger(n) && n >= (k === 'budgetTokens' ? 0 : 1) ? n : undefined)
  if (!Object.keys(cx).length) delete config.value.context
}
/** Three states, and the first is no key at all: absent, nothing about thinking is sent. */
const setThink = (text: string) => put(config.value.backend, 'think', text === '' ? undefined : text === 'on')
/** Empty removes the key, so nothing is sent; any other text is one of the three efforts the select offers. */
const setReasoning = (text: string) => put(config.value.backend, 'reasoningEffort', (text || undefined) as ReasoningEffort | undefined)
/** Checked turns the section on keeping its budget; unchecked turns it off and keeps the budget for the next check. */
const toggleNotes = (on: boolean) => { config.value.notes = { enabled: on, maxTokens: config.value.notes?.maxTokens ?? 1000 } }
/** An empty box removes the key: the backend is keyless again, as before. */
const setKeyEnv = (text: string) => put(config.value.backend, 'apiKeyEnv', text.trim() || undefined)
/** Where the key goes; nothing for a name or a URL validation would refuse, so a key pasted as a name is never shown. */
const keyLine = () => keyNote(config.value.backend) && t('form.keyNote', { env: config.value.backend.apiKeyEnv!, host: new URL(config.value.backend.baseUrl).host })

/** The optional loop knobs: what a value may be is validateConfig's to say, its message names the knob and what it needs. */
const finite = (text: string) => text.trim() && Number.isFinite(Number(text)) ? Number(text) : undefined
const setLoop = (k: 'maxRepeats' | 'repeatTemperature' | 'repeatThinkTokens' | 'freshContext', text: string) => put(config.value.loop, k, finite(text))
const setEscalation = (text: string) => put(config.value.tools, 'editMissEscalation', finite(text))
const setUntilBash = (text: string) => put(config.value.loop, 'untilBash', text.trim() ? text : undefined)

const fmtMcp = (m: HarnessConfig['mcpServers']) => (m && Object.keys(m).length ? JSON.stringify(m, null, 2) : '')
const mcpText = ref(fmtMcp(config.value.mcpServers))
/** Lifted to App: it disables Run as well as Save as, so the two never disagree. */
const mcpErr = defineModel<string>('mcpError', { default: '' })
const mcpCount = () => Object.keys(config.value.mcpServers ?? {}).length
// Not deep: fires when App replaces the whole config (load, a family button), never while typing here.
watch(config, c => { mcpText.value = fmtMcp(c.mcpServers); mcpErr.value = ''; if (c !== familyChanged.value?.config) familyChanged.value = null })
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
    <label :title="t('h.harness')">Harness</label>
    <div class="row">
      <select @change="emit('load', ($event.target as HTMLSelectElement).value)">
        <option value="">— load —</option><option v-for="n in harnessNames" :key="n" :value="n">{{ n }}</option>
      </select>
      <input type="text" v-model="saveName" placeholder="name" style="width:120px">
      <button @click="emit('saveAs', saveName)" :disabled="!!mcpErr">Save as</button>
    </div>
    <div v-if="config.description" class="hint film-hide">{{ config.description }}</div>

    <label class="film-hide" :title="t('h.backend')">Backend</label>
    <div class="row film-hide">
      <select v-model="config.backend.kind"><option value="openai">openai-compatible</option><option value="ollama">ollama (native)</option><option value="anthropic">anthropic (native)</option></select>
      <input type="text" v-model.lazy="config.backend.baseUrl">
    </div>
    <div v-if="ollamaViaV1()" class="warn">{{ t('form.ollamaV1') }}</div>
    <div class="row film-hide">
      <span :title="t('h.keyEnv')">key env</span>
      <input type="text" :value="config.backend.apiKeyEnv ?? ''" placeholder="none (a local server)" @change="setKeyEnv(($event.target as HTMLInputElement).value)">
    </div>
    <div v-if="keyLine()" class="hint film-hide">{{ keyLine() }}</div>
    <div v-if="keyLine() && !models.length" class="hint film-hide">{{ t('form.refreshKey') }}</div>
    <div class="row film-hide">
      <select v-model="config.backend.model" :title="t('h.model')"><option v-for="m in models" :key="m" :value="m">{{ m }}</option></select>
      <input type="text" v-model.lazy="config.backend.model" placeholder="or type a model id">
      <button @click="emit('refreshModels')">↻</button>
    </div>
    <div v-if="modelsError" class="err film-hide">{{ modelsError }}</div>
    <div class="row">
      <span :title="t('h.temp')">temp</span><input type="text" inputmode="decimal" :value="config.backend.temperature" :disabled="off('temperature')" @change="setTemp(($event.target as HTMLInputElement).value)">
      <span :title="t('h.numCtx')">num_ctx</span><input type="number" v-model.number="config.backend.numCtx" :disabled="config.backend.kind !== 'ollama'">
      <span :title="t('h.maxTokens')">max_tokens</span><input type="number" min="1" :value="config.backend.maxTokens ?? ''" :disabled="off('maxTokens')" @change="setMaxTokens(($event.target as HTMLInputElement).value)">
      <span :title="t('h.think')">think</span><select :value="config.backend.think === undefined ? '' : config.backend.think ? 'on' : 'off'" :disabled="off('think')" @change="setThink(($event.target as HTMLSelectElement).value)"><option value="">—</option><option>on</option><option>off</option></select>
      <span :title="t('h.reasoning')">reasoning</span><select :value="config.backend.reasoningEffort ?? ''" :disabled="off('reasoningEffort') || (config.backend.kind !== 'openai' && !config.backend.reasoningEffort)" @change="setReasoning(($event.target as HTMLSelectElement).value)"><option value="">—</option><option v-for="e in REASONING_EFFORTS" :key="e">{{ e }}</option></select>
    </div>
    <div v-if="locked()" class="hint">{{ t('form.locked', { knobs: locked() }) }}<span v-if="modelInfo?.takesFrom"> ({{ modelInfo.takesFrom }})</span></div>

    <div class="label"><span :title="t('h.systemPrompt')">System prompt</span> <span v-for="(_, k) in PRESETS" :key="k"><button @click="applyPreset(k)">{{ k }}</button> </span></div>
    <textarea v-model="config.systemPrompt"></textarea>
    <div class="label"><span :title="t('h.family')">Model family</span> <span v-for="(f, k) in FAMILIES" :key="k"><button :title="t(`h.family.${k}`)" @click="family(k)">{{ k }}</button> </span></div>
    <div v-if="familyChanged" class="hint">{{ familyChanged.key }}: {{ familyChanged.changes.length ? familyChanged.changes.map(c => t(c.k, c.p)).join('; ') : t('form.familyNone') }}</div>

    <label :title="t('h.tools')">Tools</label>
    <div class="row" style="flex-wrap:wrap">
      <span v-for="n in TOOL_NAMES" :key="n"><input type="checkbox" :checked="config.tools.enabled.includes(n)" @change="toggleTool(n)"> {{ n }}</span>
    </div>
    <div :title="t('h.approveBash')"><input type="checkbox" v-model="config.tools.approveBash"> ask before running bash</div>
    <div v-if="config.tools.bashEnv?.length" class="hint">{{ t('form.bashEnv', { list: config.tools.bashEnv.join(', ') }) }}</div>
    <label :title="t('h.toolCalls')">Tool calls</label>
    <div class="row">
      <select v-model="config.toolCalls.mode"><option value="native">native (tools[] in API)</option><option value="prompted">prompted (in text)</option></select>
      <select v-if="config.toolCalls.mode === 'prompted'" :title="t('h.format')" :value="config.toolCalls.format ?? 'json'" @change="config.toolCalls.format = ($event.target as HTMLSelectElement).value as 'json' | 'hermes'"><option value="json">json {calls, final}</option><option value="hermes">hermes &lt;tool_call&gt;</option></select>
      <span v-if="config.toolCalls.mode === 'prompted' && !hermes()" :title="t('h.enforceSchema')"><input type="checkbox" v-model="config.toolCalls.enforceSchema"> enforce schema</span>
    </div>
    <label>Loop</label>
    <div class="row"><span :title="t('h.maxTurns')">max turns</span><input type="number" v-model.number="config.loop.maxTurns"></div>
    <details class="advanced" :open="advOpen" @toggle="saveAdv(($event.target as HTMLDetailsElement).open)"><summary :title="t('h.advanced')">Advanced{{ advN ? ` · ${advN} set` : '' }}</summary>
    <div :title="t('h.guard')"><input type="checkbox" :checked="!!config.tools.requireReadBeforeEdit" @change="toggleGuard(($event.target as HTMLInputElement).checked)"> refuse to edit a file that has not been read</div>
    <div class="row"><span :title="t('h.escalation')">edit misses before a re-read note</span><input type="number" min="1" :value="config.tools.editMissEscalation ?? ''" @change="setEscalation(($event.target as HTMLInputElement).value)"></div>
    <div class="row"><span :title="t('h.readMax')">read_file max bytes</span><input type="number" min="1" placeholder="4194304 (default)" :value="config.tools.readMaxBytes ?? ''" @change="setToolLimit('readMaxBytes', ($event.target as HTMLInputElement).value)"></div>
    <div :title="t('h.readRanges')"><input type="checkbox" :checked="!!config.tools.readRanges" @change="put(config.tools, 'readRanges', ($event.target as HTMLInputElement).checked || undefined)"> read_file line ranges (start/end)</div>
    <div :title="t('h.notes')"><input type="checkbox" :checked="!!config.notes?.enabled" @change="toggleNotes(($event.target as HTMLInputElement).checked)"> notes from earlier runs</div>
    <div class="row"><span :title="t('h.bashMax')">bash max bytes</span><input type="number" min="1" placeholder="1048576 (default)" :value="config.tools.bashMaxBytes ?? ''" @change="setToolLimit('bashMaxBytes', ($event.target as HTMLInputElement).value)"></div>
    <div class="row"><span :title="t('h.bashTimeout')">bash timeout, s</span><input type="number" min="1" placeholder="30 (default)" :value="config.tools.bashTimeoutS ?? ''" @change="setToolLimit('bashTimeoutS', ($event.target as HTMLInputElement).value)"></div>
    <details><summary :title="t('h.mcp')">MCP servers ({{ mcpCount() }})</summary>
      <textarea class="film-hide" :value="mcpText" @input="editMcp(($event.target as HTMLTextAreaElement).value)" style="min-height:80px"
        placeholder='{"fs": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "tools": ["read_text_file"]}}'></textarea>
      <div v-if="mcpErr" class="err">invalid JSON — not saved, Run disabled: {{ mcpErr }}</div>
    </details>

    <details v-if="config.toolCalls.mode === 'prompted'"><summary>prompted template / parse-error hint</summary>
      <textarea v-model="config.toolCalls.promptedTemplate"></textarea>
      <textarea v-model="config.toolCalls.parseErrorHint" style="min-height:50px"></textarea>
    </details>

    <label>Context</label>
    <div class="row">
      <span :title="t('h.maxToolOutput')">max tool output chars</span><input type="number" min="1" :value="config.context?.maxToolOutputChars ?? ''" @change="setContext('maxToolOutputChars', ($event.target as HTMLInputElement).value)">
      <span :title="t('h.budget')">budget tokens</span><input type="number" min="0" :value="config.context?.budgetTokens ?? ''" @change="setContext('budgetTokens', ($event.target as HTMLInputElement).value)">
    </div>
    <div class="row">
      <span :title="t('h.maxRepeats')">max repeats</span><input type="number" min="0" :value="config.loop.maxRepeats ?? ''" @change="setLoop('maxRepeats', ($event.target as HTMLInputElement).value)">
      <span :title="t('h.freshContext')">fresh context</span><input type="number" min="1" :value="config.loop.freshContext ?? ''" @change="setLoop('freshContext', ($event.target as HTMLInputElement).value)">
    </div>
    <div class="row">
      <span :title="t('h.repeatTemp')">repeat temperature</span><input type="number" min="0" max="2" step="0.1" :value="config.loop.repeatTemperature ?? ''" :disabled="off('temperature')" @change="setLoop('repeatTemperature', ($event.target as HTMLInputElement).value)">
      <span :title="t('h.repeatThink')">repeat think tokens</span><input type="number" min="1" :value="config.loop.repeatThinkTokens ?? ''" :disabled="lockedThinkTokens()" @change="setLoop('repeatThinkTokens', ($event.target as HTMLInputElement).value)">
    </div>
    <div class="row"><span :title="t('h.untilBash')">until bash</span><input type="text" :value="config.loop.untilBash ?? ''" @change="setUntilBash(($event.target as HTMLInputElement).value)"></div>
      <div v-if="lockedRepeat()" class="hint">{{ t('form.locked', { knobs: locked() }) }}<span v-if="modelInfo?.takesFrom"> ({{ modelInfo.takesFrom }})</span></div>
    </details>
  </div>
</template>
