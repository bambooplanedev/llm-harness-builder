import { test, expect, vi } from 'vitest'
import { spawn } from 'node:child_process'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

// `hooked` is module-level state, so two tests sharing one module instance in the same file would
// fight over which of them is "first ever" to install the listener. Give each test a fresh module
// instance instead of relying on declaration order to isolate it.
const freshProcs = async () => { vi.resetModules(); return import('../src/core/procs.js') }

test('the SIGINT listener does not exit when another listener is already installed', async () => {
  // bench installs its own handler and writes the table asynchronously; ours must only kill
  // children and let bench decide when to exit, or the table of a 90-minute run is lost.
  const { track, untrack } = await freshProcs()
  const other = () => {}
  process.on('SIGINT', other)
  const child = spawn('sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' })
  track(child.pid!)
  const ours = process.listeners('SIGINT').at(-1) as () => void
  expect(() => ours()).not.toThrow()          // must NOT call process.exit
  await new Promise(r => setTimeout(r, 100))  // let the event loop reap the killed child
  expect(alive(child.pid!)).toBe(false)        // but must still kill the group
  untrack(child.pid!)
  process.off('SIGINT', other)
})

test('track registers exactly one SIGINT listener however many pids are tracked', async () => {
  const { track, untrack } = await freshProcs()
  const before = process.listenerCount('SIGINT')
  const a = spawn('sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' })
  const b = spawn('sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' })
  track(a.pid!); track(b.pid!)
  expect(process.listenerCount('SIGINT')).toBe(before + 1)
  untrack(a.pid!); untrack(b.pid!)
  process.kill(-a.pid!, 'SIGKILL'); process.kill(-b.pid!, 'SIGKILL')
})

test('untrack forgets a pid so it is not killed later', async () => {
  const { track, untrack } = await freshProcs()
  const child = spawn('sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' })
  track(child.pid!); untrack(child.pid!)
  expect(alive(child.pid!)).toBe(true)
  process.kill(-child.pid!, 'SIGKILL')
})

// R7: ownership is decided when the listener is registered, not when the signal fires — a `once`
// listener (bench's) removes itself from the registry before later listeners run, so a fire-time
// `listenerCount` check cannot tell "I am alone" from "a peer's handler already fired and is
// still mid-write". These two tests pin that decision by its actual effect (was process.exit
// called?), not by where our listener sits in the listener array.

test('the registry exits when it owns the signal (no earlier listener)', async () => {
  // Clear the field so this test's "no pre-existing listener" premise holds regardless of what
  // other tests in this file left behind, then restore it exactly, whatever it was.
  const preexisting = process.listeners('SIGINT') as Array<(...a: unknown[]) => void>
  preexisting.forEach(l => process.removeListener('SIGINT', l))
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  try {
    const { track, untrack } = await freshProcs()
    const child = spawn('sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' })
    track(child.pid!)
    const ours = process.listeners('SIGINT')[0] as () => void
    ours()
    expect(exitSpy).toHaveBeenCalledWith(130)
    await new Promise(r => setTimeout(r, 100))
    expect(alive(child.pid!)).toBe(false)
    untrack(child.pid!)
    process.off('SIGINT', ours)
  } finally {
    exitSpy.mockRestore()
    preexisting.forEach(l => process.on('SIGINT', l))
  }
})

test('the registry kills the group but does not exit when another listener already owns the signal', async () => {
  const other = () => {}
  process.on('SIGINT', other)                 // installed before track(), so it owns the signal
  const before = process.listeners('SIGINT')
  const { track, untrack } = await freshProcs()
  const child = spawn('sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' })
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  track(child.pid!)
  const ours = process.listeners('SIGINT').find(l => !before.includes(l)) as () => void
  ours()
  expect(exitSpy).not.toHaveBeenCalled()
  await new Promise(r => setTimeout(r, 100))
  expect(alive(child.pid!)).toBe(false)
  untrack(child.pid!)
  process.off('SIGINT', other)
  process.off('SIGINT', ours)
  exitSpy.mockRestore()
})
