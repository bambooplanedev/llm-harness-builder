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
  /** true = PASS. */
  check(dir: string, size?: number): boolean
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

export const TASKS = { slug, pool: poolTask('pool', POOL), pool2: poolTask('pool2', POOL2), sift }
