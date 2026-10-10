/**
 * Substrings of the tool errors that bench counts and analyze classifies. A module of its own, with no
 * imports, so the browser bundle can read them: fs.ts, where they are thrown, imports node:fs.
 */
export const GUARD_BLOCKED = 'has not been read in this run'
export const EDIT_MISS = 'must occur exactly once'
export const EDIT_IDENTICAL = '"old" and "new" are identical'
