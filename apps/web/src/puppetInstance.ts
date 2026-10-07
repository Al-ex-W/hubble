import { useEffect } from 'react'

/**
 * Which puppet master this page is talking to (owner, 7 Oct: the same
 * instance must run the Hubble blob view and the projector). The server's
 * GET /api/puppet/instance names it; this stamps it on the document as
 * `data-puppet-instance` and `data-puppet-origin` so /overall, which frames
 * /tv and /table same-origin, can read both and shout if they differ. A page
 * served from another origin or port is exactly the failure to catch: its
 * origin is stamped too, and the overall view compares them.
 * Silent on failure: a kiosk page never shows an error.
 */
export function usePuppetInstance() {
  useEffect(() => {
    let alive = true
    void fetch('/api/puppet/instance')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { instanceId?: unknown } | null) => {
        if (!alive || !j || typeof j.instanceId !== 'string') return
        document.documentElement.dataset.puppetInstance = j.instanceId
        document.documentElement.dataset.puppetOrigin = location.origin
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])
}
