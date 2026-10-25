<script setup lang="ts">
import { computed, ref } from 'vue'
import { configDiff, lineDiff, skeleton, turnsOf, type DiffSide } from '../../src/core/diff'
import { mmss } from '../../src/core/bench'
import Trace from './Trace.vue'
import { t, tn, T } from './i18n'

const props = defineProps<{ a: DiffSide; b: DiffSide; task: string }>()
defineEmits<{ close: [] }>()

const rows = computed(() => configDiff(props.a.config, props.b.config))
/** Leaves are JSON text, so a multi-line string shows up as a literal \n escape inside it. */
const lines = (r: { a: string; b: string }) => r.a.includes('\\n') || r.b.includes('\\n')
/** A key missing on one side is the literal 'undefined', which JSON.parse would throw on. */
const text = (v: string) => (v === 'undefined' ? '' : String(JSON.parse(v)))
const onlyIn = (r: { a: string; b: string }) => lineDiff(text(r.a), text(r.b))
const sides = computed(() => [{ tag: 'A', s: props.a }, { tag: 'B', s: props.b }])

const sa = computed(() => skeleton(props.a.events))
const sb = computed(() => skeleton(props.b.events))
const rowsN = computed(() => Math.max(sa.value.length, sb.value.length))
/** First turn whose shape differs; -1 when the two ran the same path all the way. */
const diverged = computed(() => {
  for (let i = 0; i < rowsN.value; i++) if (sa.value[i]?.sig !== sb.value[i]?.sig) return i
  return -1
})
const open = ref(-1)
const groups = computed(() => [turnsOf(props.a.events), turnsOf(props.b.events)])
/** The path is drawn from events, not the bench JSON: without both sides' events it would either
 *  mark a fake divergence at turn 0 (side B still streaming, or its trace file gone for good) or
 *  claim "same path" against no data at all. */
const hasEvents = computed(() => props.a.events.length > 0 && props.b.events.length > 0)
</script>

<template>
  <div class="diff">
    <div class="sides">
      <span></span>
      <div v-for="x in sides" :key="x.tag">
        <div class="who"><span :class="['chip', 'solid', x.s.run.verdict === 'PASS' ? 'ok' : 'err']">{{ x.s.run.verdict }}</span><b>{{ x.tag }} · {{ x.s.name }} #{{ x.s.run.round }}</b></div>
        <div class="muted mono">{{ x.s.run.reason }} · {{ x.s.run.turns }} turns · {{ x.s.run.toolCalls }} tool calls · {{ mmss(x.s.run.ms) }}</div>
      </div>
      <button @click="$emit('close')" :title="t('diff.closeTitle')">×</button>
    </div>

    <div class="muted mono summary">{{ tn('diff.knobs', rows.length) }}<template v-if="!rows.length"> {{ t('diff.same') }}</template></div>
    <div v-if="rows.length" class="table-wrap">
    <table class="cfg">
      <tr v-for="r in rows" :key="r.path">
        <td><code>{{ r.path }}</code></td>
        <template v-if="lines(r)">
          <td colspan="2">
            <div v-for="l in onlyIn(r).onlyA" :key="'a' + l" class="onlyA">− {{ l }}</div>
            <div v-for="l in onlyIn(r).onlyB" :key="'b' + l" class="onlyB">+ {{ l }}</div>
            <details><summary>full text</summary>
              <pre>{{ text(r.a) }}</pre>
              <pre>{{ text(r.b) }}</pre>
            </details>
          </td>
        </template>
        <template v-else>
          <td class="onlyA">A {{ r.a }}</td>
          <td class="onlyB">B {{ r.b }}</td>
        </template>
      </tr>
    </table>
    </div>

    <template v-if="hasEvents">
      <div class="path table-wrap">
        <div v-if="diverged === -1" class="split-label">{{ t('diff.samePath') }}</div>
        <template v-for="(_, i) in rowsN" :key="i">
          <div v-if="i === diverged" class="split-label"><T k="diff.split"><template #at><b>{{ t('diff.splitAt', { n: i + 1 }) }}</b></template></T></div>
          <div class="turnrow" :class="{ same: diverged === -1 || i < diverged, split: i === diverged, on: open === i }" @click="open = open === i ? -1 : i">
            <span class="tn">t{{ i + 1 }}</span>
            <div v-for="(side, k) in [sa[i], sb[i]]" :key="k" class="cell">
              <template v-if="side">
                <span v-for="(c, j) in side.chips" :key="j" :class="['chip', { err: c.bad }]">{{ c.label }}{{ c.detail ? ` ${c.detail}` : '' }}{{ c.truncated ? ' ↯' : '' }}</span>
                <small class="muted">{{ mmss(side.ms) }} · {{ side.tokens }} tok ctx</small>
              </template>
              <span v-else class="muted">— ended</span>
            </div>
          </div>
          <div v-if="open === i" class="pair">
            <div><Trace v-if="groups[0][i]" :events="groups[0][i]" :approvable="false" /></div>
            <div><Trace v-if="groups[1][i]" :events="groups[1][i]" :approvable="false" /></div>
          </div>
        </template>
      </div>
    </template>
    <div v-else class="hint">{{ t('diff.noEvents') }}</div>
  </div>
</template>
