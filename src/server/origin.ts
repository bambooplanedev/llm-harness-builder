// src/server/origin.ts — who may talk to serve and the proxy: a request to a local Host, and from a browser only a page
// this same server served. A page on another port of localhost (a dev server, any local app) is another origin.
import type http from 'node:http'

const LOCAL = new Set(['localhost', '127.0.0.1'])

/** Why the request is refused, or nothing. No Origin is a client that is not a browser (curl, an agent, the tests); a
 *  browser sends Origin with every cross-origin POST, so a page elsewhere cannot leave it out. */
export function refusal(req: http.IncomingMessage): 'forbidden host' | 'forbidden origin' | undefined {
  const host = req.headers.host ?? ''
  if (!LOCAL.has(host.replace(/:\d+$/, ''))) return 'forbidden host'
  if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) return 'forbidden origin'
  return undefined
}
