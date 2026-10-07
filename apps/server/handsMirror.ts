import type { Express } from 'express'
import { z } from 'zod'

/**
 * The hand tracker's latest landmarks, mirrored for watchers (the operator's
 * camera view draws the joints over the room camera).
 *
 * One owner of hand tracking: the tracker in the bench tab (HandPanel). The
 * operator page does not run a second MediaPipe on its stills. Two trackers
 * would disagree, and the operator must see what the tracker that drives the
 * keyboard sees, including its misses.
 *
 * Only the newest snapshot is kept, with its arrival time, so a stopped
 * tracker reads as stale instead of freezing a hand on screen. Nothing acts
 * on this: gestures still go through /api/input/gesture.
 */
const Pt = z.tuple([z.number().finite(), z.number().finite()])
const Body = z.object({
  /** Which camera the points are in: the room camera's pixels, or a laptop webcam's. */
  source: z.enum(['room', 'local']),
  width: z.number().int().positive().max(8000),
  height: z.number().int().positive().max(8000),
  pinch: z.boolean(),
  hands: z.array(z.object({ lm: z.array(Pt).length(21) })).max(2),
})
export type HandsSnapshot = z.infer<typeof Body>

export function mountHandsMirror(app: Express, now: () => number = Date.now) {
  let latest: { at: number; snap: HandsSnapshot } | null = null
  app.post('/api/input/hands', (req, res) => {
    const p = Body.safeParse(req.body)
    if (!p.success) return void res.status(400).json({ error: 'bad hands snapshot' })
    latest = { at: now(), snap: p.data }
    res.status(204).end()
  })
  app.get('/api/input/hands', (_req, res) => {
    if (!latest) return void res.json({ ageMs: null })
    res.json({ ageMs: now() - latest.at, ...latest.snap })
  })
}
