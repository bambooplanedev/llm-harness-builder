"""Runs a command under a pseudo-terminal and plays keystrokes into it.

argv: <steps.json> <command> [args...]
steps: a JSON list; each step is {"after": "<text>", "send": "<keys>"} (send once <text> has been
printed) or {"delay": <seconds>, "send": "<keys>"} (send that long after the previous step).
Prints everything the command wrote to the terminal, then a last line "EXIT <code>".
"""
import json, os, pty, select, sys, time

steps = json.load(open(sys.argv[1]))
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])

out, step, since, deadline = b'', 0, time.time(), time.time() + 30
while True:
    if time.time() > deadline:
        os.kill(pid, 9)
        break
    if step < len(steps):
        s = steps[step]
        if ('after' in s and s['after'].encode() in out) or ('delay' in s and time.time() - since >= s['delay']):
            os.write(fd, s['send'].encode())
            step, since = step + 1, time.time()
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode('utf8', 'replace'))
sys.stdout.write('\nEXIT %d\n' % os.waitstatus_to_exitcode(status))
