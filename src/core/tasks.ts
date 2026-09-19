// src/core/tasks.ts — what `bench` and `demo` can run: the text, the workdir and the verdict of each task, in one place.
import { mkdtemp, cp, writeFile, mkdir } from 'node:fs/promises'
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

export const TASKS = { slug }
