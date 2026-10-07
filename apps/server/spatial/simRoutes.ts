import type { Express } from 'express'
import { z } from 'zod'
import type { LidarSim } from './lidarSim.ts'

/**
 * The simulated lidar's HTTP surface (docs/plans/2026-10-07-overall-view.md).
 * Thin, like routes.ts: validation and status codes only; the pointer rules,
 * the clock and the real-vs-sim exclusion are lidarSim.ts's and the spatial
 * service's.
 *
 * `sim` is null when this server may not run one (a real lidar is configured,
 * or a room is attached and HUBBLE_LIDAR_SIM is not on). Then every call says
 * why, 409, instead of 404: the overall view shows that reason to the owner,
 * and "not found" would read as a deployment bug.
 */
const pointerBody = z
  .object({
    id: z.string().min(1).max(64),
    phase: z.enum(['down', 'move', 'up']),
    px: z.object({ x: z.number().finite().min(0).max(100000), y: z.number().finite().min(0).max(100000) }).strict().optional(),
  })
  .strict()

export function mountSimLidar(app: Express, sim: LidarSim | null, unavailable: string) {
  app.get('/api/spatial/sim', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(sim ? { available: true, ...sim.state() } : { available: false, reason: unavailable })
  })
  // start (also resumes), heartbeat (keep-alive while the view is open), pause, reset (detach + drop the sim's registration).
  app.post('/api/spatial/sim', (req, res) => {
    const action = (req.body as { action?: unknown } | undefined)?.action
    if (action !== 'start' && action !== 'heartbeat' && action !== 'pause' && action !== 'reset') return void res.status(400).json({ error: 'action must be start, heartbeat, pause or reset' })
    if (!sim) return void res.status(409).json({ available: false, reason: unavailable })
    if (action === 'start') {
      const r = sim.enable()
      if (!r.ok) return void res.status(409).json({ available: false, reason: r.reason })
    } else if (action === 'heartbeat') sim.heartbeat()
    else if (action === 'pause') sim.pause()
    else sim.reset()
    res.json({ available: true, ...sim.state() })
  })
  app.post('/api/spatial/sim/pointer', (req, res) => {
    const p = pointerBody.safeParse(req.body)
    if (!p.success) return void res.status(400).json({ error: 'expected { id, phase: down|move|up, px: {x, y} in projector px }' })
    if (p.data.phase !== 'up' && !p.data.px) return void res.status(400).json({ error: 'px is required for down and move' })
    if (!sim) return void res.status(409).json({ error: unavailable })
    const r = sim.pointer(p.data.phase, p.data.id, p.data.px ?? null)
    res.status(r.ok ? 200 : r.status).json(r)
  })
}
