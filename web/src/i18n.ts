import { ref, h, Fragment, defineComponent, type PropType, type VNodeChild } from 'vue'
import { autoApproves } from '../../src/core/bench'
import { uk } from './uk'

export type Lang = 'en' | 'uk'
export const LANGS: readonly Lang[] = ['en', 'uk']

/** The English catalog: the source of truth for keys and the fallback for anything `uk` lacks. */
export const en = {
  'lang.name': 'English',
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.close': 'Close',
  'app.pickModel': 'pick or type a model first',
  'app.noFolders': 'no folders here',
  'app.checkNote': 'runs node --test on the code the model wrote',
  'start.title': 'Start here',
  'start.example': 'Open an example run: {pass} and {fail} — no model needed.',
  'start.bench': 'Open the {bench}: the PASS table, intervals, ⇄ Diff.',
  'start.benchLink': 'example bench',
  'start.run': 'Pick a model on the left, then Create demo project → Run.',
  'bench.killed': '{msg} — if the run was killed, runs/{id}.jsonl.part is left behind; rename it to .jsonl',
  'bench.comparedRun': '{msg} — the compared run',
  'bench.againConfirm': 'Run this bench again: the same harnesses, task, n and timeout, into a new JSON.',
  'bench.autoApproves': autoApproves('bench'),
  'bench.exampleNote': 'a recorded bench shipped with the package: read-only, no model needed',
  'bench.stopTitle': 'SIGINT, like Ctrl-C: the finished runs stay in the JSON; can take up to a minute',
  'bench.empty': 'no benches yet: run {cmd} or New bench, or open the {examples}',
  'bench.emptyRuns': 'this page reads only {runs} — a bench written with {out} elsewhere will not show up here',
  'bench.round1': 'round 1 still running, no results yet',
  'bench.redTests': 'the model answered, tests are red',
  'bench.noTrace': 'no trace written (JSON predates v2.0.3)',
  'bench.compareTitle': 'compare with the open run',
  'bench.fromHarnesses': 'from ./harnesses',
  'bench.runsUnasked': 'runs unasked · {cmd}',
  'bench.modelFrom': "the Workbench form's: {model}",
  'bench.wilsonNote': '95% interval = Wilson interval of the PASS rate; two harnesses whose intervals overlap are not told apart by this bench.',
  'form.ollamaV1': 'Ollama via /v1 ignores num_ctx and silently truncates the prompt. Pick kind "ollama".',
  'form.refreshKey': 'press ↻ to list the models: that request carries the key',
  'form.locked': '{knobs}: this knob is not available for this model',
  'form.familyNone': 'nothing to change, the form already matches it',
  'form.bashEnv': 'bash gets from your environment: {list}',
  'trace.askMcp': 'start mcp server {name}: {cmd}?',
  'trace.askUntil': 'run {cmd} each time the model says it is done, on files the model has written?',
  'trace.askRun': 'run {cmd}?',
  'trace.autoApproved': 'bench: auto-approved',
  'trace.checkFailed': 'failed, the run goes on',
  'trace.quit': 'final after 0 tool calls: the model quit without doing anything',
  'diff.closeTitle': 'close the comparison',
  'diff.samePath': 'same path all the way — but identical steps do not mean identical words',
  'diff.split': '{at} · click a turn to read both sides',
  'diff.splitAt': 'paths split at t{n}',
  'diff.noEvents': "one side's events have not loaded — nothing to draw the path from",
  // Hover hints for the names on the page, for someone who opens it for the first time: what it is, what it is for, what it takes.
  'h.advanced': 'Rarer knobs live here: tool limits, MCP, prompted templates, context and the loop.\nThe number is how many of them differ from a new harness.',
  'h.harness': 'A harness is one settings file: backend, prompts, tools, limits.\nLoad a ready one from the list (the harnesses/ folder) or save the current one under a new name.',
  'h.backend': "Where the requests to the model go.\nopenai-compatible — any server with /v1/chat/completions: llama-server, vLLM, LM Studio, OpenRouter.\nollama (native) — Ollama's own API; only it hears num_ctx.\nanthropic (native) — the Messages API from Anthropic.\nNext to it — the server address.",
  'h.keyEnv': 'The name of the environment variable that holds the cloud API key, for example OPENROUTER_API_KEY.\nserve reads it from the environment it was started in; the key itself never goes into the harness file.\nEmpty — a local server with no key.',
  'h.model': 'The model on this server: from the list (↻ — refresh the list) or an id typed in by hand.',
  'h.temp': 'Temperature: how randomly the model picks the next token.\n0 — always the most likely one, the answers are the same from run to run.\n0.2–0.7 — usual for code.\n1 and above — more varied, but more mistakes in calls.\nUsually 0–2. A model that does not accept it disables the field.',
  'h.numCtx': "Ollama's context window: how many tokens (prompt + answer) the model sees at once.\nBigger fits a longer conversation but needs more memory. Whatever does not fit, Ollama silently truncates.\nOnly for kind \"ollama\": other servers set the window themselves, at launch.",
  'h.maxTokens': 'A ceiling on the tokens generated in one answer, thinking included.\nEmpty — no ceiling. Too low a ceiling cuts the answer off in the middle of a call.',
  'h.think': 'The thinking switch in the chat template: chat_template_kwargs.enable_thinking on an OpenAI-compatible server, think in Ollama.\non — the model reasons first: slower, often more accurate.\noff — it answers right away.\n— — nothing is sent, the model does what its template does.',
  'h.systemPrompt': 'The system prompt — the instruction that goes first in every request.\nThe buttons fill in ready-made variants.',
  'h.family': 'Ready-made settings for a model family: call format, prompt.\nHover over a button to see what it changes.',
  'h.family.qwen3': 'For Qwen3. Sets:\n• prompted calls in the hermes format — the <tool_call> tags Qwen3 was trained on;\n• the template and the parse-error hint for hermes;\n• the line /no_think last in the system prompt, so the model does not burn the window on thinking in <think>.',
  'h.family.gemma': "For Gemma. Sets:\n• prompted calls in the json {calls, final} format: Gemma's chat template has no native calls, and Ollama rejects tools[];\n• the standard template and parse-error hint;\n• removes another family's line (for example /no_think) from the end of the prompt. Gemma's thinking is switched on by the think field, not by a line in the prompt.",
  'h.family.llama3': "For Llama 3. Sets:\n• native calls (tools[] in API): the Llama 3 chat template supports them;\n• the standard template and parse-error hint for prompted mode;\n• removes another family's line (for example /no_think) from the end of the prompt, adds nothing.",
  'h.tools': 'The tools the model can call: list a folder, read, write or patch a file, run bash.\nThe model does not see a disabled tool.',
  'h.approveBash': 'Every bash command waits for your "yes" in the trace before it runs.',
  'h.guard': 'An edit to a file the model has not read yet in this run is refused with an explanation: a guard against blind edits.',
  'h.escalation': 'After this many failed edits of one file, each further failed one tells the model to re-read the file.\nReading or changing the file starts the count over. Empty — off.',
  'h.readMax': 'read_file stops at this many bytes and tells the model so.\nEmpty — the built-in limit, 4 MB.',
  'h.bashMax': 'How many bytes of bash output to keep.\nEmpty — the built-in limit, 1 MB.',
  'h.bashTimeout': 'After how many seconds a bash command is killed.\nEmpty — the built-in 30 s.',
  'h.mcp': 'External MCP servers with extra tools, in JSON: name → { command, args?, tools? }.\ntools — which of their tools to show the model. Empty — no MCP.',
  'h.toolCalls': 'How the model calls tools.\nnative — the tools go into the API (the tools field), the server parses the calls; needs support in the model and its template.\nprompted — the tools are described as text in the prompt, the model writes the call as text, the harness parses it. For models without native calls.',
  'h.format': 'How the model writes a call in prompted mode.\njson — an object {calls, final}.\nhermes — <tool_call>…</tool_call> tags, as in models trained on the Hermes format.',
  'h.enforceSchema': 'The server constrains the answer to a JSON schema (structured output), so the model cannot write an invalid call.\nWorks only if the server supports it.',
  'h.maxToolOutput': 'How many characters of a tool result stay in the history; the rest is cut off with a marker.\nEmpty — no limit.',
  'h.budget': 'A token budget for the conversation history. When it is exceeded, old tool results are replaced with a short stub.\nEmpty or 0 — no budget.',
  'h.maxTurns': 'The maximum number of turns (a request to the model and its answer) per run. When they run out, the run ends as max_turns.',
  'h.maxRepeats': 'A call (or a failed until bash check) repeated more than this many times ends the run as repeat_loop.\nEmpty — no detector; 0 — the very first repeat ends the run.',
  'h.freshContext': 'After this many repeats of one call, the history is cleared down to the task itself, once per run.\nFrom 1 to max repeats.',
  'h.repeatTemp': 'The turn after a repeat is sampled at this temperature, from 0 to 2: an attempt to knock the model out of the loop.\nNeeds max repeats.',
  'h.repeatThink': 'The turn after a repeat goes with /think instead of the /no_think line, with this token ceiling.\nNeeds max repeats and the /no_think line in the system prompt.',
  'h.untilBash': 'A final answer ends the run only when this command exits with code 0 (for example, npm test); otherwise the model sees the output and keeps working.\nThe command runs on the files the model wrote and you confirm it before the run.',
  'h.workdir': 'The project folder the model works in: it reads, writes and runs commands only here.\nUse a scratch copy — not / and not your home folder. Browse… — pick from a list of folders.',
  'h.task': 'What to ask the model to do. It goes as the first user message.',
  'h.pass': "How many of the harness's runs passed the task check (PASS), out of all of them.\nPASS is decided by the check script, not by what the model answered.",
  'h.rate': 'The PASS rate (the dot) and its 95% Wilson interval (the bar).\nThe fewer the runs, the wider the bar. Harnesses whose bars overlap are not told apart by this bench.',
  'h.medTurns': "Median turns over all of the harness's runs, failed ones included.",
  'h.medTime': 'Median wall-clock time of one run.',
  'h.medCost': 'Median cost of a run in dollars: usage from the server × the price from the harness (pricePerMTok).',
  'h.peak': "The largest request + answer among the harness's runs, in the server's tokens: how close the runs came to the context window.\nYellow — over 90% of the window.",
  'h.again': 'The same bench once more: the same harnesses, task, n and timeout, into a new JSON; the old one stays.\nThe model server is checked first (preflight): if it is unreachable, the bench does not start and you will see why.',
  'h.againBusy': 'A run of this bench is still going: wait for it to finish.',
  'h.reasons': 'How the runs ended.\nfinal — the model gave an answer; max_turns — out of turns; repeat_loop — a repeat loop; parse_failed — a call could not be parsed; *_error — a server or MCP error; aborted — interrupted, including by the timeout.',
}
export type Key = keyof typeof en

const catalog: Record<Lang, Partial<Record<Key, string>>> = { en, uk }
/** Starts at English whatever the browser says: main.ts sets the real one, so tests render English. */
export const lang = ref<Lang>('en')

/** A stored en/uk wins; anything else follows the browser. */
export function initialLang(stored: string | null | undefined, navigatorLanguage: string | undefined): Lang {
  if (stored === 'en' || stored === 'uk') return stored
  return navigatorLanguage?.toLowerCase().startsWith('uk') ? 'uk' : 'en'
}
export function readLang(storage?: Pick<Storage, 'getItem'>): string | null {
  try { return (storage ?? localStorage).getItem('lhb.lang') } catch { return null }
}
export function setLang(l: Lang, storage?: Pick<Storage, 'setItem'>): void {
  lang.value = l
  try { (storage ?? localStorage).setItem('lhb.lang', l) } catch { /* private window: the choice lasts until reload */ }
}
export function t(key: Key, params?: Record<string, string | number>): string {
  const s = catalog[lang.value][key] ?? en[key]
  return params ? s.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m)) : s
}
export const langName = (l: Lang): string => catalog[l]['lang.name'] ?? en['lang.name']

/** `t(k)` with each `{name}` filled by the slot of that name (markup stays in the template) or else by `p`. Text and vnodes only, never HTML. */
export const T = defineComponent({
  props: { k: { type: String as PropType<Key>, required: true }, p: Object as PropType<Record<string, string | number>> },
  setup: (props, { slots }) => () => h(Fragment, t(props.k).split(/\{(\w+)\}/).flatMap<VNodeChild>((s, i) =>
    i % 2 ? [slots[s]?.() ?? String(props.p?.[s] ?? `{${s}}`)] : s ? [s] : [])),
})
