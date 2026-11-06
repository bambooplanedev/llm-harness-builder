<script setup lang="ts">
import { computed, reactive } from 'vue'
import Anatomy from './Anatomy.vue'
import ReqDiff from './ReqDiff.vue'
import Sources from './Sources.vue'
import { t, tn, T } from './i18n'
import type { Delta, HarnessEvent } from './api'
import { mcpApprovalServer, mcpCounts, UNTIL_BASH } from '../../src/core/events'
import { analyzeTrace, summaryLine } from '../../src/core/analyze'
import { diffsBySeq, versusBySeq, sourcesOf } from './reqDiffs'
import { lineLabels, type Source } from '../../src/core/sources'
import type { ReqDiff as ReqDiffT } from '../../src/core/diff'
import { anatomies, anatomyLine } from '../../src/core/anatomy'
import { film, filmDeep, filmText, namesIn, shown, type FilmNames } from './film'
// approvable is a Boolean-typed prop, so Vue casts an ABSENT value to `false` (not `undefined`).
// App.vue's live Workbench never passes this prop and needs the opposite default -- only a
// finished/replayed trace (Bench.vue, Diff.vue) opts out by passing `false` explicitly.
// `live` is only ever set by the live Workbench; a replayed trace (Bench.vue, Diff.vue) omits it.
const props = withDefaults(defineProps<{ events: HarnessEvent[]; live?: Delta; task?: string; approvable?: boolean; bars?: boolean; names?: FilmNames; compareEvents?: HarnessEvent[]; compareId?: string }>(), { approvable: true, bars: true, live: () => ({}) })
const emit = defineEmits<{ approve: [callId: string, ok: boolean] }>()
/** `names`: the models and servers the page knows of (the trace names no server, and a live run's knobs_off comes before its first model). */
const names = computed(() => ({ models: [...namesIn(props.events).models, ...props.compareEvents ? namesIn(props.compareEvents).models : [], ...props.names?.models ?? []], urls: props.names?.urls ?? [] }))
/** What the screen shows: in film mode a copy with model names, servers and paths replaced. */
const shownEvents = computed(() => film.value ? filmDeep(props.events, names.value) : props.events)
/** A live approval shows the command exactly as it will run, film mode or not: you approve what executes. */
const command = (seq: number) => (props.events.find(e => e.seq === seq) as Extract<HarnessEvent, { type: 'approval_required' }>).call.args.command

const turns = computed(() => {
  const map = new Map<number, HarnessEvent[]>()
  for (const e of shownEvents.value) { if (!map.has(e.turn)) map.set(e.turn, []); map.get(e.turn)!.push(e) }
  return [...map.entries()]
})
const answered = computed(() => {
  const ids = new Set(props.events.filter(e => e.type === 'tool_result').map(e => (e as any).callId))
  // A server-start approval never produces a tool_result; once the server has started (or the
  // run has ended some other way), treat every mcp: approval as answered so its buttons don't
  // stay live forever and a second click doesn't 404.
  if (props.events.some(e => e.type === 'mcp_server_start' || e.type === 'done')) {
    for (const e of props.events) if (e.type === 'approval_required' && mcpApprovalServer(e.call.name)) ids.add(e.call.callId)
  }
  // Nor does an untilBash approval. The run waits on it, so any later event means it was answered.
  const lastSeq = props.events.length ? props.events[props.events.length - 1].seq : -1
  for (const e of props.events) if (e.type === 'approval_required' && e.call.name === UNTIL_BASH && e.seq < lastSeq) ids.add(e.call.callId)
  return ids
})
const analysis = computed(() => analyzeTrace(shownEvents.value))
const summary = computed(() => shownEvents.value.length ? summaryLine(analysis.value) : '')
/** callId → the turn whose request first went out without that result. */
const stubbedAt = computed(() => {
  const m = new Map<string, number>(), s = analysis.value.stubs
  if (s !== 'unknown') for (const st of s) for (const it of st.items) if (it.callId && !m.has(it.callId)) m.set(it.callId, st.turn)
  return m
})
const pretty = (v: unknown) => JSON.stringify(v, null, 2)
/** The raw request/response dump, once per event object: a live delta re-renders every turn, and an event never changes after it arrives (a film copy is a new object). */
const rawText = new WeakMap<object, string>()
const raw = (e: HarnessEvent) => rawText.get(e) ?? (rawText.set(e, pretty(e.type === 'llm_request' ? e.payload : (e as Extract<HarnessEvent, { type: 'llm_response' }>).raw)), rawText.get(e)!)
/** The CLI's knobs_off line: what the file sets and was not sent, and who said so. */
const knobsOff = computed(() => shownEvents.value.flatMap(e => e.type === 'knobs_off' ? e.off.map(o => `${o.knob} ${JSON.stringify(o.value)} not sent: ${o.reason}`) : []))
/** The anatomy of every request the trace shows, and the same by event seq: counts only, from the trace as recorded. */
const anat = computed(() => anatomies(props.events))
/** Strip column click: open that turn's inspector (view A) and scroll to it. */
const turnEls = new Map<number, HTMLElement>()
function pick(turn: number) {
  const el = turnEls.get(turn)
  const d = el?.querySelector('details.inspector') as HTMLDetailsElement | null
  if (d) d.open = true
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
/** Computed from the events as recorded (cached per event), then filmed: the result is small, the bodies are not. */
const filmed = new WeakMap<object, { key: string; out: unknown }>()
/** f once per (object, names): a new event must not rebuild every block. */
const filmOnce = <T extends object>(x: T, f: (x: T, n: FilmNames) => T): T => {
  const key = JSON.stringify(names.value), c = filmed.get(x)
  if (c?.key === key) return c.out as T
  const out = f(x, names.value); filmed.set(x, { key, out }); return out
}
const filmedDiff = (d: ReqDiffT): ReqDiffT => filmOnce(d, filmDeep)
/** Inspectors that are open, by turn: sources and line labels are read only for these. */
const openTurns = reactive(new Set<number>())
const onToggle = (turn: number, ev: Event) => { if ((ev.target as HTMLDetailsElement).open) openTurns.add(turn); else openTurns.delete(turn) }
const eventBySeq = computed(() => new Map(props.events.map(e => [e.seq, e])))
/** seq of an llm_request → seq of the llm_request before it (the pair diffsBySeq compares). */
const prevReq = computed(() => {
  const m = new Map<number, number>()
  let p: number | undefined
  for (const e of props.events) if (e.type === 'llm_request') { if (p !== undefined) m.set(e.seq, p); p = e.seq }
  return m
})
const filmSources = (s: Source[], n: FilmNames): Source[] => s.map(x => ({ ...x, where: filmText(x.where, n), label: filmText(x.label, n), text: filmText(x.text, n) }))
/** The sources of a request as recorded (cached per event), filmed once per array in film mode. */
const sourcesAt = (seq: number | undefined): Source[] | undefined => {
  const e = seq === undefined ? undefined : eventBySeq.value.get(seq), s = e && sourcesOf(e)
  return s && film.value ? filmOnce(s, filmSources) : s
}
/** line → label, once per sources array; from filmed sources in film mode, so keys and labels match the filmed diff. */
const labelCache = new WeakMap<Source[], Map<string, string>>()
const labelsAt = (seq: number | undefined) => {
  const s = sourcesAt(seq)
  if (!s) return undefined
  let m = labelCache.get(s)
  if (!m) labelCache.set(s, m = lineLabels(s))
  return m
}
const diffBySeq = computed(() => {
  const m = diffsBySeq(props.events)
  return film.value ? new Map([...m].map(([k, d]) => [k, filmedDiff(d)])) : m
})
/** The same against the other run's same-numbered request; the bodies are read as recorded, only the result is filmed. */
const versusBySeqM = computed(() => {
  const m = props.compareEvents ? versusBySeq(props.events, props.compareEvents) : new Map()
  return film.value ? new Map([...m].map(([k, v]) => [k, v.diff ? { ...v, diff: filmedDiff(v.diff) } : v])) : m
})
const anatBySeq = computed(() => new Map(anat.value.map(x => [x.seq, x.a])))
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
  <div v-if="summary" class="analysis">{{ summary }}</div>
  <div v-for="k in knobsOff" :key="k" class="warn">{{ k }}</div>
  <Anatomy v-if="bars" :items="anat" @pick="pick" />
  <div v-if="task" class="ev user">{{ shown(task, names) }}</div>
  <div v-for="[turn, evs] in turns" :key="turn" class="turn" :ref="(el: any) => { el ? turnEls.set(turn, el) : turnEls.delete(turn) }">
    <template v-for="e in evs" :key="e.seq">
      <div v-if="e.type === 'llm_response'" class="ev assistant">
        <div v-if="e.reasoning" class="muted">thinking: {{ e.reasoning }}</div>{{ e.content || '(empty content)' }}
        <small class="muted"> · {{ e.latencyMs }}ms<template v-if="e.costUsd !== undefined"> · ${{ Number(e.costUsd.toPrecision(4)) }}</template></small>
      </div>
      <div v-else-if="e.type === 'parse_error'" class="ev parse_error">parse error: {{ e.message }}<span v-if="e.droppedChars"> · {{ tn('trace.dropped', e.droppedChars) }}</span></div>
      <div v-else-if="e.type === 'tool_call'" class="ev tool_call">{{ e.call.name }} {{ pretty(e.call.args) }}</div>
      <div v-else-if="e.type === 'approval_required' && !answered.has(e.call.callId)" class="ev approval">
        <template v-if="props.approvable !== false">
          <T v-if="mcpApprovalServer(e.call.name)" k="trace.askMcp"><template #name><code>{{ mcpApprovalServer(e.call.name) }}</code></template><template #cmd><code>{{ command(e.seq) }}</code></template></T>
          <T v-else-if="e.call.name === UNTIL_BASH" k="trace.askUntil"><template #cmd><code>{{ command(e.seq) }}</code></template></T>
          <T v-else k="trace.askRun"><template #cmd><code>{{ command(e.seq) }}</code></template></T>
          <button @click="emit('approve', e.call.callId, true)">Run</button> <button @click="emit('approve', e.call.callId, false)">Deny</button>
        </template>
        <template v-else>approval_required: <code>{{ e.call.args.command }}</code> ({{ t('trace.autoApproved') }})</template>
      </div>
      <div v-else-if="e.type === 'final_check'" class="ev tool_result" :class="{ err: !e.passed }">final check <code>{{ e.command }}</code>: {{ e.passed ? 'passed' : t('trace.checkFailed') }}<template v-if="!e.passed"><br>{{ e.output }}</template></div>
      <div v-else-if="e.type === 'context_reset'" class="ev parse_error">{{ tn('trace.reset', e.chars) }}</div>
      <div v-else-if="e.type === 'proxy_note'" class="ev muted">
        <template v-if="e.kind === 'compaction'">compaction · {{ t('trace.compaction') }}</template>
        <template v-else>auxiliary · {{ e.model }}<template v-if="e.error !== undefined"> · failed: {{ e.error }}</template><template v-else><template v-if="e.usage"> · {{ e.usage.promptTokens }}+{{ e.usage.completionTokens }} tok</template> · {{ e.latencyMs }}ms</template></template>
      </div>
      <div v-else-if="e.type === 'notes_loaded'" class="ev muted">notes: {{ e.ids.length }} loaded · {{ e.chars }} chars</div>
      <div v-else-if="e.type === 'note_written'" class="ev muted"><template v-if="e.error !== undefined">note not written: {{ e.error }}</template><template v-else-if="e.notes.length"><template v-for="n in e.notes" :key="n.id">note: {{ n.text }}<br></template></template><template v-else>note: nothing new</template></div>
      <div v-else-if="e.type === 'mcp_server_start'" class="ev tool_call">
        mcp <code>{{ e.server }}</code>: {{ mcpCounts(e) }}
      </div>
      <div v-else-if="e.type === 'tool_result'" class="ev tool_result" :class="{ err: e.error }">{{ e.output }}<small v-if="e.truncated" class="warn"> [truncated]</small><small v-if="stubbedAt.has(e.callId)" class="stubbed"> [stubbed at t{{ stubbedAt.get(e.callId) }}]</small></div>
      <div v-else-if="e.type === 'error'" class="ev error">{{ e.message }}<br>{{ e.body }}</div>
      <div v-else-if="e.type === 'done'" class="ev" :class="{ parse_error: e.reason === 'final' && e.toolCallCount === 0 }"><b>done: {{ e.reason }}</b> · {{ e.turns }} turns · {{ e.toolCallCount }} tool calls<span v-if="e.reason === 'final' && e.toolCallCount === 0"> · {{ t('trace.quit') }}</span></div>
    </template>
    <div v-if="turn === events.at(-1)?.turn && openTurn && (liveText || !done)" class="ev assistant">
      <small class="muted">{{ live.content ? 'answering' : 'thinking' }}…<span v-if="liveText"> ~{{ liveTok }} tok</span><span v-if="done"> · partial, not in the trace</span></small>
      <div v-if="live.reasoning" class="muted">thinking: {{ shown(live.reasoning, names) }}</div>{{ shown(live.content ?? '', names) }}<span v-if="!done">▍</span>
    </div>
    <details class="inspector" @toggle="onToggle(turn, $event)"><summary>{{ turn === 0 ? 'setup' : `turn ${turn}` }} — raw request / response</summary>
      <template v-for="e in evs" :key="'raw' + e.seq">
        <template v-if="e.type === 'llm_request'"><template v-if="anatBySeq.get(e.seq)"><div class="hint" :title="t('trace.anatomySplit')">{{ anatomyLine(anatBySeq.get(e.seq)!) }}</div>
          <div v-if="!anatBySeq.get(e.seq)!.exact" class="hint">{{ t('trace.anatomyEstimate') }}</div>
          <div v-if="anatBySeq.get(e.seq)!.toolsInSystem" class="hint">{{ t('trace.anatomyToolsInSystem') }}</div>
          <div v-if="anatBySeq.get(e.seq)!.thinkingBlocks" class="hint">{{ t('trace.anatomyThinking') }}</div></template><Sources v-if="openTurns.has(turn) && sourcesAt(e.seq)?.length" :sources="sourcesAt(e.seq)!" />
          <ReqDiff v-if="diffBySeq.get(e.seq)" :diff="diffBySeq.get(e.seq)!" title="changes since the previous request"
            :labels-a="openTurns.has(turn) ? labelsAt(prevReq.get(e.seq)) : undefined" :labels-b="openTurns.has(turn) ? labelsAt(e.seq) : undefined" />
          <template v-if="versusBySeqM.get(e.seq)"><div v-if="versusBySeqM.get(e.seq)!.missing" class="muted">no request {{ versusBySeqM.get(e.seq)!.k }} there</div>
            <ReqDiff v-else :diff="versusBySeqM.get(e.seq)!.diff!" :title="`vs ${compareId} request ${versusBySeqM.get(e.seq)!.k}`" :hint="t('trace.reqDiffVs')" /></template><pre>{{ raw(e) }}</pre></template>
        <pre v-if="e.type === 'llm_response'">{{ raw(e) }}</pre>
      </template>
    </details>
  </div>
</template>
