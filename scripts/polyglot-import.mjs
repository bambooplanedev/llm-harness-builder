#!/usr/bin/env node
// scripts/polyglot-import.mjs <exercism-javascript-clone> — builds examples-polyglot/ and polyglot-proofs/ from a clone
// of exercism/javascript at COMMIT. Run after `npm run build`. Writes nothing unless every proof passes and every stub fails.
// The exercise list follows Aider's polyglot benchmark (JavaScript), minus the EXCLUDED.
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTests, score } from '../dist/core/polyglot.js'
import { childEnv } from '../dist/core/tools/env.js'

const COMMIT = 'ff04f35158cdf61eebfdf18a774010495a1fd6d9'
const EXCLUDED = [
  { name: 'grep', reason: 'CommonJS, its tests spawn `node grep.js` and read files from data/' },
  { name: 'ledger', reason: 'a refactoring exercise: upstream starts from a working implementation, so doing nothing passes every test' },
]
/** Bench order: round-robin over the track's difficulties (2..8), so any first N spans easy to hard. */
const ORDER = [
  'space-age', 'phone-number', 'affine-cipher', 'beer-song', 'list-ops', 'alphametics', 'bowling',
  'scale-generator', 'binary', 'book-store', 'promises', 'connect', 'forth',
  'tournament', 'complex-numbers', 'bottle-song', 'rest-api', 'meetup', 'react',
  'transpose', 'food-chain', 'go-counting', 'robot-name', 'palindrome-products', 'simple-linked-list',
  'triangle', 'house', 'grade-school', 'say', 'parallel-letter-frequency', 'word-search',
  'pig-latin', 'killer-sudoku-helper', 'two-bucket', 'poker', 'zipper',
  'queen-attack', 'wordy',
  'rectangles', 'ocr-numbers', 'zebra-puzzle',
  'twelve-days', 'rational-numbers',
  'resistor-color-trio',
  'state-of-tic-tac-toe',
  'sum-of-multiples',
  'variable-length-quantity',
]
/** Proofs that are CommonJS upstream: their ESM ports are kept by hand in polyglot-proofs/ and never overwritten. */
const PORTED = ['parallel-letter-frequency', 'word-search']
const HOOKS = ['describe', 'test', 'beforeEach', 'afterEach']

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(root, 'examples-polyglot'), PROOFS = path.join(root, 'polyglot-proofs')
const clone = process.argv[2]
if (!clone) { console.error('usage: node scripts/polyglot-import.mjs <exercism-javascript-clone>'); process.exit(2) }
const head = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (head !== COMMIT) { console.error(`the clone is at ${head}, not ${COMMIT}`); process.exit(1) }
if (new Set(ORDER).size !== 47) throw new Error('ORDER must name 47 distinct exercises')

/** Jest globals → node:test, `./x` → `./x.js`, the bridge first. */
function convert(name, spec) {
  let s = spec.replace(/import\s*\{[^}]*\}\s*from\s*'@jest\/globals';?\n/, '')
    .replace(/\bx(test|it)\(/g, 'test(')
    .replace(/from '(\.\/[^']+?)(?<!\.js)'/g, "from '$1.js'")
  const left = /@jest\/globals|\bjest\.|\b(it|xit|xtest|xdescribe|beforeAll|afterAll)\(/.exec(s)
  if (left) throw new Error(`${name}: ${left[0]} is not converted`)
  if (!s.includes(`from './${name}.js'`)) throw new Error(`${name}: the test does not import ./${name}.js`)
  const used = HOOKS.filter(h => new RegExp(`\\b${h}(\\.skip)?\\(`).test(s))
  return `import { expect } from './expect.js';\n${used.length ? `import { ${used.join(', ')} } from 'node:test';\n` : ''}${s}`
}

const read = (...p) => readFile(path.join(...p), 'utf8')
const config = JSON.parse(await read(clone, 'config.json'))
const work = await mkdtemp(path.join(tmpdir(), 'lhb-polyglot-import-'))
const exercises = [], problems = []
for (const name of ORDER) {
  const src = path.join(clone, 'exercises', 'practice', name)
  const meta = JSON.parse(await read(src, '.meta', 'config.json'))
  const dir = path.join(work, 'set', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${name}.test.js`), convert(name, await read(src, meta.files.test[0])))
  await cp(path.join(src, meta.files.solution[0]), path.join(dir, `${name}.js`))
  const docs = []
  for (const f of ['introduction.md', 'instructions.md', 'instructions.append.md']) if (existsSync(path.join(src, '.docs', f))) docs.push((await read(src, '.docs', f)).trimEnd())
  await writeFile(path.join(dir, 'INSTRUCTIONS.md'), docs.join('\n\n') + '\n')
  const proof = PORTED.includes(name) ? path.join(PROOFS, `${name}.js`) : path.join(src, meta.files.example[0])
  await cp(proof, path.join(work, 'proofs', `${name}.js`))

  const runWith = async solution => {
    const d = path.join(work, 'run', `${name}-${path.basename(path.dirname(solution))}`)
    await cp(dir, d, { recursive: true })
    await cp(path.join(OUT, 'expect.js'), path.join(d, 'expect.js'))
    await writeFile(path.join(d, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}\n')
    await cp(solution, path.join(d, `${name}.js`))
    return runTests(d, `${name}.test.js`, childEnv())
  }
  const ran = await runWith(path.join(work, 'proofs', `${name}.js`))
  const tests = ran.results.filter(r => r.status !== 'skip').map(r => r.path)
  const proofScore = score(ran.results, tests, ran.exit, `${name}.test.js`)
  if (!tests.length || !proofScore.pass) problems.push(`${name}: the proof does not pass (${proofScore.reason ?? 'no tests'})`)
  const stub = await runWith(path.join(dir, `${name}.js`))
  if (score(stub.results, tests, stub.exit, `${name}.test.js`).passed >= tests.length) problems.push(`${name}: the stub passes every test`)
  const difficulty = config.exercises.practice.find(e => e.slug === name).difficulty
  exercises.push({ name, difficulty, tests })
  console.log(`${name}: difficulty ${difficulty}, ${tests.length} tests`)
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1) }

for (const name of ORDER) {
  await rm(path.join(OUT, name), { recursive: true, force: true })
  await cp(path.join(work, 'set', name), path.join(OUT, name), { recursive: true })
}
await mkdir(PROOFS, { recursive: true })
await cp(path.join(work, 'proofs'), PROOFS, { recursive: true })
await cp(path.join(clone, 'LICENSE'), path.join(OUT, 'LICENSE-exercism-javascript'))
await writeFile(path.join(OUT, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}\n')
await writeFile(path.join(OUT, 'set.json'), JSON.stringify({ source: { repo: 'exercism/javascript', commit: COMMIT }, excluded: EXCLUDED, exercises }, null, 2) + '\n')
await writeFile(path.join(OUT, 'NOTICE.md'), `# Notice

The exercises in this directory come from [Exercism](https://exercism.org)'s JavaScript track,
[exercism/javascript](https://github.com/exercism/javascript) at commit \`${COMMIT}\`,
under the MIT License (LICENSE-exercism-javascript). Their instructions come from
[exercism/problem-specifications](https://github.com/exercism/problem-specifications), under the MIT License
(LICENSE-problem-specifications).

The list of exercises follows [Aider's polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark)
(its JavaScript part). Only the list was taken from it. Left out:
${EXCLUDED.map(e => `- \`${e.name}\`: ${e.reason}.`).join('\n')}

Changes: the Jest tests are converted to \`node:test\` (\`<slug>.test.js\`), with a small \`expect\` (\`expect.js\`)
in place of Jest's; \`xtest\` runs as \`test\`; local imports name their \`.js\` file. \`INSTRUCTIONS.md\` joins the
exercise's introduction, instructions and appended instructions.
`)
await rm(work, { recursive: true, force: true })
console.log(`wrote ${exercises.length} exercises to ${path.relative(root, OUT)}`)
