export function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-')
}
