<script setup lang="ts">
import { computed } from 'vue'
import { configDiff, lineDiff, type DiffSide } from '../../src/core/diff'
import { mmss } from '../../src/core/bench'

const props = defineProps<{ a: DiffSide; b: DiffSide; task: string }>()
defineEmits<{ close: [] }>()

const rows = computed(() => configDiff(props.a.config, props.b.config))
/** Leaves are JSON text, so a multi-line string shows up as a literal \n escape inside it. */
const lines = (r: { a: string; b: string }) => r.a.includes('\\n') || r.b.includes('\\n')
/** A key missing on one side is the literal 'undefined', which JSON.parse would throw on. */
const text = (v: string) => (v === 'undefined' ? '' : String(JSON.parse(v)))
const onlyIn = (r: { a: string; b: string }) => lineDiff(text(r.a), text(r.b))
const head = (s: DiffSide) => `${s.name} #${s.run.round} · ${s.run.verdict} · ${s.run.reason} · ${mmss(s.run.ms)}`
</script>

<template>
  <div class="diff">
    <div class="row">
      <b>{{ head(a) }}</b> проти <b>{{ head(b) }}</b>
      <button @click="$emit('close')">×</button>
    </div>
    <div class="hint">{{ task }}</div>

    <h4>конфіг</h4>
    <div v-if="!rows.length" class="hint">конфіги однакові</div>
    <table v-else class="cfg">
      <tr v-for="r in rows" :key="r.path">
        <td><code>{{ r.path }}</code></td>
        <template v-if="lines(r)">
          <td colspan="2">
            <div v-for="l in onlyIn(r).onlyA" :key="'a' + l" class="onlyA">− {{ l }}</div>
            <div v-for="l in onlyIn(r).onlyB" :key="'b' + l" class="onlyB">+ {{ l }}</div>
            <details><summary>повний текст</summary>
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
  </div>
</template>
