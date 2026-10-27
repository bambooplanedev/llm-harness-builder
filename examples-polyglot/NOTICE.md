# Notice

The exercises in this directory come from [Exercism](https://exercism.org)'s JavaScript track,
[exercism/javascript](https://github.com/exercism/javascript) at commit `ff04f35158cdf61eebfdf18a774010495a1fd6d9`,
under the MIT License (LICENSE-exercism-javascript). Their instructions come from
[exercism/problem-specifications](https://github.com/exercism/problem-specifications), under the MIT License
(LICENSE-problem-specifications).

The list of exercises follows [Aider's polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark)
(its JavaScript part). Only the list was taken from it. Left out:
- `grep`: CommonJS, its tests spawn `node grep.js` and read files from data/.
- `ledger`: a refactoring exercise: upstream starts from a working implementation, so doing nothing passes every test.

Changes: the Jest tests are converted to `node:test` (`<slug>.test.js`), with a small `expect` (`expect.js`)
in place of Jest's; `xtest` runs as `test`; local imports name their `.js` file. `INSTRUCTIONS.md` joins the
exercise's introduction, instructions and appended instructions.
