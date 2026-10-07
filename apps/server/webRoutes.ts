import type { Express } from 'express'
import type { SurfacesLine } from '@hubble/stage'
import { SURFACE_ID, type SurfaceManager } from './surfaces.ts'
import { allowsUrl, policyFrom, WEB_KEYS, type WebHost, type WebPolicy } from './web.ts'

/**
 * HTTP for web surfaces (#31), apart from index.ts so the browser host and
 * the brain's routes change independently.
 *
 * Ownership: the surface set (the runtime's manager) says which web surfaces
 * exist; the host only follows. A surface closed by any path (the table's
 * close button, the surface route, a future gesture) closes its page through
 * `followSurfaces`, so there is no second list of "open pages" to drift from
 * what the table shows, and no browser page kept alive for a surface nobody
 * can see.
 *
 * Reachable from any page on the room network, so everything is validated
 * narrowly, and the policy is checked here AND in the host (the host's
 * check is the one that matters; this one gives a clean 403 instead of an
 * error surface).
 */
/**
 * A real-world size for a page on the table. 760 × 475 mm is about 940 × 590
 * px at the room's 1550 mm over 1920 px: sites lay out at tablet width,
 * where the first 480 × 300 mm (~595 px) got their phone layout — tiny on a
 * table seen from a chair. The swipe keyboard (~480 × 200 mm) still fits
 * below it on the 1550 × 970 mm table (docs/plans/2026-10-07-web-browsing.md).
 */
export const WEB_SIZE = { widthMm: 760, heightMm: 475 }
const MAX_TEXT = 500
const MAX_URL = 2000
const MAX_SCROLL = 5000
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function createWebRoutes(host: WebHost, allow: readonly string[] | WebPolicy) {
  const policy = policyFrom(allow)
  let surfaces: SurfaceManager | null = null
  let n = 0
  // Told about every page that opens, whoever opened it (the route or the
  // agent's open_web): the runtime focuses it, so the keyboard's SEND types
  // into the page that just came up (the plan's focus ruling).
  let opened: ((id: string) => void) | null = null

  /**
   * Open a webpage as a surface. The one implementation: the route and the
   * table agent's open_web tool (#54) both call it, so the allow-list can't
   * be checked in one place and skipped in the other.
   */
  async function open(url: unknown): Promise<{ id: string } | { status: number; error: string }> {
    if (!surfaces) return { status: 503, error: 'web surfaces are not mounted' }
    if (typeof url !== 'string' || url.length > MAX_URL) return { status: 400, error: 'expected { url }' }
    if (!allowsUrl(url, policy)) return { status: 403, error: 'host not allowed' }
    const id = `web-${++n}`
    const box = surfaces.openWeb(id, url, WEB_SIZE)
    opened?.(id)
    // Awaited (bounded by the host's open deadline) so the caller learns
    // whether the page came up; the surface already shows "loading".
    await host.open(id, url, { w: box.w, h: box.h })
    return { id }
  }

  return {
    open,
    /** Who hears that a page opened (the runtime's focus). One listener: the runtime. */
    onOpen(fn: (id: string) => void) {
      opened = fn
    },
    /** Every published surface line: pages whose surface is gone are closed. */
    followSurfaces(line: SurfacesLine) {
      const live = new Set(line.surfaces.filter((s) => s.kind === 'web').map((s) => s.id))
      for (const id of host.ids()) if (!live.has(id)) void host.close(id)
    },

    mount(app: Express, manager: SurfaceManager) {
      surfaces = manager
      // The surface set says what kind a surface is (one owner), so the
      // answer or an asset can't be driven as a page whatever its id.
      const isWeb = (id: string) => SURFACE_ID.test(id) && manager.list().some((s) => s.id === id && s.kind === 'web')

      app.post('/api/surfaces/web', async (req, res) => {
        const r = await open((req.body ?? {}).url)
        if ('error' in r) return void res.status(r.status).json(r.status === 403 ? { error: r.error, allow } : { error: r.error })
        res.json({ id: r.id, ...manager.line() })
      })

      app.get('/api/web/:id/stream', (req, res) => {
        if (!isWeb(req.params.id) || !host.stream(req.params.id, res)) return void res.status(404).json({ error: 'no such web surface' })
      })

      app.post('/api/web/:id/:op', async (req, res) => {
        const { id, op } = req.params
        if (!isWeb(id)) return void res.status(404).json({ error: 'no such web surface' })
        const b = (req.body ?? {}) as Record<string, unknown>
        const box = manager.list().find((s) => s.id === id)!.box
        const bad = (error: string) => void res.status(400).json({ error })
        let state
        if (op === 'click') {
          // Surface-local px: the page's viewport IS the box, so anything
          // outside it is a client bug, not a click.
          const x = num(b.x)
          const y = num(b.y)
          if (x === null || y === null || x < 0 || y < 0 || x > box.w || y > box.h) return bad('expected { x, y } inside the surface')
          state = await host.click(id, x, y)
        } else if (op === 'scroll') {
          const dy = num(b.dy)
          if (dy === null || Math.abs(dy) > MAX_SCROLL) return bad('expected { dy }')
          state = await host.scroll(id, dy)
        } else if (op === 'type') {
          if (typeof b.text !== 'string' || !b.text || b.text.length > MAX_TEXT) return bad(`expected { text } of 1..${MAX_TEXT} chars`)
          state = await host.type(id, b.text)
        } else if (op === 'key') {
          if (!WEB_KEYS.includes(b.key as (typeof WEB_KEYS)[number])) return bad(`key must be one of ${WEB_KEYS.join(', ')}`)
          state = await host.key(id, b.key as (typeof WEB_KEYS)[number])
        } else if (op === 'back') state = await host.back(id)
        else if (op === 'forward') state = await host.forward(id)
        else if (op === 'navigate') {
          if (typeof b.url !== 'string' || b.url.length > MAX_URL) return bad('expected { url }')
          if (!allowsUrl(b.url, policy)) return void res.status(403).json({ error: 'host not allowed', allow: policy.mode === 'list' ? policy.hosts : 'any public site' })
          state = await host.navigate(id, b.url)
        } else return void res.status(404).json({ error: 'op must be click, scroll, type, key, back, forward or navigate' })
        res.json(state)
      })
    },

    /** The host's state reports, into the surface set (what displays see). */
    onState(id: string, s: { url: string; title: string; status: 'loading' | 'ready' | 'error'; error?: string }) {
      surfaces?.updateWeb(id, s)
    },
  }
}
