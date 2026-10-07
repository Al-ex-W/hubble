import { readFileSync } from 'node:fs'
import express from 'express'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { beforeAll, describe, expect, it } from 'vitest'
import { runCalibration, type Dot } from '../calibration.ts'
import { createCalibration } from './calibration.ts'
import { keyboardRoi } from './cameraRoi.ts'
import { createSpatialService } from './service.ts'
import { mountSpatial } from './routes.ts'
import { cropPixels } from '../../shared/hands/roi.ts'
import type { H } from '@hubble/room'

/**
 * The camera crop for the open keyboard (#84).
 *
 * Fixture: fixtures/calibration-2026-10-07/, a RECORDING of the real room's
 * calibration run (each projected dot and the camera frame that saw it).
 * Oracles, independent of the crop code:
 *   - the camera positions at which the fixture's own dots were SEEN: a
 *     keyboard box around some dots must give a crop containing exactly
 *     those camera points;
 *   - the room fact recorded with the fixture: the camera sees the table
 *     rotated 180° (table top-left lands in the camera's bottom-right).
 */
const DIR = new URL('../fixtures/calibration-2026-10-07/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')) as { dots: Dot[]; frames: string[] }
const FRAME = { width: 1920, height: 1080, geometry: 'room:full-frame' }
let h: H
let seen: { table: Dot; camera: { x: number; y: number } }[]

beforeAll(async () => {
  const q = manifest.frames.map((n) => new Uint8Array(readFileSync(new URL(`${n}.jpg`, DIR))))
  const r = await runCalibration({ frame: async () => q.shift()!, overlay: () => {}, dots: manifest.dots, settleMs: 0 })
  expect(r.ok).toBe(true)
  h = r.h!
  // The run's own outliers (two frames whose brightest change was a flicker,
  // not the dot) are not evidence of where a dot is; leave them out.
  const dropped = (r.dropped ?? []).map((d) => `${d.x},${d.y}`)
  seen = r.dots.filter((d) => d.seen && !dropped.includes(`${d.at.x},${d.at.y}`)).map((d) => ({ table: d.at, camera: d.seen! }))
})

const cal = () => {
  const c = createCalibration()
  c.setCamera({ h, ...FRAME })
  return c
}
const inside = (p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

describe('the keyboard crop, on the recorded room calibration', () => {
  it('contains the camera points of the fixture dots under the keyboard box', () => {
    // Break caught: a crop computed with the forward map (camera->projector)
    // instead of its inverse, or from two corners only: the crop then misses
    // the keyboard, MediaPipe sees no hand, and typing silently stops.
    const box = { x: 650, y: 480, w: 620, h: 120 } // around the dots at y=540, x=704 and x=1216
    const r = keyboardRoi(box, cal().projectorToCamera, cal().cameraFrame())!
    expect(r).not.toBeNull()
    const under = seen.filter((s) => inside(s.table, box))
    expect(under.length).toBeGreaterThanOrEqual(2)
    for (const s of under) expect(inside(s.camera, r.crop), JSON.stringify(s)).toBe(true)
    // And it is a crop, not the full frame: the point of the whole change.
    expect(r.crop.w * r.crop.h).toBeLessThan(0.5 * 1920 * 1080)
  })

  // A box whose four corners ARE fixture dots (x 704..1216, y 108..540), so
  // the oracle for each corner is where the camera really saw that dot.
  const onDots = { x: 704, y: 108, w: 512, h: 432 }
  const cornerSeen = () => seen.filter((s) => (s.table.x === 704 || s.table.x === 1216) && (s.table.y === 108 || s.table.y === 540)).map((s) => s.camera)

  it('bounds all four corners of the keyboard, not two (the camera is tilted)', () => {
    // Break caught: bounding only two opposite corners. Under the room's
    // perspective the other two land outside that box, and the crop cuts off
    // a corner of the keyboard. Margin 0, so only the corner mapping is tested.
    const r = keyboardRoi(onDots, cal().projectorToCamera, cal().cameraFrame(), 0)!
    const pts = cornerSeen()
    expect(pts.length).toBe(4)
    for (const p of pts) expect(inside(p, r.crop), JSON.stringify(p)).toBe(true)
  })

  it('leaves room around the keyboard for the hand (the default margin)', () => {
    // Break caught: a crop tight to the keys. The wrist of a hand pinching
    // over the top row is outside it, and MediaPipe loses the hand. The
    // default must reach at least 10 % of the keyboard's camera span past
    // its seen corners on every side.
    const r = keyboardRoi(onDots, cal().projectorToCamera, cal().cameraFrame())!
    const pts = cornerSeen()
    const [x0, x1] = [Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x))]
    const [y0, y1] = [Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y))]
    expect(r.crop.x).toBeLessThanOrEqual(x0 - 0.1 * (x1 - x0))
    expect(r.crop.y).toBeLessThanOrEqual(y0 - 0.1 * (y1 - y0))
    expect(r.crop.x + r.crop.w).toBeGreaterThanOrEqual(Math.min(1920, x1 + 0.1 * (x1 - x0)))
    expect(r.crop.y + r.crop.h).toBeGreaterThanOrEqual(Math.min(1080, y1 + 0.1 * (y1 - y0)))
  })

  it('lands a table-top-left keyboard in the camera bottom-right (the 180° mount)', () => {
    // Break caught: an extra flip (or a missing one) in the crop: the stream
    // would show the opposite corner of the table.
    const r = keyboardRoi({ x: 100, y: 60, w: 300, h: 120 }, cal().projectorToCamera, cal().cameraFrame())!
    expect(r.crop.x + r.crop.w / 2).toBeGreaterThan(1920 / 2)
    expect(r.crop.y + r.crop.h / 2).toBeGreaterThan(1080 / 2)
  })

  it('reports the snapped crop the Pi will send, for exactly the fractions requested', () => {
    // Break caught: the browser told a rectangle other than the one the Pi
    // crops for these fractions (landmarks then offset by up to 15 px).
    const r = keyboardRoi({ x: 650, y: 480, w: 620, h: 120 }, cal().projectorToCamera, cal().cameraFrame())!
    expect(r.crop).toEqual(cropPixels(r.roi, 1920, 1080))
    expect(r.crop.x % 16).toBe(0)
    expect(r.crop.y % 16).toBe(0)
    expect(r.frame).toEqual(FRAME)
  })

  it('streams the full frame without a keyboard or without a calibration', () => {
    // Break caught: an empty or stale crop request when there is nothing to
    // crop to; the Pi answers it with an error and the tracker sees nothing.
    expect(keyboardRoi(null, cal().projectorToCamera, cal().cameraFrame())).toBeNull()
    const none = createCalibration()
    expect(keyboardRoi({ x: 650, y: 480, w: 620, h: 120 }, none.projectorToCamera, none.cameraFrame())).toBeNull()
  })
})

describe('GET /api/camera/roi', () => {
  it('answers the open keyboard crop from the spatial service, and null without one', async () => {
    // Break caught: the route computing its own answer (a second owner) or
    // not following the live surface set.
    const spatial = createSpatialService()
    spatial.calibration.setCamera({ h, ...FRAME })
    let list: { id: string; kind: string; instance: number; box: { x: number; y: number; w: number; h: number }; z: number }[] = []
    spatial.followSurfaces({ list: () => list as never, bounds: () => ({ widthPx: 1920, heightPx: 1080, mmPerPx: 0.8 }) as never, subscribe: () => () => {} })
    const app = express()
    mountSpatial(app, spatial)
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      expect(await (await fetch(`${base}/api/camera/roi`)).json()).toEqual({ roi: null })
      list = [{ id: 'keyboard', kind: 'keyboard', instance: 1, box: { x: 650, y: 480, w: 620, h: 120 }, z: 1 }]
      const body = (await (await fetch(`${base}/api/camera/roi`)).json()) as { roi: unknown; crop: { w: number } }
      expect(body.roi).not.toBeNull()
      expect(body.crop.w).toBeLessThan(1920)
    } finally {
      server.close()
      spatial.stop()
    }
  })
})
