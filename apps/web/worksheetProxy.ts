import type { ServerResponse } from 'node:http'
import type { ProxyOptions } from 'vite'

/**
 * The iPad worksheet (apps/worksheet) as :5173/worksheet/, so the room
 * network sees one port: the owner, 7 Oct: "we only have a 5173 and not the
 * other port situation". The worksheet server itself listens on loopback.
 *
 * Read-only on purpose. The worksheet server takes task changes only from
 * loopback (the main server sets the task, and the brain is told what it
 * set). Every request this proxy forwards arrives *from* loopback, so a
 * forwarded POST from the iPad, or anyone on the room Wi-Fi, would pass
 * that check, and could put a task on the iPad that the brain doesn't know
 * about. So only reads go through: the page, its script, the state and the
 * event stream. A write gets Vite's 404 and never reaches the server.
 *
 * Its own module, not inline in vite.config.ts, so the refusal is tested
 * (worksheetProxy.test.ts) instead of trusted.
 */
export const WORKSHEET_PATH = '/worksheet'

/** undefined: forward. false: Vite answers 404 itself. */
export function readOnly(req: { method?: string }): false | undefined {
  return req.method === 'GET' || req.method === 'HEAD' ? undefined : false
}

/**
 * `/worksheet` without the slash is redirected, never served: the page asks
 * for `api/state` relative to its own URL, which from `/worksheet` resolves
 * to the bench's `/api/state`, so the iPad would show nothing and look
 * broken. The server hands out the URL with the slash; this covers someone
 * typing it.
 */
export function needsSlash(url: string | undefined): boolean {
  return (url ?? '').split('?')[0] === WORKSHEET_PATH
}

export function worksheetProxy(port: number): ProxyOptions {
  return {
    target: `http://127.0.0.1:${port}`,
    // The server serves its page at / and its API at /api/*; the page asks
    // with relative URLs, so stripping the prefix is all the mapping needed.
    rewrite: (path) => path.slice(WORKSHEET_PATH.length) || '/',
    bypass: (req, res) => {
      if (needsSlash(req.url) && res) {
        ;(res as ServerResponse).writeHead(308, { Location: `${WORKSHEET_PATH}/` }).end()
        // Already answered; false stops Vite forwarding it (its 404 lands on a finished response).
        return false
      }
      return readOnly(req)
    },
  }
}
