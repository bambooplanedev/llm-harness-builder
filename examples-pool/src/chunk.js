/** chunk(arr, size): arr split into consecutive pieces of `size` items; the last piece may be shorter. */
export function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, size))
  return out
}
