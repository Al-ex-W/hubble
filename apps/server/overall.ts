import type { Express } from 'express'
import type { DisplayId, Room } from '@hubble/room'
import { DISPLAY_IDS, DISPLAY_PAGES, isDisplayPage, PAGE_PATH, type DisplayMap, type DisplayPage } from './displays.ts'
import type { Runtime } from './runtime.ts'

/**
 * The overall view's server side (docs/plans/2026-10-07-overall-view.md):
 * the EMULATED / LIVE switch for the three displays.
 *
 * Owner, 7 Oct: "this should work even when not connected to the real deal,
 * with a simple switch to make it also render on the real thing."
 *
 * - Emulated (the default, and what every restart returns to): nothing here
 *   touches the room. The page's iframes ARE the screens. This module makes no
 *   call at all, not even a status read, so emulated mode can't reach the
 *   device pool (a test pins it with a room that throws on any call).
 * - Live: the page's choices are pushed through the EXISTING re-point path,
 *   runtime.setDisplay (slot writer → device pool). That path's rules are not
 *   restated or loosened here: disarmed, a choice is only remembered and
 *   applied when the owner arms; armed, the pool still holds every write to the
 *   hardware window. This module adds ONE refusal in front (runtime.liveGate:
 *   no room, or the real room outside n:10–n:30) so the switch can't look on
 *   when it can't be, and it never arms anything for the owner.
 *
 * Turning Live off stops following; it does not push anything back. Restoring
 * what the displays showed before is the Setup control's job, and a write
 * "back" would be one more shared-display write nobody asked for.
 *
 * "A server for each" (owner) is read as one route + stream per screen behind
 * the ONE port (AGENTS.md: "One port for people"): /tv, /datawall, /table
 * each already have their own page and event stream on this server.
 */

/** The owner's layout for the overall view, 7 Oct: TV 1 the talking blob, TV 2 the data panel, the projector /table. */
export const OVERALL_LAYOUT: DisplayMap = { table: 'table', 'tv-1': 'tv', 'tv-2': 'datawall' }

export interface OverallDeps {
  runtime: Pick<Runtime, 'displays' | 'setDisplay' | 'roomOutput' | 'liveGate'>
  room?: Pick<Room, 'info' | 'kind'>
  /** A device status read may take this long; the pool has its own deadlines too. */
  statusDeadlineMs?: number
}

export function mountOverall(app: Express, d: OverallDeps) {
  let live = false
  let lastPushed: DisplayMap | null = null
  let statusMemo: { at: number; value: Record<string, { reachable: boolean; width?: number; height?: number }> | null } | null = null

  /** Live only counts while a push could still reach a device: the window closing at :30 puts the view back to emulated by itself. */
  const effectiveLive = () => {
    if (live && !d.runtime.liveGate().ok) live = false
    return live
  }

  /** Real-device reachability, from the room's own info() (each display's /status through the pool). Only ever called while live. */
  async function deviceStatus() {
    if (!d.room) return null
    if (statusMemo && Date.now() - statusMemo.at < 4000) return statusMemo.value
    let timer: ReturnType<typeof setTimeout> | undefined
    let value: NonNullable<typeof statusMemo>['value'] = null
    try {
      const info = await Promise.race([
        d.room.info(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('no answer')), d.statusDeadlineMs ?? 3500)
        }),
      ])
      value = Object.fromEntries(DISPLAY_IDS.map((id) => {
        const hit = info.displays.find((x) => x.id === id)
        return [id, hit ? { reachable: true, width: hit.width, height: hit.height } : { reachable: false }]
      }))
    } catch {
      value = null
    } finally {
      clearTimeout(timer)
    }
    statusMemo = { at: Date.now(), value }
    return value
  }

  async function snapshot() {
    const isLive = effectiveLive()
    return {
      live: isLive,
      layout: OVERALL_LAYOUT,
      /** What the room is pointed at (the display map): shown beside each frame so a difference from the layout is visible. */
      roomMap: d.runtime.displays(),
      paths: PAGE_PATH,
      pages: DISPLAY_PAGES,
      output: d.runtime.roomOutput(),
      gate: d.runtime.liveGate(),
      lastPushed,
      devices: isLive ? await deviceStatus() : null,
    }
  }

  app.get('/api/overall', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await snapshot())
  })

  app.post('/api/overall/live', async (req, res) => {
    const b = (req.body ?? {}) as { on?: unknown; pages?: unknown }
    if (typeof b.on !== 'boolean') return void res.status(400).json({ error: 'on must be true or false' })
    if (!b.on) {
      live = false
      statusMemo = null
      return void res.json(await snapshot())
    }
    const pages = (b.pages ?? OVERALL_LAYOUT) as Record<string, unknown>
    const chosen = {} as DisplayMap
    for (const id of DISPLAY_IDS as readonly DisplayId[]) {
      const p = pages[id]
      if (!isDisplayPage(p)) return void res.status(400).json({ error: `pages.${id} must be one of ${DISPLAY_PAGES.join(', ')}` })
      chosen[id] = p as DisplayPage
    }
    // The one refusal this module adds. 409 + the reason, never a quiet "ok".
    const gate = d.runtime.liveGate()
    if (!gate.ok) {
      live = false
      return void res.status(409).json({ ...(await snapshot()), error: gate.reason })
    }
    for (const id of DISPLAY_IDS as readonly DisplayId[]) await d.runtime.setDisplay(id, chosen[id])
    live = true
    lastPushed = chosen
    statusMemo = null
    res.json(await snapshot())
  })
}
