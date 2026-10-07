import type { HandObservation } from '../../../server/spatial/observations.ts'

/** One request plus one replaceable frame, never a queue of old finger positions.
 * A lost reply is not retried. The server's source/sequence guard and lease own
 * acceptance; this producer only bounds delivery work and cancels on teardown. */
export function createObservationClient(fetcher: typeof fetch = fetch, now = () => performance.now()) {
  let pending: { frame: HandObservation; at: number } | null = null
  let busy = false
  let stopped = false
  let request: AbortController | null = null
  const flush = async () => {
    if (stopped || busy || !pending) return
    const next = pending
    pending = null
    if (now() - next.at > 250) return
    busy = true
    request = new AbortController()
    const deadline = setTimeout(() => request?.abort(), 500)
    try {
      await fetcher('/api/spatial/observations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next.frame), signal: request.signal })
    } catch {
      /* Source lease expires at the server; never replay an action. */
    } finally {
      clearTimeout(deadline)
      request = null
      busy = false
      void flush()
    }
  }
  return {
    post(frame: HandObservation) {
      if (!stopped) {
        pending = { frame, at: now() }
        void flush()
      }
    },
    stop() {
      stopped = true
      pending = null
      request?.abort()
    },
  }
}
