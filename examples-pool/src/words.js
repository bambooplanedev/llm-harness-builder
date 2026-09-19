/** words(s): the words of s, split on anything that is not a letter or a digit. Case is kept. Never returns empty strings. */
export function words(s) {
  return s.split(/[^A-Za-z0-9]+/)
}
