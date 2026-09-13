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
    // Decide now, not when the signal fires: a `once` listener (e.g. bench's) removes itself
    // from the registry before later listeners run, so a fire-time count cannot tell "I am
    // alone" from "a peer's handler already fired and its async work is still in flight".
    const owns = process.listenerCount(sig) === 0
    process.on(sig, () => {
      killAll()
      if (owns) process.exit(code)
      // Someone else owns the exit (bench flushes its PASS table asynchronously first).
      // Back-stop it: if they have not exited shortly, we do, so Ctrl-C never hangs.
      else setTimeout(() => process.exit(code), 2000).unref()
    })
  }
}

/** Remember a detached group so it dies with us. Safe to call for every child. */
export function track(pid: number): void { live.add(pid); hook() }

/** Forget a group that has already exited. */
export function untrack(pid: number): void { live.delete(pid) }
