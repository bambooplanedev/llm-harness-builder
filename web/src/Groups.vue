<script setup lang="ts">
import { computed } from 'vue'
import { groupDiff, runSummary, type GroupLine } from '../../src/core/sources'
import { MAX_DIFF_LINES } from './reqDiffs'
import { t } from './i18n'
import { namesIn, shown, type FilmNames } from './film'
import type { HarnessEvent } from './api'

type Run = { id: string; events: HarnessEvent[] }
const props = defineProps<{ a: Run[]; b: Run[]; names: FilmNames }>()
defineEmits<{ close: [] }>()

/** Film mode hides the page's model and server, and every model the runs name. */
const names = computed(() => ({ models: [...props.names.models, ...[...props.a, ...props.b].flatMap(r => namesIn(r.events).models)], urls: props.names.urls }))
const requests = (side: Run[]) => side.map(r => r.events.flatMap(e => (e.type === 'llm_request' ? [e.payload] : [])))
/** Until each side has a run with a request, groupDiff would report the whole other side. */
const waiting = computed(() => [props.a, props.b].some(side => !side.some(r => r.events.some(e => e.type === 'llm_request'))))
const lines = computed(() => {
  if (waiting.value) return []
  const d = groupDiff(requests(props.a), requests(props.b))
  const text = (l: GroupLine) => (l.label ? `${l.label}: ${l.line}` : l.line)
  return [
    ...d.onlyB.map(l => ({ kind: 'add', text: `+ ${text(l)}` })),
    ...d.onlyA.map(l => ({ kind: 'del', text: `− ${text(l)}` })),
    ...d.params.map(p => ({ kind: 'neutral', text: `${p.path}: ${p.a} → ${p.b}` })),
  ]
})
const more = computed(() => lines.value.length - MAX_DIFF_LINES)
const sides = computed(() => [{ tag: 'A', runs: props.a }, { tag: 'B', runs: props.b }].map(s => ({ tag: s.tag, runs: s.runs.map(r => ({ id: r.id, v: runSummary(r.events) })) })))
</script>

<template>
  <div class="groups">
    <div class="row">
      <span class="hint">before (A) vs after (B): only lines every run of a side has and no run of the other</span>
      <button @click="$emit('close')" :title="t('diff.closeTitle')">×</button>
    </div>
    <div v-if="waiting" class="muted">waiting for requests…</div>
    <div v-else class="reqdiff">
      <div v-if="!lines.length" class="rd-neutral">no stable difference</div>
      <div v-for="(l, i) in lines.slice(0, MAX_DIFF_LINES)" :key="i" :class="'rd-' + l.kind">{{ shown(l.text, names) }}</div>
      <div v-if="more > 0" class="rd-neutral">… {{ more }} more lines</div>
    </div>
    <div class="cols">
      <div v-for="s in sides" :key="s.tag">
        <h5>{{ s.tag }}</h5>
        <div v-for="r in s.runs" :key="r.id" class="grun">
          <code>{{ r.id }}</code>
          <div v-if="r.v.empty" class="muted">nothing recorded yet</div>
          <template v-else>
            <div class="chips"><span v-for="(c, j) in r.v.chips" :key="j" :class="['chip', { err: c.bad }]">{{ c.label }}{{ c.detail ? ` ${shown(c.detail, names)}` : '' }}{{ c.truncated ? ' ↯' : '' }}</span></div>
            <pre>{{ shown(r.v.result, names) }}</pre>
            <pre v-if="r.v.reasoning">{{ shown(r.v.reasoning, names) }}</pre>
            <div v-else class="muted">no reasoning recorded</div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
