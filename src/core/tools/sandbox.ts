import { realpath, lstat, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

async function exists(p: string): Promise<boolean> {
  try { await lstat(p); return true } catch { return false }
}

/**
 * Resolves `p` against `workdir` and proves the result stays inside it:
 * lexical normalize -> realpath of the deepest existing ancestor -> prefix check.
 * Symlinks pointing outside are caught even when the leaf does not exist yet.
 */
export async function resolveInside(workdir: string, p: string): Promise<string> {
  const root = await realpath(workdir)
  const target = path.resolve(root, p)
  let existing = target
  while (!(await exists(existing))) existing = path.dirname(existing)
  let realExisting: string
  try { realExisting = await realpath(existing) } catch { throw new Error(`path escapes workdir: ${p}`) }
  const real = path.join(realExisting, path.relative(existing, target))
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`path escapes workdir: ${p}`)
  return real
}

export async function validateWorkdir(dir: string): Promise<string | null> {
  const abs = path.resolve(dir)
  if (abs === path.parse(abs).root) return 'workdir must not be the filesystem root'
  if (abs === path.resolve(homedir())) return 'workdir must not be your home directory'
  let s
  try { s = await stat(abs) } catch { return `workdir does not exist: ${abs}` }
  if (!s.isDirectory()) return `workdir is not a directory: ${abs}`
  return null
}
