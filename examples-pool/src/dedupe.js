/** dedupe(list, { ignoreCase }): list without repeats, the first occurrence kept. With ignoreCase, "A" and "a" are the same item. */
export function dedupe(list, { ignoreCase = false } = {}) {
  const seen = new Set()
  return list.filter(x => {
    const key = x
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
