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
    // And at fire time too: a handler added after this one (bench's, when a setup command started the first child) is
    // still registered when this one runs first, and it owns the exit then.
    const first = process.listenerCount(sig) === 0
    process.on(sig, () => {
      killAll()
      if (first && process.listenerCount(sig) === 1) process.exit(code)
      // Someone else owns the exit (bench flushes its PASS table asynchronously first).
      // Back-stop it: if they have not exited shortly, we do, so Ctrl-C never hangs.
      else setTimeout(() => process.exit(code), 2000).unref()
    })
  }
}

/** Remember a detached group so it dies with us. Safe to call for every child. */
export function track(pid: number): void { live.add(pid); hook(); prune() }

const groupAlive = (pid: number): boolean => { try { process.kill(-pid, 0); return true } catch { return false } }

/** Forget a group. `keepIfAlive`: only once it is empty — a command that left a child in the background (`&`) keeps its
 *  group here, so the child dies with the run instead of outliving it. Never for a group just killed: its leader is not
 *  reaped yet and would look alive, and a pgid kept past its group would one day SIGKILL whoever reuses the number. */
export function untrack(pid: number, o: { keepIfAlive?: boolean } = {}): void {
  if (!o.keepIfAlive || !groupAlive(pid)) live.delete(pid)
}

// While anything is tracked, once a second: a group that is gone, or whose pgid answers EPERM (reused by another
// user), is dropped, so the set never holds a number some other process group may own later.
let pruner: NodeJS.Timeout | undefined
function prune() {
  if (pruner || !live.size) return
  pruner = setInterval(() => {
    for (const pid of live) if (!groupAlive(pid)) live.delete(pid)
    if (!live.size) { clearInterval(pruner); pruner = undefined }
  }, 1000).unref()
}

/** SIGKILL every tracked group, wait (at most 1 s) until each is gone, and forget them: what a run left behind dies
 *  before its check looks at the files. */
export async function killTracked(): Promise<void> {
  const pids = [...live]
  for (const pid of pids) try { process.kill(-pid, 'SIGKILL') } catch {}
  for (let t = 0; t < 50 && pids.some(groupAlive); t++) await new Promise(r => setTimeout(r, 20))
  for (const pid of pids) live.delete(pid)
}

export const trackedCount = (): number => live.size
