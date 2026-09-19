import { words } from './words.js'

/** titleCase(s): every word capitalised and the rest of it lowered, joined by single spaces: "hello  wORLD" -> "Hello World". */
export function titleCase(s) {
  return words(s).map(w => w[0].toUpperCase() + w.slice(1)).join(' ')
}
