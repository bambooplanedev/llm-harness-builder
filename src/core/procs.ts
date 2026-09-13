/**
 * Detached child process groups that must not outlive this process. `bash` and MCP servers both
 * register here: neither can rely on a `finally`, because every exit path in the CLI goes through
 * `process.exit`, which does not unwind a pending async generator.
 */
const live = new Set<number>()

const killAll = () => { for (const pid of live) try { process.kill(-pid, 'SIGKILL') } catch {} }

let hooked = false
function hook() {
  if (hooked) return
  hooked = true
  process.on('exit', killAll)
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    process.on(sig, () => {
      killAll()
      // Exit only when nothing else is handling the signal. `bench` installs its own handler
      // first and finishes an async stdout write before exiting (src/cli.ts:228); exiting here
      // would cut that write and drop the table of a 90-minute run.
      if (process.listenerCount(sig) === 1) process.exit(code)
    })
  }
}

/** Remember a detached group so it dies with us. Safe to call for every child. */
export function track(pid: number): void { live.add(pid); hook() }

/** Forget a group that has already exited. */
export function untrack(pid: number): void { live.delete(pid) }
