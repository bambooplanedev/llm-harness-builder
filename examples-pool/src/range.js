/** range(start, end, step = 1): start, start + step, ... up to but not including end. A negative step counts down. */
export function range(start, end, step = 1) {
  const out = []
  for (let x = start; x < end; x += step) out.push(x)
  return out
}
