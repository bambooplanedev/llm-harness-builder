// src/core/tasks.ts — what `bench` and `demo` can run: the text, the workdir and the verdict of each task, in one place.
import { mkdtemp, cp, writeFile, mkdir } from 'node:fs/promises'
import { rmSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEMO_TASK } from './prompts.js'

const PKG_ROOT = fileURLToPath(new URL('../..', import.meta.url))

export type Task = {
  prompt: string
  /** Largest --size the task takes. Absent: the task has no size. */
  max?: number
  /** A fresh workdir under the system tmp dir; resolves to its path. */
  prepare(size?: number): Promise<string>
  /** Data that belongs in the task text itself, after the prompt: a harness with no tools has no file to read it from. */
  input?(size?: number): string
  /** The JSON form of the final answer. A harness with no tools and `enforceSchema` on has the server hold the model to it. */
  answerSchema?(size?: number): Record<string, unknown>
  /** true = PASS. `answer` is the text of the final reply; absent when the run ended without one. */
  check(dir: string, size?: number, answer?: string): boolean
}

/** The task every number in the README up to v2.6 was measured on. Moved here from cli.ts unchanged; tests/tasks.test.ts pins the bytes. */
const slug: Task = {
  prompt: DEMO_TASK,
  async prepare() {
    const dir = await mkdtemp(path.join(tmpdir(), 'lhb-demo-'))
    await cp(path.join(PKG_ROOT, 'examples'), dir, { recursive: true })
    const lines: string[] = []
    for (let i = 0; i < 3000; i++) lines.push(`2026-09-11T10:${String(i % 60).padStart(2, '0')}:00Z INFO request id=${i} path=/api/slug status=200 ms=${(i * 7) % 90}`)
    lines.push('2026-09-11T11:00:00Z ERROR bug report: slugify("  Hello, World!  ") returned "hello-world-" but expected "hello-world" (leading and trailing dashes must be stripped)')
    lines.push('2026-09-11T11:00:01Z INFO request id=3001 path=/api/slug status=200 ms=12')
    await mkdir(path.join(dir, 'data'), { recursive: true })
    await writeFile(path.join(dir, 'data', 'app.log'), lines.join('\n') + '\n')
    return dir
  },
  check: dir => spawnSync('sh', [path.join(dir, 'check.sh')], { timeout: 60_000 }).status === 0,
}

/** The order IS the task: size N means the first N of these. titleCase imports words and paginate imports chunk, on purpose. */
export const POOL = ['clamp', 'words', 'titleCase', 'chunk', 'paginate', 'parseDuration', 'dedupe', 'range', 'formatBytes', 'median'] as const
/** The same ten units with `chunk` and `paginate`, which imports it, at the back: sizes 1 to 8 hold neither. */
export const POOL2 = ['clamp', 'words', 'titleCase', 'parseDuration', 'dedupe', 'range', 'formatBytes', 'median', 'chunk', 'paginate'] as const
const POOL_ROOT = path.join(PKG_ROOT, 'examples-pool')
const POOL_PROMPT = 'The test suite of this project fails. Find and fix the bugs in the files under src/ until `node --test` passes. Do not edit the tests. Finally answer with a one-line summary.'
const copyUnits = async (dir: string, units: string[], kinds: ('src' | 'test')[]) => {
  for (const kind of kinds) {
    await mkdir(path.join(dir, kind), { recursive: true })
    for (const name of units) {
      const file = kind === 'src' ? `${name}.js` : `${name}.test.js`
      await cp(path.join(POOL_ROOT, kind, file), path.join(dir, kind, file))
    }
  }
}

/** Grows with --size until a healthy run fills the window. The text names no technique; `node --test` is the success criterion. */
const poolTask = (name: string, order: readonly string[]): Task => {
  /** The first `size` units. A size outside 1..order.length is a caller's bug: an empty list would turn `node --test` into recursive discovery. */
  const firstUnits = (size: number): string[] => {
    if (!Number.isInteger(size) || size < 1 || size > order.length) throw new RangeError(`${name} size must be an integer from 1 to ${order.length}, got ${size}`)
    return order.slice(0, size)
  }
  return {
    prompt: POOL_PROMPT,
    max: order.length,
    async prepare(size = order.length) {
      const units = firstUnits(size)
      const dir = await mkdtemp(path.join(tmpdir(), `lhb-${name}-`))
      await cp(path.join(POOL_ROOT, 'package.json'), path.join(dir, 'package.json'))
      await copyUnits(dir, units, ['src', 'test'])
      return dir
    },
    // The model can reach test/: the verdict is taken on pristine tests, and only on them — a file it
    // added cannot fail a correct fix, a test it rewrote cannot pass a wrong one.
    check(dir, size = order.length) {
      // This function deletes <dir>/test: a relative or empty dir would resolve against the cwd.
      if (!path.isAbsolute(dir)) throw new RangeError(`${name} check needs an absolute workdir, got ${JSON.stringify(dir)}`)
      const files = firstUnits(size).map(u => path.join('test', `${u}.test.js`))
      rmSync(path.join(dir, 'test'), { recursive: true, force: true })
      mkdirSync(path.join(dir, 'test'))
      for (const f of files) copyFileSync(path.join(POOL_ROOT, f), path.join(dir, f))
      return spawnSync(process.execPath, ['--test', ...files], { cwd: dir, timeout: 60_000 }).status === 0
    },
  }
}

/** Step 3b of a news curator: split the screener's verdicts into what goes on and what is only reported. The fixture is
 *  synthetic, in the bytes the screener prints (Python's json.dumps, ensure_ascii off); size N means its first N lines. */
const SIFT_FIXTURE = path.join(PKG_ROOT, 'examples-sift', 'screen.jsonl')
const sift: Task = (() => {
  type Row = { id: number; verdict: 'PASS' | 'DROP'; reason: string; quotes: string[] }
  const all = () => readFileSync(SIFT_FIXTURE, 'utf8').split('\n').filter(Boolean)
  const max = 12
  const first = (size: number): string[] => {
    if (!Number.isInteger(size) || size < 1 || size > max) throw new RangeError(`sift size must be an integer from 1 to ${max}, got ${size}`)
    return all().slice(0, size)
  }
  /** The lines of a file the model wrote, blank ones dropped; a file that is not there has none. */
  const linesOf = (file: string): string[] => { try { return readFileSync(file, 'utf8').split('\n').map(l => l.trimEnd()).filter(Boolean) } catch { return [] } }
  /** One PASS line as a value: key order and spacing are the writer's, every character of the content is not. */
  const canon = (line: string): string => { try { const o = JSON.parse(line) as Row; return JSON.stringify([o.id, o.verdict, o.reason, o.quotes]) } catch { return `not JSON: ${line}` } }
  const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
  return {
    prompt: '`screen.jsonl` holds one JSON object per line: the verdict of a screener on one post. Write `pass.jsonl` with the lines whose verdict is PASS, each exactly as it is in `screen.jsonl`. Write `drops.txt` with one line per DROP verdict, in the form `<id>: <reason>`, the reason exactly as given. Do not edit `screen.jsonl`. Finally answer with the two counts, as `N PASS, M DROP`.',
    max,
    async prepare(size = max) {
      const lines = first(size)
      const dir = await mkdtemp(path.join(tmpdir(), 'lhb-sift-'))
      await writeFile(path.join(dir, 'screen.jsonl'), lines.join('\n') + '\n')
      return dir
    },
    // The expected answer comes from the package's fixture, not from the workdir's copy: editing screen.jsonl changes nothing.
    check(dir, size = max) {
      const rows = first(size).map(l => [l, JSON.parse(l) as Row] as const)
      const pass = rows.filter(([, o]) => o.verdict === 'PASS').map(([l]) => canon(l))
      const drops = rows.filter(([, o]) => o.verdict === 'DROP').map(([, o]) => `${o.id}: ${o.reason}`)
      return same(linesOf(path.join(dir, 'pass.jsonl')).map(canon), pass) && same(linesOf(path.join(dir, 'drops.txt')), drops)
    },
  }
})()

/** Step 2 of the curator: which new posts are worth fetching. A judgement, so the fixture carries its key: KEEP, DROP, EITHER (left open,
 *  not part of the verdict) or DUP (of the posts of one `dup` group that are in the list, exactly one is kept). Synthetic; the key never reaches a workdir.
 *  Only the same URL makes a duplicate: on the real feed "by substance" folded three articles about one launch into one, twice at the cost of a topic.
 *  No post added by hand is in the list: a person chose it, so the curator passes it on without asking a model — told to keep them all, the model still dropped 15 of 105 on the real feed. */
const TRIAGE_FIXTURE = path.join(PKG_ROOT, 'examples-triage', 'posts.jsonl')
/** One required key per id and no other key: held to this, an answer cannot miss a post, repeat one, or name one that was not shown.
 *  The keys go by ascending id whatever the order given: that is how a JS object orders keys that look like integers.
 *  The reason comes first: the few words are written before the verdict they lead to. */
export const verdictSchema = (ids: number[]): Record<string, unknown> => ({
  type: 'object', additionalProperties: false, required: ids.map(String),
  properties: Object.fromEntries(ids.map(id => [String(id), {
    type: 'object', additionalProperties: false, required: ['reason', 'verdict'],
    properties: { reason: { type: 'string', maxLength: 200 }, verdict: { enum: ['KEEP', 'DROP'] } },
  }])),
})
const { triage, judge }: { triage: Task; judge: Task } = (() => {
  type Post = { message_id: number; published: string; source: string; title: string; summary: string; url: string; key: 'KEEP' | 'DROP' | 'EITHER' | 'DUP'; dup?: string }
  const max = 12
  const load = (size: number) => {
    if (!Number.isInteger(size) || size < 1 || size > max) throw new RangeError(`triage size must be an integer from 1 to ${max}, got ${size}`)
    const [head, ...posts] = readFileSync(TRIAGE_FIXTURE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    return { head: head as { head: string[]; foot: string }, posts: (posts as Post[]).slice(0, size) }
  }
  // What to keep and what to drop, in one place: `triage` and `judge` differ in where the posts are and where the answer goes, never in this.
  const RULES = 'Triage them for a channel whose audience is working engineers new to AI agents. The channel is about how to work with agents, not about the news: delegation and oversight, permissions and security, review and testing of what an agent wrote, evals, context and cost, harnesses and local models, and the engineering practice around all of that. DROP a post that claims nothing (an announcement, an empty release note, a bare link), a post that has the same URL as another one in this list, tracking parameters aside (keep one of the two; two articles about one event are not duplicates), and a post that is off-topic. KEEP the rest. If you cannot tell, DROP.'
  /** The form is the curator's own: `select` prints a post as these three lines under its `---` line, with a blank line after. */
  const render = (size: number) => {
    const { head, posts } = load(size)
    const body = posts.map(p => `--- ${p.message_id} · ${p.published} · ${p.source}\n${p.title}\n${p.summary}\n${p.url}\n`)
    return [...head.head, ...body, head.foot.replace('{n}', String(posts.length))].join('\n') + '\n'
  }
  /** `got` holds a verdict for every post, and nothing else: is it the key's? */
  const agrees = (posts: Post[], got: Map<number, unknown>) => {
    const groups = new Map<string, Post[]>()
    for (const p of posts) if (p.key === 'DUP') groups.set(p.dup!, [...(groups.get(p.dup!) ?? []), p])
    return posts.every(p => p.key === 'EITHER' || p.key === 'DUP' || got.get(p.message_id) === p.key)
      && [...groups.values()].every(g => g.filter(p => got.get(p.message_id) === 'KEEP').length === 1)
  }
  const triage: Task = {
    prompt: '`posts.txt` lists the new posts of a feed: a line `--- <id> · <date> · <source>`, then the title, a summary of up to 400 characters, and the URL. ' + RULES + ' Write `triage.jsonl`: one line per post, `{"id": <id>, "verdict": "KEEP" or "DROP", "reason": "<a few words>"}`, every post exactly once. Do not edit `posts.txt`. Finally answer with the two counts, as `N KEEP, M DROP`.',
    max,
    async prepare(size = max) {
      const text = render(size)
      const dir = await mkdtemp(path.join(tmpdir(), 'lhb-triage-'))
      await writeFile(path.join(dir, 'posts.txt'), text)
      return dir
    },
    check(dir, size = max) {
      const { posts } = load(size)
      const got = new Map<number, string>()
      let lines: string[]
      try { lines = readFileSync(path.join(dir, 'triage.jsonl'), 'utf8').split('\n').filter(l => l.trim()) } catch { return false }
      for (const l of lines) {
        let o: { id?: unknown; verdict?: unknown }
        try { o = JSON.parse(l) } catch { return false }
        if (typeof o?.id !== 'number' || got.has(o.id) || (o.verdict !== 'KEEP' && o.verdict !== 'DROP')) return false
        got.set(o.id, o.verdict)
      }
      if (got.size !== posts.length || posts.some(p => !got.has(p.message_id))) return false
      return agrees(posts, got)
    },
  }
  /** The same step as one request: the posts are in the task text, there is no tool, and the final answer is the verdicts. In the agent loop Gemma 12B,
   *  on windows of the real feed, re-read a one-post file until the run ended, put a keyword script in place of the judgement, and wrote ids nobody had shown it. */
  const judge: Task = {
    prompt: 'Below are the new posts of a feed: a line `--- <id> · <date> · <source>`, then the title, a summary of up to 400 characters, and the URL. ' + RULES + ' Answer with one JSON object and nothing else: for every post, its id as the key and `{"reason": "<a few words>", "verdict": "KEEP" or "DROP"}` as the value.',
    max,
    prepare: () => mkdtemp(path.join(tmpdir(), 'lhb-judge-')),
    input: (size = max) => render(size),
    answerSchema: (size = max) => verdictSchema(load(size).posts.map(p => p.message_id)),
    check(_dir, size = max, answer) {
      const { posts } = load(size)
      let o: unknown
      try { o = JSON.parse(answer ?? '') } catch { return false }
      if (typeof o !== 'object' || o === null || Array.isArray(o)) return false
      const got = new Map(Object.entries(o).map(([id, v]) => [Number(id), (v as { verdict?: unknown } | null)?.verdict]))
      if (got.size !== posts.length || posts.some(p => got.get(p.message_id) !== 'KEEP' && got.get(p.message_id) !== 'DROP')) return false
      return agrees(posts, got)
    },
  }
  return { triage, judge }
})()

export const TASKS = { slug, pool: poolTask('pool', POOL), pool2: poolTask('pool2', POOL2), sift, triage, judge }
