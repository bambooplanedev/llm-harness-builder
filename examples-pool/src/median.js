/** median(nums): the middle value of nums in numeric order; the mean of the two middle values for an even count. */
export function median(nums) {
  const s = [...nums].sort()
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
