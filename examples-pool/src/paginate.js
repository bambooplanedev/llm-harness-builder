import { chunk } from './chunk.js'

/** paginate(items, page, perPage): the items of one page; pages are numbered from 1. A page out of range is []. */
export function paginate(items, page, perPage) {
  return chunk(perPage, items)[page - 1] ?? []
}
