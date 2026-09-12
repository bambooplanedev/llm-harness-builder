<script setup lang="ts">
import { computed } from 'vue'
import type { Delta, HarnessEvent } from './api'
const props = defineProps<{ events: HarnessEvent[]; live: Delta; task: string }>()
const emit = defineEmits<{ approve: [callId: string, ok: boolean] }>()

const turns = computed(() => {
  const map = new Map<number, HarnessEvent[]>()
  for (const e of props.events) { if (!map.has(e.turn)) map.set(e.turn, []); map.get(e.turn)!.push(e) }
  return [...map.entries()]
})
const answered = computed(() => new Set(props.events.filter(e => e.type === 'tool_result').map(e => (e as any).callId)))
const pretty = (v: unknown) => JSON.stringify(v, null, 2)
// The current turn is "open" from its llm_request until its llm_response; the live bubble shows the streamed text meanwhile,
// and stays (without the cursor) if the run ended first, since that text is not in the trace.
const done = computed(() => props.events.some(e => e.type === 'done'))
const openTurn = computed(() => {
  const last = props.events.at(-1)?.turn
  const evs = props.events.filter(e => e.turn === last)
  return evs.some(e => e.type === 'llm_request') && !evs.some(e => e.type === 'llm_response')
})
const liveText = computed(() => (props.live.reasoning ?? '') + (props.live.content ?? ''))
const liveTok = computed(() => Math.ceil(liveText.value.length / 4))
</script>
<template>
  <div class="ev user">{{ task }}</div>
  <div v-for="[turn, evs] in turns" :key="turn" class="turn">
    <template v-for="e in evs" :key="e.seq">
      <div v-if="e.type === 'llm_response'" class="ev assistant">
        <div v-if="e.reasoning" style="color:#888">thinking: {{ e.reasoning }}</div>{{ e.content || '(empty content)' }}
        <small style="color:#888"> · {{ e.latencyMs }}ms</small>
      </div>
      <div v-else-if="e.type === 'parse_error'" class="ev parse_error">parse error: {{ e.message }}</div>
      <div v-else-if="e.type === 'tool_call'" class="ev tool_call">{{ e.call.name }} {{ pretty(e.call.args) }}</div>
      <div v-else-if="e.type === 'approval_required' && !answered.has(e.call.callId)" class="ev approval">
        run <code>{{ e.call.args.command }}</code>?
        <button @click="emit('approve', e.call.callId, true)">Run</button> <button @click="emit('approve', e.call.callId, false)">Deny</button>
      </div>
      <div v-else-if="e.type === 'tool_result'" class="ev tool_result" :class="{ err: e.error }">{{ e.output }}<small v-if="e.truncated" class="warn"> [truncated]</small></div>
      <div v-else-if="e.type === 'error'" class="ev error">{{ e.message }}<br>{{ e.body }}</div>
      <div v-else-if="e.type === 'done'" class="ev" :class="{ parse_error: e.reason === 'final' && e.toolCallCount === 0 }"><b>done: {{ e.reason }}</b> · {{ e.turns }} turns · {{ e.toolCallCount }} tool calls<span v-if="e.reason === 'final' && e.toolCallCount === 0"> · final after 0 tool calls: the model quit without doing anything</span></div>
    </template>
    <div v-if="turn === events.at(-1)?.turn && openTurn && (liveText || !done)" class="ev assistant">
      <small style="color:#888">{{ live.content ? 'answering' : 'thinking' }}… ~{{ liveTok }} tok<span v-if="done"> · partial, not in the trace</span></small>
      <div v-if="live.reasoning" style="color:#888">thinking: {{ live.reasoning }}</div>{{ live.content }}<span v-if="!done">▍</span>
    </div>
    <details class="inspector"><summary>turn {{ turn }} — raw request / response</summary>
      <template v-for="e in evs" :key="'raw' + e.seq">
        <pre v-if="e.type === 'llm_request'">{{ pretty(e.payload) }}</pre>
        <pre v-if="e.type === 'llm_response'">{{ pretty(e.raw) }}</pre>
      </template>
    </details>
  </div>
</template>
