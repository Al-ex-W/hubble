import type { Express } from 'express'
import { z } from 'zod'
import type { SpatialService } from './service.ts'
import { MarkerObservation, Observation } from './observations.ts'
import { printSheet } from './printSheet.ts'
import { streamSpatial } from './stream.ts'
const number = z.number().finite().min(-100000).max(100000)
const point = z.object({ x: number, y: number }).strict()
const pair = z.object({ from: point, to: point }).strict()
const targets = z.array(pair).min(4).max(100)
const checks = z.array(pair).min(2).max(100)
const registration = z
  .object({
    table: targets,
    tableCheck: checks,
    lidar: targets,
    lidarCheck: checks,
    maxProjectorErrorPx: z.number().positive().max(20),
    maxTableErrorMm: z.number().positive().max(50),
  })
  .strict()

/** Thin HTTP boundary; no transform, source selection or contact logic here. */
export function mountSpatial(app: Express, spatial: SpatialService) {
  app.get('/api/spatial', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(spatial.snapshot())
  })
  // Same SpatialFrame/v2 as GET. EventSource consumers listen for 'spatial';
  // ids identify service session/publication, not camera confirmation votes.
  // Last-Event-ID intentionally does not request historical gesture replay.
  app.get('/api/spatial/events', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    streamSpatial(spatial, res)
  })
  // The room camera crop for the open keyboard (#84): the hand tracker streams
  // /api/camera/stream?roi=<roi> and maps landmarks back with `crop`.
  // { roi: null } means stream the full frame.
  app.get('/api/camera/roi', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(spatial.cameraRoi() ?? { roi: null })
  })
  app.post('/api/spatial/observations', (req, res) => {
    const p = Observation.safeParse(req.body)
    if (!p.success) return void res.status(400).json({ error: 'Invalid camera observation' })
    if (!spatial.observe(p.data)) return void res.status(409).json({ error: 'Source lease or frame progress rejected' })
    res.status(202).json({ revision: spatial.calibration.snapshot().revision })
  })
  // Reference markers from a camera (#91): the iPad page posts what it
  // detected on its own frames. The fit and the decision to install are the
  // localizer's; this only validates.
  app.post('/api/spatial/markers', (req, res) => {
    const p = MarkerObservation.safeParse(req.body)
    if (!p.success) return void res.status(400).json({ error: 'Invalid marker observation' })
    const r = spatial.markers(p.data)
    if (!r.ok) return void res.status(r.reason === 'rate' ? 429 : 409).json({ error: r.reason === 'rate' ? 'Too many marker frames' : 'Stale marker frame' })
    res.status(202).json(r.state)
  })
  app.get('/api/spatial/localization', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(spatial.localization())
  })
  // The printed reference markers at true size (#91): print at 100 %, cut,
  // place one near each table corner, then run "reference points" once.
  app.get('/api/spatial/markers/print', (_req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml')
    res.send(printSheet())
  })
  // The empty-table baseline for lidar touch (#89). Explicit, because only a
  // person can know the table is clear; 1–10 s (≥ 30 rotations are needed at
  // 10 Hz, and longer only delays the operator).
  app.post('/api/spatial/baseline', async (req, res) => {
    const ms = req.body?.ms === undefined ? 3000 : Number(req.body.ms)
    if (!Number.isFinite(ms) || ms < 1000 || ms > 10000) return void res.status(400).json({ error: 'ms must be 1000–10000' })
    const r = await spatial.captureBaseline(ms)
    res.status(r.ok ? 200 : 409).json(r)
  })
  app.delete('/api/spatial/baseline', (_req, res) => {
    spatial.clearBaseline()
    res.status(204).end()
  })
  // One held-finger capture in the lidar's own mm (#89 T4), for checking the
  // lidar sees a fingertip before running the whole registration. 0.5–5 s.
  app.post('/api/spatial/registration/capture', async (req, res) => {
    const ms = req.body?.ms === undefined ? 1500 : Number(req.body.ms)
    if (!Number.isFinite(ms) || ms < 500 || ms > 5000) return void res.status(400).json({ error: 'ms must be 500–5000' })
    const r = await spatial.captureFinger(ms)
    res.status(r.ok ? 200 : 409).json(r)
  })
  app.delete('/api/spatial/registration', (_req, res) => {
    spatial.calibration.clearRegistration()
    res.status(204).end()
  })
  app.post('/api/spatial/registration', (req, res) => {
    const p = registration.safeParse(req.body)
    if (!p.success) return void res.status(400).json({ error: 'Provide measured table/lidar targets and independent check targets' })
    try {
      res.json(spatial.calibration.register(p.data))
    } catch (e) {
      res.status(422).json({ error: e instanceof Error ? e.message : 'Registration failed' })
    }
  })
}
