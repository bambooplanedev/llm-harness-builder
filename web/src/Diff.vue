<script setup lang="ts">
import { computed, ref } from 'vue'
import { configDiff, lineDiff, skeleton, turnsOf, type DiffSide } from '../../src/core/diff'
import { mmss } from '../../src/core/bench'
import Trace from './Trace.vue'

const props = defineProps<{ a: DiffSide; b: DiffSide; task: string }>()
defineEmits<{ close: [] }>()

const rows = computed(() => configDiff(props.a.config, props.b.config))
/** Leaves are JSON text, so a multi-line string shows up as a literal \n escape inside it. */
const lines = (r: { a: string; b: string }) => r.a.includes('\\n') || r.b.includes('\\n')
/** A key missing on one side is the literal 'undefined', which JSON.parse would throw on. */
const text = (v: string) => (v === 'undefined' ? '' : String(JSON.parse(v)))
const onlyIn = (r: { a: string; b: string }) => lineDiff(text(r.a), text(r.b))
const head = (s: DiffSide) => `${s.name} #${s.run.round} · ${s.run.verdict} · ${s.run.reason} · ${mmss(s.run.ms)}`

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
    <div class="row">
      <b>{{ head(a) }}</b> vs <b>{{ head(b) }}</b>
      <button @click="$emit('close')">×</button>
    </div>
    <div class="hint">{{ task }}</div>

    <h4>config</h4>
    <div v-if="!rows.length" class="hint">configs are identical</div>
    <table v-else class="cfg">
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
          <td class="onlyA">{{ r.a }}</td>
          <td class="onlyB">{{ r.b }}</td>
        </template>
      </tr>
    </table>

    <template v-if="hasEvents">
      <h4>path</h4>
      <div v-if="diverged === -1" class="hint">same path — but identical steps do not mean identical words</div>
      <div v-for="(_, i) in rowsN" :key="i" class="turnrow" :class="{ split: i === diverged }" @click="open = open === i ? -1 : i">
        <div class="side">
          <span v-for="(c, j) in sa[i]?.chips ?? []" :key="j" class="chip" :class="{ err: c.bad }">{{ c.label }}{{ c.truncated ? ' ↯' : '' }}</span>
          <small v-if="sa[i]"> {{ mmss(sa[i].ms) }} · {{ sa[i].tokens }} tok ctx</small>
        </div>
        <div class="side">
          <span v-for="(c, j) in sb[i]?.chips ?? []" :key="j" class="chip" :class="{ err: c.bad }">{{ c.label }}{{ c.truncated ? ' ↯' : '' }}</span>
          <small v-if="sb[i]"> {{ mmss(sb[i].ms) }} · {{ sb[i].tokens }} tok ctx</small>
        </div>
        <div v-if="i === diverged" class="hint split-label">diverged here</div>
      </div>
      <div v-if="open >= 0" class="layout">
        <div><Trace v-if="groups[0][open]" :events="groups[0][open]" :approvable="false" /></div>
        <div><Trace v-if="groups[1][open]" :events="groups[1][open]" :approvable="false" /></div>
      </div>
    </template>
    <div v-else class="hint">one side's events have not loaded — nothing to draw the path from</div>
  </div>
</template>
