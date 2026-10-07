import { mkdirSync, writeFileSync } from 'node:fs'
import type { Express } from 'express'
import { z } from 'zod'
import { MINILAB3 } from '@hubble/room'
import type { Runtime } from './runtime.ts'
import type { Inputs } from './inputs.ts'
import { SONGS } from './lesson/lesson.ts'
import { MAX_MOVE_PX, SURFACE_ID } from './surfaces.ts'

/**
 * HTTP surface of the runtime. Kept apart from index.ts so request handling
 * (the brain's /api/render) and product state can change independently.
 * Inputs are validated narrowly: these endpoints are reachable from any page
 * on the room network.
 */
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function mountRuntime(app: Express, runtime: Runtime, inputs?: Inputs) {
  if (inputs) app.get('/api/input/events', (_req, res) => inputs.subscribe(res))
  app.get('/api/runtime', (_req, res) => res.json(runtime.state()))

  // ---- the surface set (what is on the table) ----
  // Reachable from any page on the room network, so ids and deltas are
  // checked narrowly; unknown ids are a 404 rather than a silent no-op, so a
  // gesture aimed at a surface that just closed is visible in the logs.
  app.get('/api/surfaces', (_req, res) => res.json(runtime.surfaces.line()))
  app.post('/api/surfaces/:id/:op', (req, res) => {
    const { id, op } = req.params
    if (!SURFACE_ID.test(id)) return void res.status(400).json({ error: 'bad surface id' })
    if (!runtime.surfaces.list().some((s) => s.id === id)) return void res.status(404).json({ error: `no surface ${id}` })
    if (op === 'move') {
      const b = (req.body ?? {}) as { dx?: unknown; dy?: unknown }
      const dx = num(b.dx)
      const dy = num(b.dy)
      if (dx === null || dy === null || Math.abs(dx) > MAX_MOVE_PX || Math.abs(dy) > MAX_MOVE_PX) return void res.status(400).json({ error: 'expected { dx, dy } in surface px' })
      runtime.surfaces.move(id, { dx, dy })
    } else if (op === 'raise') runtime.surfaces.raise(id)
    else if (op === 'close') runtime.surfaces.close(id)
    else return void res.status(404).json({ error: 'op must be move, raise or close' })
    res.json(runtime.surfaces.line())
  })

  // ---- the swipe keyboard on the table (#29) ----
  app.get('/api/keyboard/input', (_req, res) => res.json(runtime.keyboardInput.state()))
  const selection = z.object({ mode: z.enum(['pointer', 'room-pinch', 'room-lidar']), token: z.string().min(1).max(100).optional() }).strict()
  app.post('/api/keyboard/input', (req, res) => {
    const p = selection.safeParse(req.body)
    if (!p.success) return void res.status(400).json({ error: 'expected pointer, room-pinch or room-lidar mode' })
    try { res.json(runtime.keyboardInput.select(p.data.mode, p.data.token)) }
    catch (e) { res.status(409).json({ error: e instanceof Error ? e.message : 'input selection failed' }) }
  })
  // Strokes arrive finished and in table px from whatever holds the pen (the
  // bench's mouse, the hand tracker). Checked as narrowly as the surface
  // routes: a stroke is a bounded list of finite points, nothing else, since
  // any page on the room network can post one.
  const MAX_STROKE_POINTS = 2000
  const MAX_COORD_PX = 100_000
  const point = (v: unknown) => {
    const p = v as { x?: unknown; y?: unknown } | null
    const x = num(p?.x)
    const y = num(p?.y)
    return x === null || y === null || Math.abs(x) > MAX_COORD_PX || Math.abs(y) > MAX_COORD_PX ? null : { x, y }
  }
  app.post('/api/keyboard/open', (req, res) => {
    const b = (req.body ?? {}) as { x?: unknown; y?: unknown }
    let at: { x: number; y: number } | undefined
    if (b.x !== undefined || b.y !== undefined) {
      const p = point(b)
      if (!p) return void res.status(400).json({ error: 'expected { x, y } in table px, or nothing for bottom-centre' })
      at = p
    }
    runtime.keyboard.open(at)
    res.json(runtime.surfaces.line())
  })
  app.post('/api/keyboard/close', (_req, res) => {
    runtime.keyboard.close()
    res.json(runtime.surfaces.line())
  })
  app.post('/api/keyboard/stroke', (req, res) => {
    if (!runtime.keyboardInput.acceptsPointer()) return void res.status(409).json({ error: 'room pinch owns keyboard input; select pointer mode first' })
    const body = (req.body ?? {}) as { points?: unknown; ask?: unknown }
    const raw = body.points
    if (body.ask !== undefined && typeof body.ask !== 'boolean') return void res.status(400).json({ error: 'ask must be true or false' })
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STROKE_POINTS) return void res.status(400).json({ error: `expected { points: [{ x, y }] }, 1-${MAX_STROKE_POINTS} points in table px` })
    const points = raw.map(point)
    if (points.some((p) => p === null)) return void res.status(400).json({ error: 'every point needs finite x and y in table px' })
    // A closed keyboard is a 409, not a silent no-op: a pen still typing at
    // a keyboard someone closed should show up in the bench, not vanish.
    if (!runtime.keyboard.state()) return void res.status(409).json({ error: 'the keyboard is not open' })
    const r = runtime.keyboard.stroke(points as { x: number; y: number }[], { ask: body.ask as boolean | undefined })
    res.json({ ...r, state: runtime.keyboard.state() })
  })

  app.post('/api/input/midi', (req, res) => {
    const b = req.body as { type?: unknown; note?: unknown; velocity?: unknown }
    const note = num(b.note)
    const velocity = num(b.velocity) ?? 0
    if ((b.type !== 'note-on' && b.type !== 'note-off') || note === null || note < 0 || note > 127)
      return void res.status(400).json({ error: 'expected { type: note-on|note-off, note: 0-127, velocity }' })
    inputs?.emit({ kind: 'midi', t: Date.now(), type: b.type, note, velocity })
    res.json({ result: runtime.midi({ type: b.type, note, velocity }), state: runtime.state() })
  })

  /**
   * A hand gesture from the camera tracker (apps/web/src/hands, #28). Any
   * page on the room network can post here, so the shape is a closed schema:
   * known gesture types only, finite coordinates in a sane range, and a
   * bounded stroke (a 10 s stroke at 30 fps is 300 points). It goes to the
   * input stream as-is, and to the runtime, which decides what it does
   * (the launcher today, #33; surface gestures, #32).
   */
  app.post('/api/input/gesture', (req, res) => {
    const parsed = GestureBody.safeParse(req.body)
    if (!parsed.success) return void res.status(400).json({ error: 'bad gesture', detail: parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) })
    if (!inputs) return void res.status(503).json({ error: 'no input stream' })
    inputs.emit({ kind: 'gesture', t: Date.now(), gesture: parsed.data })
    // The runtime acts on it (the launcher, #33); the stream is for watchers.
    res.status(202).json({ ok: true, taken: runtime.gesture(parsed.data) })
  })

  app.post('/api/lesson/start', (req, res) => {
    const song = runtime.startLesson(String((req.body as { song?: unknown }).song ?? ''))
    if (!song) return void res.status(404).json({ error: `unknown song; try ${Object.keys(SONGS).join(', ')}` })
    res.json(runtime.state())
  })
  app.post('/api/lesson/stop', (_req, res) => {
    runtime.stopLesson()
    res.json(runtime.state())
  })

  // ?record=1 keeps every camera frame of the run (.hubble/calibration-run/),
  // to turn a real run into test fixtures.
  app.post('/api/calibrate', async (req, res) => {
    const dir = '.hubble/calibration-run'
    const record = req.query.record === '1' ? (name: string, jpg: Uint8Array) => (mkdirSync(dir, { recursive: true }), writeFileSync(`${dir}/${name}.jpg`, jpg)) : undefined
    res.json(await runtime.calibrate({ record }))
  })
  // Reference points (#91): { on: true } projects the marker grid for a few
  // seconds (409 unarmed on the real room: a projector write needs the
  // owner's go); { on: false } clears it. ?record=1 keeps the room camera's
  // frames of the run (.hubble/reference-run/), the recordings the next
  // hardware window should take.
  app.post('/api/spatial/reference', (req, res) => {
    const on = (req.body as { on?: unknown } | undefined)?.on
    if (typeof on !== 'boolean') return void res.status(400).json({ error: 'on must be true or false' })
    const dir = '.hubble/reference-run'
    const record = req.query.record === '1' ? (name: string, jpg: Uint8Array) => (mkdirSync(dir, { recursive: true }), writeFileSync(`${dir}/${name}.jpg`, jpg)) : undefined
    const r = runtime.reference(on, { record })
    res.status(r.ok ? 200 : 409).json(r)
  })
  app.get('/api/spatial/reference', (_req, res) => res.json(runtime.referenceState()))
  // The lidar registration wizard (#107), under /wizard since Truls's #112
  // took /registration/run and /capture (merge, 7 Oct); scripts/lidar-live.ts drives it. capture: one target, the
  // finger's lidar Cartesian centroid back (or why not, 409). run: all six
  // targets, the fit and the install; answers when finished (≤ ~90 s), so
  // progress is read from GET .../run meanwhile.
  app.post('/api/spatial/registration/wizard/capture', async (req, res) => {
    const t = (req.body as { targetPx?: { x?: unknown; y?: unknown } } | undefined)?.targetPx
    if (!t || typeof t.x !== 'number' || typeof t.y !== 'number' || !Number.isFinite(t.x) || !Number.isFinite(t.y) || t.x < 0 || t.y < 0 || t.x > 4000 || t.y > 4000)
      return void res.status(400).json({ error: 'targetPx must be {x, y} in projector px' })
    const r = await runtime.lidarRegistration.capture({ x: t.x, y: t.y })
    res.status(r.ok ? 200 : 409).json(r)
  })
  app.post('/api/spatial/registration/wizard', async (_req, res) => {
    const r = await runtime.lidarRegistration.run()
    res.status(r.phase === 'done' ? 200 : 409).json(r)
  })
  app.get('/api/spatial/registration/wizard', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(runtime.lidarRegistration.state())
  })
  app.delete('/api/spatial/registration/wizard', (_req, res) => {
    runtime.lidarRegistration.end()
    res.json(runtime.lidarRegistration.state())
  })
  // The lidar registration run (#89 T4, docs/plans/2026-10-07-lidar-web.md):
  // the /spatial page's two buttons. The run itself (targets, captures, fit)
  // is the runtime's; this only starts, cancels and reports it.
  app.get('/api/spatial/registration/run', (_req, res) => res.json(runtime.registration.state()))
  app.post('/api/spatial/registration/run', (req, res) => {
    const action = (req.body as { action?: unknown } | undefined)?.action
    if (action === 'start') {
      const r = runtime.registration.start()
      return void res.status(r.ok ? 200 : 409).json(r)
    }
    if (action === 'cancel') return void res.json({ ok: true, state: runtime.registration.cancel() })
    res.status(400).json({ error: 'expected { action: start | cancel }' })
  })
  app.post('/api/calibrate/dot', (req, res) => {
    const b = req.body as { x?: unknown; y?: unknown }
    const at = typeof b.x === 'number' && typeof b.y === 'number' ? { x: b.x, y: b.y } : null
    runtime.testDot(at)
    res.json({ ok: true, at })
  })
  app.get('/api/calibration', (_req, res) => res.json({ calibrated: runtime.calibrated(), source: runtime.calibrationSource(), ...runtime.calibration() }))
  app.get('/api/scene/seen', async (_req, res) => res.json({ calibrated: runtime.calibrated(), objects: await runtime.look().catch(() => runtime.seen()) }))

  app.post('/api/lesson/keybed', (req, res) => {
    const b = req.body as { corners?: unknown; lowestNote?: unknown }
    const corners = Array.isArray(b.corners) ? b.corners.map((p) => ({ x: num((p as { x?: unknown })?.x), y: num((p as { y?: unknown })?.y) })) : []
    if (corners.length !== 4 || corners.some((p) => p.x === null || p.y === null)) return void res.status(400).json({ error: 'expected 4 corner points' })
    runtime.setKeybed({ corners: corners as never, lowestNote: num(b.lowestNote) ?? MINILAB3.defaultLowest })
    res.json(runtime.state())
  })
}

const Coord = z.number().finite().min(-10_000).max(10_000)
const Point = z.object({ x: Coord, y: Coord }).strict()
const Region = z.enum(['keys', 'candidates', 'surface', 'none'])
const GestureBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pen-down'), p: Point, region: Region }).strict(),
  z.object({ type: z.literal('pen-move'), p: Point }).strict(),
  z.object({ type: z.literal('stroke'), region: Region, points: z.array(Point).min(1).max(2000), cancelled: z.boolean() }).strict(),
  z.object({ type: z.literal('tap'), p: Point, region: Region }).strict(),
  z.object({ type: z.literal('drag-start'), p: Point }).strict(),
  z.object({ type: z.literal('drag-move'), p: Point }).strict(),
  z.object({ type: z.literal('drag-end'), p: Point, flick: z.boolean(), cancelled: z.boolean() }).strict(),
  // p: where the palm was (#33); optional, so a tracker without it still wakes.
  z.object({ type: z.literal('wake'), p: Point.optional() }).strict(),
])
