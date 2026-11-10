// A prompt hook for tests. A real child process, not a mock. The first argument picks the behaviour;
// the second, when given, is a file it writes on start (so a test can tell it ran).
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [mode, mark] = process.argv.slice(2)
if (mark) writeFileSync(mark, mode ?? '')
const hang = () => setInterval(() => {}, 1 << 30)
const out = s => process.stdout.write(s)

const readStdin = async () => { let s = ''; for await (const c of process.stdin) s += c; return s }

switch (mode) {
  case 'echo-stdin':
    out(`${await readStdin()}\nCLAUDE_PROJECT_DIR=${process.env.CLAUDE_PROJECT_DIR}\nKEY_SEEN=${process.env.LHB_TEST_API_KEY ? 'yes' : 'no'}\n`)
    break
  case 'plain': out('  ctx line  \n'); break
  case 'json-ctx': out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'from json' } })); break
  case 'json-empty': out('{"continue":true}'); break
  case 'fail': out('out'); process.exitCode = 1; break
  case 'exit2': out('out'); process.stderr.write('no secrets please\n'); process.exitCode = 2; break
  case 'block': out(JSON.stringify({ decision: 'block', reason: 'R' })); break
  case 'hang': out('out'); hang(); break
  case 'grandchild': {
    const g = spawn('sleep', ['30'], { stdio: ['ignore', 'inherit', 'ignore'], detached: false })
    process.stderr.write(`${g.pid}\n`)
    hang()
    break
  }
  case 'background': {
    const g = spawn('sleep', ['30'], { stdio: ['ignore', 'inherit', 'ignore'], detached: false })
    g.unref()
    process.stderr.write(`${g.pid}\n`)
    out('ctx', () => process.exit(0))
    break
  }
  case 'no-read': process.exit(0)
  case 'flood': { const mb = 'x'.repeat(1 << 20); for (let i = 0; i < 50; i++) out(mb); break }
  case 'stderr': out('ok'); process.stderr.write('MARKER-ERR\n'); break
  default: process.stderr.write(`unknown mode ${mode}\n`); process.exitCode = 3
}
