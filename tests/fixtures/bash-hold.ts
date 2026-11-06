// Holds a bash tool call open until killed; the bash-tool test signals this process and checks the shell died with it.
// The shell writes its pid only after `<pid file>.armed` exists, which this file writes once bash() has spawned the
// shell and set up the signal handling: a signal sent on seeing the pid can then never beat that setup.
import { writeFileSync } from 'node:fs'
import { bash } from '../../src/core/tools/bash.js'
const f = process.argv[2]
void bash({ command: `while [ ! -e "${f}.armed" ]; do sleep 0.01; done; echo $$ > "${f}"; sleep 60` }, { workdir: process.cwd() })
writeFileSync(`${f}.armed`, '')
