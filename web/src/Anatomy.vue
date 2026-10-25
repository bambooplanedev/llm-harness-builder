<script setup lang="ts">
import { computed } from 'vue'
import { t } from './i18n'
import { LAYERS, anatomyLine, type TurnAnatomy } from '../../src/core/anatomy'
const props = defineProps<{ items: TurnAnatomy[] }>()
const emit = defineEmits<{ pick: [turn: number] }>()
const LABEL = { system: 'system', tools: 'tools', history: 'history', results: 'tool results' }
const max = computed(() => Math.max(...props.items.map(i => i.a.total)))
</script>
<template>
  <div v-if="items.length" class="anatomy">
    <div class="alegend">
      <span v-for="l in LAYERS" :key="l"><i :class="['sw', 'l-' + l]"></i>{{ LABEL[l] }}</span>
      <span class="muted">{{ t('trace.anatomyHow') }}</span>
    </div>
    <div class="acols">
      <button v-for="x in items" :key="x.seq" :class="['acol', { est: !x.a.exact }]" :style="{ height: x.a.total / max * 100 + '%' }"
        :title="`t${x.turn} · ${anatomyLine(x.a)}`" :aria-label="`t${x.turn} · ${anatomyLine(x.a)}`" @click="emit('pick', x.turn)">
        <div v-for="l in LAYERS" :key="l" :class="'l-' + l" :style="{ height: x.a.tokens[l] / x.a.total * 100 + '%' }"></div>
      </button>
    </div>
  </div>
</template>
