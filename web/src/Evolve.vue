<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { api, type EvolveCheck, type EvolveConsent, type EvolveStatus, type Note } from './api'
import { t, lang, type Key } from './i18n'
import { configDiff, lineDiff } from '../../src/core/diff'
import { FIELD_LABEL, flagLines, outcomeOf } from '../../src/core/evolve-labels'

const props = defineProps<{ harnessNames: string[]; current: string; workdir: string; notesOn: boolean; status: EvolveStatus }>()
/** `poll`: ask App for the status now (shown, started, stopped); App keeps polling while a job runs, tab open or not.
 *  `use`: `keepBackend` when the version's backend differs from the original's: the form keeps its own, as the diff says. */
const emit = defineEmits<{ use: [name: string, keepBackend: boolean]; poll: [] }>()

const harness = ref(''); const repo = ref(props.workdir)
watch(() => props.workdir, w => { repo.value = w })
/** No mode is preselected: Start waits for a pick, so no promise is taken by default. */
const mode = ref(''); const maxUsd = ref('')
const MODES = ['hours', 'night', 'days'] as const
/** What /api/evolve/check says of this harness, repo and mode: the run count and the orientation, before any Start. */
const plan = ref<EvolveCheck>(); let checkAsk = 0
const consent = ref<EvolveConsent>(); const accepted = ref(false); const error = ref('')
/** A yes was sent and the server asked again: the commands changed since they were read. */
const changed = ref(false)
// A yes is to one harness and one repo: another pick asks again, and an error about the old pick is gone.
watch([harness, repo, mode], () => {
  consent.value = undefined; accepted.value = false; changed.value = false; error.value = ''; plan.value = undefined
  const ask = ++checkAsk // a later pick overtakes an earlier answer
  if (!harness.value || !repo.value || !mode.value) return
  api.evolveCheck({ harness: harness.value, repo: repo.value, mode: mode.value }).then(p => { if (ask === checkAsk) plan.value = p }, e => { if (ask === checkAsk) error.value = e.message })
})
/** A failed Start asks for the status; that answer is not news about the error, so it keeps it. */
let keepError = false
// Every other status that arrived is news: an error from an earlier Start no longer holds.
watch(() => props.status, () => { if (keepError) keepError = false; else error.value = '' })
const notes = ref<Note[]>([]); const notesError = ref('')

const running = computed(() => props.status.running)
/** While a job runs, `last` is the one before it: not news here. */
const last = computed(() => running.value ? undefined : props.status.last)
const round = computed(() => running.value?.round)
const state = computed(() => round.value ? `round ${round.value[0]}/${round.value[1]}` : running.value ? 'running' : 'idle')
/** SIGINT from Stop exits 130: a pause, not a failure. */
const stopped = computed(() => last.value?.code === 130 || last.value?.signal === 'SIGINT')
const failed = computed(() => !!last.value && last.value.code !== 0 && !stopped.value)
/** Stop pressed, the job not gone yet: SIGINT can take a while to end the run. */
const stopping = ref(false)
watch(running, r => { if (!r) stopping.value = false })
/** A priced harness needs a ceiling: the server refuses a start without one. */
const usd = computed(() => +maxUsd.value)
const needsUsd = computed(() => !!plan.value?.priced)
const canStart = computed(() => !running.value && !!plan.value && (!needsUsd.value || usd.value > 0) && (!consent.value || accepted.value))

const tail = ref<HTMLElement | null>(null)
/** The newest log line is the one that says what is going on. */
const toEnd = () => nextTick(() => { if (tail.value) tail.value.scrollTop = tail.value.scrollHeight })
// Followed only from the bottom: someone who scrolled up to read is not pulled away. Measured before the patch (flush 'pre').
watch(() => running.value?.err ?? last.value?.err, () => {
  const el = tail.value
  if (!el || el.scrollHeight - el.scrollTop - el.clientHeight <= 40) void toEnd()
})

// The page is built when its tab opens: the form's harness, a fresh status and the notes.
const pick = () => { if (!props.harnessNames.includes(harness.value)) harness.value = props.harnessNames.includes(props.current) ? props.current : props.harnessNames[0] ?? '' }
watch(() => props.harnessNames, pick)
onMounted(() => {
  pick(); emit('poll'); void loadNotes(); void toEnd()
})
async function start() {
  error.value = ''
  try {
    const accept = consent.value && accepted.value ? consent.value.consent.hash : undefined
    const c = await api.evolveStart({ harness: harness.value, repo: repo.value, mode: mode.value, ...needsUsd.value ? { maxUsd: usd.value } : {}, ...accept ? { accept } : {} })
    consent.value = c; accepted.value = false; changed.value = !!(c && accept)
    if (!c) emit('poll')
  } catch (e) { error.value = (e as Error).message; keepError = true; emit('poll') } // e.g. a job another tab started: show it
}
function stop() {
  stopping.value = true
  api.evolveStop().then(() => emit('poll'), e => { stopping.value = false; error.value = e.message })
}

/** The newest version the finished evolve wrote: `<harness>.v<N>` with the highest N, if the list has one. */
const newest = computed(() => {
  if (last.value?.code !== 0) return
  const p = `${last.value.harness}.v`
  const ns = props.harnessNames.filter(n => n.startsWith(p) && /^\d+$/.test(n.slice(p.length))).map(n => +n.slice(p.length))
  return ns.length ? `${p}${Math.max(...ns)}` : undefined
})
/** The button the report allows: a declared winner to use, a pointer to review; the original kept, none. */
const action = computed(() => ({ use: 'Use', try: 'Review', keep: undefined })[outcomeOf(last.value?.out ?? '') ?? 'keep'])
const KNOWN: Record<string, string> = { name: 'name', ...FIELD_LABEL }
/** A leaf is JSON text; a key missing on one side is the literal 'undefined'. */
const text = (v: string) => (v === 'undefined' ? '' : String(JSON.parse(v)))
type Change = { path: string; label?: string; a: string; b: string; added?: ReturnType<typeof flagLines>; removed?: string[] }
/** What Use vN and Review vN show: every differing leaf, the system prompt line by line. Nothing in the form changes until Load. */
const review = ref<{ name: string; changes: Change[] }>()
watch(last, () => { review.value = undefined })
async function use(name: string) {
  error.value = ''
  try {
    const [a, b] = await Promise.all([api.harness(last.value!.harness), api.harness(name)])
    review.value = { name, changes: configDiff(a, b).map(r => {
      const c: Change = { ...r, label: KNOWN[r.path] }
      if (r.path !== 'systemPrompt') return c
      const d = lineDiff(text(r.a), text(r.b))
      return { ...c, added: flagLines(d.onlyB.join('\n')).filter(l => l.line), removed: d.onlyA }
    }) }
  } catch (e) { error.value = (e as Error).message }
}
function load(name: string) {
  const keepBackend = !!review.value?.changes.some(c => c.path.startsWith('backend.'))
  review.value = undefined; emit('use', name, keepBackend)
}

async function loadNotes(del?: string) {
  notesError.value = ''
  if (!repo.value) { notes.value = []; return }
  try { notes.value = (await api.notes(repo.value, del)).notes } catch (e) { notes.value = []; notesError.value = (e as Error).message }
}
const clearNotes = () => { if (confirm(t('evolve.clearConfirm'))) void loadNotes('all') }
</script>

<template>
  <!-- Leaving the tab unmounts this page: the job lives in serve, not here. -->
  <div class="evolve">
    <h3>Evolve <span class="chip">{{ state }}</span></h3>
    <p class="muted">{{ t('evolve.lede') }}</p>
    <div class="row"><label for="evolve-harness">Harness</label><select id="evolve-harness" :value="running?.harness ?? harness" :disabled="!!running" @change="harness = ($event.target as HTMLSelectElement).value"><option v-for="n in harnessNames" :key="n" :value="n">{{ n }}</option><option v-if="running && !harnessNames.includes(running.harness)" :value="running.harness">{{ running.harness }}</option></select></div>
    <div class="hint">{{ t('evolve.saved') }}</div>
    <div class="row"><label for="evolve-repo">Repo</label><input id="evolve-repo" type="text" v-model="repo" placeholder="/path/to/repo" :disabled="!!running" @change="loadNotes()"></div>
    <div class="hint">{{ t('evolve.repo') }}</div>
    <div class="row"><label for="evolve-mode">Mode</label><select id="evolve-mode" :value="mode" :disabled="!!running" @change="mode = ($event.target as HTMLSelectElement).value"><option value="" disabled>choose a mode</option><option v-for="m in MODES" :key="m" :value="m">{{ m }}</option></select><span class="muted">{{ mode ? t(`evolve.mode.${mode}` as Key) : '' }}</span></div>
    <div v-if="needsUsd" class="row"><label for="evolve-usd">Max $</label><input id="evolve-usd" type="number" min="0" step="any" v-model="maxUsd" :disabled="!!running" required><span class="muted">{{ t('evolve.usd') }}</span></div>
    <section v-if="plan && !running">
      <p><b>{{ plan.runs }}</b> {{ t('evolve.runs') }}</p>
      <label :title="t('h.evolveSets')">Tasks</label>
      <ul>
        <li><b>{{ plan.sets.train }}</b> {{ t('evolve.train') }}</li>
        <li><b>{{ plan.sets.gate }}</b> {{ t('evolve.gate') }}</li>
        <li><b>{{ plan.sets.test }}</b> {{ t('evolve.test') }}</li>
      </ul>
      <p v-if="plan.declarable">{{ t('evolve.strict', { needed: plan.needed ?? '' }) }}</p>
      <div v-else class="warn block">{{ plan.reference }}</div>
    </section>
    <div class="row">
      <button :disabled="!canStart" @click="start">Start</button>
      <span class="err">{{ error }}</span>
    </div>

    <section v-if="consent && !running">
      <p v-if="consent.uncommitted" class="warn">{{ t('evolve.uncommitted') }}</p>
      <div class="warn block">{{ t('evolve.warning') }}</div>
      <p v-if="changed" class="warn">{{ t('evolve.changed') }}</p>
      <p>{{ t('evolve.consent') }}</p>
      <pre>{{ consent.consent.text }}</pre>
      <label class="accept"><input type="checkbox" :checked="accepted" @change="accepted = ($event.target as HTMLInputElement).checked"> I accept these commands</label>
    </section>

    <section v-if="running">
      <p><b>{{ t('evolve.running', { harness: running.harness }) }}</b> <span class="chip">{{ round ? t('evolve.round', { r: round[0], R: round[1] }) : t('evolve.starting') }}</span></p>
      <pre ref="tail">{{ running.err }}</pre>
      <div class="row"><button :disabled="stopping" @click="stop">Stop — resume later</button><span class="muted">{{ t(stopping ? 'evolve.stopping' : 'evolve.stopNote') }}</span></div>
    </section>
    <section v-else-if="last">
      <template v-if="last.code === 0">
        <p>{{ t('evolve.done', { harness: last.harness }) }}</p>
        <template v-if="review">
          <p>{{ t(review.changes.length ? 'evolve.diff' : 'evolve.noDiff', { name: review.name, harness: last.harness }) }}</p>
          <ul class="changes">
            <li v-for="c in review.changes" :key="c.path" :class="['change', { warn: !c.label }]">
              <div><b>{{ c.label ?? 'outside what Evolve may change' }}</b> <small class="muted">{{ c.path }}</small></div>
              <div v-if="c.path.startsWith('backend.')" class="muted">{{ t('evolve.backendKept') }}</div>
              <div v-if="c.added && !c.added.length && !c.removed?.length" class="muted">{{ t('evolve.sameLines') }}</div>
              <template v-else-if="c.added">
                <div v-for="(l, i) in c.added" :key="'+' + i" :class="['line', { warn: l.flag === 'command' }]"><span v-if="l.flag" :class="['chip', { warn: l.flag === 'command' }]">{{ l.flag === 'command' ? 'address or command' : 'mentions tests or checks' }}</span> {{ l.line }}</div>
                <div v-for="(l, i) in c.removed" :key="'-' + i" class="line warn"><span class="chip warn">removed</span> {{ l }}</div>
              </template>
              <div v-else><code>{{ c.a }}</code> → <code>{{ c.b }}</code></div>
            </li>
          </ul>
          <div class="row"><button @click="load(review.name)">Load {{ review.name.slice(last.harness.length + 1) }} into the form</button><button @click="review = undefined">Back</button></div>
        </template>
        <template v-else>
          <label :title="t('h.evolveReport')">Report</label>
          <pre>{{ last.out }}</pre>
          <div class="row"><button v-if="newest && action" @click="use(newest)">{{ action }} {{ newest.slice(last.harness.length + 1) }}</button></div>
        </template>
      </template>
      <p v-else-if="stopped">{{ t('evolve.stopped', { harness: last.harness }) }}</p>
      <template v-else-if="failed">
        <div class="err block">{{ t('evolve.failed', { harness: last.harness, code: last.code !== null ? `code ${last.code}` : last.signal ?? 'an error' }) }}</div>
        <pre ref="tail">{{ last.err }}</pre>
      </template>
    </section>
    <p v-else-if="status.bench" class="muted">{{ t('evolve.bench') }}</p>
    <p v-else class="muted">{{ t('evolve.idle') }}</p>

    <h4>Notes</h4>
    <p class="muted">{{ t(notesOn ? 'evolve.notesOn' : 'evolve.notesOff', { harness: current }) }}</p>
    <div v-if="notesError" class="err">{{ notesError }}</div>
    <div v-else-if="!notes.length" class="muted">{{ t('evolve.noNotes') }}</div>
    <ul class="notes">
      <li v-for="n in notes" :key="n.id">
        <div><div>{{ n.text }}</div><div class="muted">{{ n.author }} · {{ new Date(n.ts).toLocaleString(lang) }}<template v-if="n.run"> · run {{ n.run }}</template></div></div>
        <button aria-label="Delete note" title="Delete note" @click="loadNotes(n.id)">×</button>
      </li>
    </ul>
    <div class="row"><button :disabled="!notes.length" @click="clearNotes">Clear notes</button></div>
  </div>
</template>
