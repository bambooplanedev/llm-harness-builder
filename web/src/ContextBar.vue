<script setup lang="ts">
import { computed } from 'vue'
import type { HarnessEvent } from './api'
const props = defineProps<{ events: HarnessEvent[]; numCtx?: number }>()
const stats = computed(() => [...props.events].reverse().find(e => e.type === 'context_stats') as Extract<HarnessEvent, { type: 'context_stats' }> | undefined)
const ceiling = computed(() => props.numCtx ?? stats.value?.budgetTokens ?? 0)
const pct = computed(() => ceiling.value ? Math.min(100, (stats.value?.estimatedTokens ?? 0) / ceiling.value * 100) : 0)
</script>
<template>
  <div v-if="stats">
    <div class="bar"><div :style="{ width: pct + '%' }"></div></div>
    <small>
      ~{{ stats.estimatedTokens }} tok estimated
      <span v-if="stats.usage"> · last usage {{ stats.usage.promptTokens }}+{{ stats.usage.completionTokens }}</span>
      <span v-if="stats.budgetTokens"> · budget {{ stats.budgetTokens }}</span>
      <span v-if="numCtx"> · num_ctx {{ numCtx }}</span>
      <span v-if="stats.droppedChars" class="warn"> · dropped {{ stats.droppedChars }} chars</span>
      <span v-if="numCtx && stats.budgetTokens > numCtx" class="warn"> · budget exceeds num_ctx</span>
    </small>
  </div>
</template>
