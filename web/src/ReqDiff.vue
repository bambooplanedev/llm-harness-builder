<script setup lang="ts">
import { computed } from 'vue'
import { t } from './i18n'
import { isNoChange, type ReqDiff } from '../../src/core/diff'
import { MAX_DIFF_LINES } from './reqDiffs'
/** labelsA/labelsB: line → where it came from, in the old/new body; a labelled line says so instead of `system`/`#n`. */
const props = defineProps<{ diff: ReqDiff; title: string; hint?: string; labelsA?: Map<string, string>; labelsB?: Map<string, string> }>()
type Line = { kind: 'add' | 'del' | 'neutral'; text: string }
const named = (kind: 'add' | 'del', s: string, plain: string): Line => {
  const label = (kind === 'add' ? props.labelsB : props.labelsA)?.get(s.trim())
  return { kind, text: label ? `${kind === 'add' ? '+' : '−'} ${label}: ${s}` : plain }
}
const lines = computed<Line[]>(() => {
  const d = props.diff, out: Line[] = []
  for (const s of d.system.added) out.push(named('add', s, `+ system: ${s}`))
  for (const s of d.system.removed) out.push(named('del', s, `− system: ${s}`))
  for (const n of d.tools.added) out.push({ kind: 'add', text: `+ tool ${n}` })
  for (const n of d.tools.removed) out.push({ kind: 'del', text: `− tool ${n}` })
  for (const n of d.tools.changed) out.push({ kind: 'neutral', text: `~ tool ${n}` })
  const m = d.messages
  if ('appended' in m) { if (m.appended) out.push({ kind: 'add', text: `+${m.appended} appended` }) }
  else {
    out.push({ kind: 'neutral', text: `history changed from #${m.from}` })
    for (const c of m.changed) {
      for (const s of c.added) out.push(named('add', s, `#${c.n}: + ${s}`))
      for (const s of c.removed) out.push(named('del', s, `#${c.n}: − ${s}`))
    }
    if (m.added) out.push({ kind: 'add', text: `+${m.added} appended` })
    if (m.removed) out.push({ kind: 'del', text: `−${m.removed} removed` })
  }
  for (const p of d.params) out.push({ kind: 'neutral', text: `${p.path}: ${p.a} → ${p.b}` })
  return out
})
const shownLines = computed(() => lines.value.slice(0, MAX_DIFF_LINES))
const more = computed(() => lines.value.length - MAX_DIFF_LINES)
const none = computed(() => isNoChange(props.diff) ? `no change${'appended' in props.diff.messages && props.diff.messages.appended ? ` besides +${props.diff.messages.appended} appended` : ''}` : '')
</script>
<template>
  <div class="reqdiff">
    <div class="hint" :title="hint ?? t('trace.reqDiff')">{{ title }}</div>
    <div v-if="none" class="rd-neutral">{{ none }}</div>
    <template v-else><div v-for="(l, i) in shownLines" :key="i" :class="'rd-' + l.kind">{{ l.text }}</div>
      <div v-if="more > 0" class="rd-neutral">… {{ more }} more lines</div></template>
  </div>
</template>
