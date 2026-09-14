// vue-tsc patches TypeScript's JS compiler, which TypeScript 7 (Go) no longer ships; point it at the aliased TS 5.
require('vue-tsc').run(require.resolve('typescript5/lib/tsc'))
