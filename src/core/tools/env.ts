// src/core/tools/env.ts — the environment of every child that runs what the model wrote: bash,
// loop.untilBash and the task checks. Not a boundary: such a child runs as the user and can still
// read our environment (`ps -E`, /proc/<pid>/environ) and any of the user's files. What it does
// is keep variables out of what the model's commands print by accident, and out of tools that pick
// up *_API_KEY by themselves.

/** What a shell, node and git need to run, and the locale for UTF-8. Anything else is named in `tools.bashEnv`. */
export const BASE_ENV: readonly string[] = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME', 'TERM', 'TMPDIR']

/** Whether `from` holds a value under `name` itself: `toString` and the other names every object inherits are not variables, though ENV_NAME lets them through. */
const isSet = (from: NodeJS.ProcessEnv, name: string): boolean => Object.hasOwn(from, name) && from[name] !== undefined

/** The base set plus `extra`, with the values `from` has; a name that is not set there is left out. A harness file names variables, it never sets one. */
export function childEnv(extra: readonly string[] = [], from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const k of [...BASE_ENV, ...extra]) if (isSet(from, k)) env[k] = from[k]
  return env
}

/** The line run, demo and bench print at the start for a harness with `tools.bashEnv`: names only, never a value. */
export function bashEnvNote(names: readonly string[] | undefined, from: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!names?.length) return undefined
  return `bash gets from your environment: ${names.map(n => isSet(from, n) ? n : `${n} (not set)`).join(', ')}`
}
