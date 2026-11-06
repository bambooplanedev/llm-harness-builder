<script setup lang="ts">
import { computed } from 'vue'
import { t } from './i18n'
import { isNoChange, type ReqDiff } from '../../src/core/diff'
const props = defineProps<{ diff: ReqDiff; title: string }>()
type Line = { kind: 'add' | 'del' | 'neutral'; text: string }
const lines = computed<Line[]>(() => {
  const d = props.diff, out: Line[] = []
  for (const s of d.system.added) out.push({ kind: 'add', text: `+ system: ${s}` })
  for (const s of d.system.removed) out.push({ kind: 'del', text: `− system: ${s}` })
  for (const n of d.tools.added) out.push({ kind: 'add', text: `+ tool ${n}` })
  for (const n of d.tools.removed) out.push({ kind: 'del', text: `− tool ${n}` })
  for (const n of d.tools.changed) out.push({ kind: 'neutral', text: `~ tool ${n}` })
  const m = d.messages
  if ('appended' in m) { if (m.appended) out.push({ kind: 'add', text: `+${m.appended} appended` }) }
  else {
    out.push({ kind: 'neutral', text: `history changed from #${m.from}` })
    for (const c of m.changed) {
      for (const s of c.added) out.push({ kind: 'add', text: `#${c.n}: + ${s}` })
      for (const s of c.removed) out.push({ kind: 'del', text: `#${c.n}: − ${s}` })
    }
    if (m.added) out.push({ kind: 'add', text: `+${m.added} appended` })
    if (m.removed) out.push({ kind: 'del', text: `−${m.removed} removed` })
  }
  for (const p of d.params) out.push({ kind: 'neutral', text: `${p.path}: ${p.a} → ${p.b}` })
  return out
})
const none = computed(() => isNoChange(props.diff) ? `no change${'appended' in props.diff.messages && props.diff.messages.appended ? ` besides +${props.diff.messages.appended} appended` : ''}` : '')
</script>
<template>
  <div class="reqdiff">
    <div class="hint" :title="t('trace.reqDiff')">{{ title }}</div>
    <div v-if="none" class="rd-neutral">{{ none }}</div>
    <template v-else><div v-for="(l, i) in lines" :key="i" :class="'rd-' + l.kind">{{ l.text }}</div></template>
  </div>
</template>
