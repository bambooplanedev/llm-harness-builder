<script setup lang="ts">
import { reactive } from 'vue'
import { t } from './i18n'
import { film } from './film'
import { MAX_SOURCE_CHARS } from './reqDiffs'
import type { Source } from '../../src/core/sources'
defineProps<{ sources: Source[] }>()
/** Rows the user opened; none open in film mode, where a part's text is never shown. */
const open = reactive(new Set<number>())
const toggle = (i: number) => { if (!open.delete(i)) open.add(i) }
</script>
<template>
  <div class="sources">
    <div class="hint" :title="t('trace.sources')">sources</div>
    <template v-for="(s, i) in sources" :key="i">
      <button type="button" class="src-row" :disabled="film" @click="toggle(i)"><span class="muted">{{ s.kind }}</span> {{ s.label }} <span class="muted">{{ s.chars }} chars</span></button>
      <template v-if="open.has(i) && !film"><pre>{{ s.text.slice(0, MAX_SOURCE_CHARS) }}</pre>
        <div v-if="s.text.length > MAX_SOURCE_CHARS" class="muted">… {{ s.text.length - MAX_SOURCE_CHARS }} more chars</div></template>
    </template>
  </div>
</template>
