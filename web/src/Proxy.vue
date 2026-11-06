<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { api, type ProxyItem, type RunSummary } from './api'
import { t } from './i18n'

/** A session clicked on a card: App opens it in Workbench, as in the runs list. */
const emit = defineEmits<{ open: [run: RunSummary] }>()

const items = ref<ProxyItem[]>([])
const runs = ref<RunSummary[]>([])
/** null until the first answer; false when this serve has no cli (the routes 404). */
const available = ref<boolean | null>(null)
const error = ref('')
/** A failed Stop, on its card. */
const stopError = ref<Record<string, string>>({})
const stopping = ref(new Set<string>())
const upstream = ref(''); const port = ref('0'); const name = ref('')
const dialects = ref(['']); const connections = ref([''])
const starting = ref(false)

/** A session of a proxy is a run it recorded: its harness is the proxy's name, started after the proxy did. */
const sessions = (p: ProxyItem) => {
  // An exited card ends where a later proxy of the same name begins.
  const end = p.exit ? Math.min(...items.value.filter(o => o.name === p.name && o.started > p.started).map(o => o.started)) : Infinity
  return runs.value.filter(r => r.harness === p.name && r.started >= p.started && r.started < end)
}
const exited = (p: ProxyItem) => `exited ${p.exit!.code ?? '-'}${p.exit!.signal ? ` (${p.exit!.signal})` : ''}`

async function refresh() {
  try {
    const list = await api.proxies()
    available.value = list !== null
    if (list) { items.value = list; runs.value = await api.runs() }
  } catch { /* a blip: keep the last list and poll on */ }
}
async function start() {
  error.value = ''; starting.value = true
  try {
    await api.startProxy({ upstream: upstream.value.trim(), port: Number(port.value), name: name.value.trim(),
      dialects: dialects.value.map(s => s.trim()).filter(Boolean), connections: connections.value.map(s => s.trim()).filter(Boolean) })
    await refresh()
  } catch (e) { error.value = (e as Error).message }
  starting.value = false
}
async function stop(id: string) {
  if (stopping.value.has(id)) return
  stopping.value = new Set(stopping.value).add(id)
  delete stopError.value[id]
  try { await api.stopProxy(id) } catch (e) { stopError.value[id] = (e as Error).message }
  stopping.value.delete(id); stopping.value = new Set(stopping.value)
  await refresh()
}

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { void refresh(); timer = setInterval(refresh, 2000) })
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div class="proxy">
    <p v-if="available === false" class="muted">{{ t('proxy.unavailable') }}</p>
    <template v-else>
      <h4>New proxy</h4>
      <div class="proxy-form">
        <label>Upstream</label><input type="text" v-model="upstream" placeholder="http://127.0.0.1:11434">
        <label>Port</label><input type="text" v-model="port" placeholder="0">
        <label>Name</label><input type="text" v-model="name" placeholder="name">
        <label :title="t('proxy.paths')">Own dialects</label>
        <div><input v-for="(_, i) in dialects" :key="i" type="text" v-model="dialects[i]" placeholder="/abs/path/dialect.mjs"><button @click="dialects.push('')">+ more</button></div>
        <label :title="t('proxy.paths')">Own connections</label>
        <div><input v-for="(_, i) in connections" :key="i" type="text" v-model="connections[i]" placeholder="/abs/path/connection.json"><button @click="connections.push('')">+ more</button></div>
      </div>
      <div class="row" style="margin:8px 0"><button @click="start" :disabled="starting">Start</button><span class="muted">{{ t('proxy.paths') }}</span></div>
      <div v-if="error" class="err form-err">{{ error }}</div>
      <p v-if="!items.length" class="muted">{{ t('proxy.none') }}</p>
      <div v-for="p in items" :key="p.id" class="proxy-card">
        <div class="line"><span><b>{{ p.name }}</b> · {{ p.upstream }} · :{{ p.port }}<span v-if="p.exit" class="chip err">{{ exited(p) }}</span></span>
          <button :disabled="stopping.has(p.id)" @click="stop(p.id)">{{ p.exit ? (stopping.has(p.id) ? 'removing…' : 'Remove') : (stopping.has(p.id) ? 'stopping…' : 'Stop') }}</button></div>
        <pre v-if="p.lines.length" class="muted">{{ p.lines.join('\n') }}</pre>
        <div class="runs">
          <div v-for="r in sessions(p)" :key="r.id" class="session" @click="emit('open', r)">
            <div class="line"><span>{{ r.id.slice(0, 8) }} · {{ r.reason ?? 'running' }}</span><span>{{ r.turns ?? '-' }} turns · {{ new Date(r.started).toLocaleTimeString() }}</span></div>
            <div class="muted">{{ r.task.slice(0, 60) }}</div>
          </div>
        </div>
        <div v-if="stopError[p.id]" class="err">{{ stopError[p.id] }}</div>
        <pre v-if="p.tail" class="muted">{{ p.tail }}</pre>
      </div>
    </template>
  </div>
</template>
