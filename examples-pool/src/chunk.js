/** chunk(arr, size): arr split into consecutive pieces of `size` items; the last piece may be shorter. */
export function chunk(arr, size) {
  const out = []
  for (let i = 0; i + size <= arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
