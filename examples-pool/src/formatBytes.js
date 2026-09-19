/** formatBytes(n): "512 B", "1.5 KB", "1.0 MB" — 1024 of a unit is already 1.0 of the next one. */
export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n > 1024 && i < units.length - 1) { n /= 1024; i++ }
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`
}
