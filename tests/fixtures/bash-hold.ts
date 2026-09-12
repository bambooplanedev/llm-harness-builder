// Holds a bash tool call open until killed; the bash-tool test SIGINTs this process and checks the shell died with it.
import { bash } from '../../src/core/tools/bash.js'
void bash({ command: `echo $$ > "${process.argv[2]}"; sleep 60` }, { workdir: process.cwd(), maxToolOutputChars: 0 })
