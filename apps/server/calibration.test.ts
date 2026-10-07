import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apply, calibrateFromFrame, decode } from '@hubble/room'
import { fitDots, findDot, runCalibration, type Dot } from './calibration.ts'

/*
 * Fixture: fixtures/calibration-2026-10-07/, a RECORDING of a real boot
 * calibration in the room (pi-projector's Brio at 1080p, our /table page on the
 * projector, 06:20Z): one frame with no dot, then one frame per dot of the 4×3
 * grid. The oracles are independent of the code under test: the grid we drew
 * (manifest), and two facts read off the room by eye: the camera sees the
 * table rotated 180° (the organisers' test chart: projector (0,0) at the
 * camera's bottom-right), and two of the twelve frames had their brightest
 * change somewhere other than the dot (a flicker at the far left edge and one
 * at the top), which a calibration must survive.
 */
const DIR = new URL('./fixtures/calibration-2026-10-07/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')) as { dots: Dot[]; frames: string[] }
const jpeg = (name: string) => new Uint8Array(readFileSync(new URL(`${name}.jpg`, DIR)))

/** Replays the recorded frames in the order the run took them. */
function replay() {
  const queue = manifest.frames.map(jpeg)
  return { frame: async () => queue.shift()!, overlay: () => {} }
}

describe('camera ↔ projector calibration on a real room run', () => {
  it('has the recorded run', () => {
    expect(manifest.dots).toHaveLength(12) // corpus pin
    expect(manifest.frames).toHaveLength(13)
  })

  it('calibrates from the recorded frames, within 6 table px', async () => {
    const r = await runCalibration({ ...replay(), dots: manifest.dots, settleMs: 0 })
    // Break caught: a finder or fit that cannot calibrate the real room.
    expect(r.ok).toBe(true)
    expect(r.rms!).toBeLessThan(6)
  })

  it('drops the two frames whose brightest change was not the dot, and keeps the rest', async () => {
    const r = await runCalibration({ ...replay(), dots: manifest.dots, settleMs: 0 })
    // Break caught: a fit that averages a stray flicker into the map (the
    // keyboard's keys would then be off by tens of mm on that side).
    expect(r.dropped).toHaveLength(2)
    expect(r.dots.filter((d) => d.seen)).toHaveLength(12)
  })

  it('recovers the 180° rotation: table top-left is camera bottom-right', async () => {
    const r = await runCalibration({ ...replay(), dots: manifest.dots, settleMs: 0 })
    const first = r.dots[0]!.seen! // table (192,108), near the table's top-left
    // Break caught: a map that assumes the camera's orientation (the old
    // row/column pairing) and mirrors every key.
    expect(first.x).toBeGreaterThan(1920 * 0.75)
    expect(first.y).toBeGreaterThan(1080 * 0.75)
    const back = apply(r.h!, first)
    expect(Math.hypot(back.x - 192, back.y - 108)).toBeLessThan(10)
  })

  it('the old all-dots-at-once calibration cannot do this room', () => {
    // Every dot lit in one frame is not recorded, so this replays the old
    // code on the real no-dot frame: on a white table it finds no dot grid at
    // all. Kept as a record of why the module was rebuilt (7 Oct).
    expect(calibrateFromFrame(jpeg('off'), manifest.dots)).toBeNull()
  })

  it('finds nothing when the dot did not show', () => {
    const off = decode(jpeg('off'))
    // Break caught: noise between two identical scenes taken for a dot,
    // fitting a map to nothing (the frozen-kiosk runs earlier on 7 Oct).
    expect(findDot(off, off)).toBeNull()
  })

  it('refuses a degenerate fit (collinear or duplicate dots) instead of a NaN map', () => {
    // Break caught: four collinear camera points make the DLT singular, so
    // solveHomography returns an all-NaN matrix and residual is NaN. Before
    // this guard `rms > GOOD_RMS` was false for NaN, fitDots returned a NaN
    // fit, and runCalibration installed it: the map put every key nowhere and
    // setCamera threw out of /api/calibrate. Oracle: the returned fit is null
    // (not a matrix), and runCalibration reports ok:false.
    const collinear = [1, 2, 3, 4, 5].map((i) => ({ from: { x: i * 100, y: i * 100 }, to: { x: i * 192, y: i * 108 } }))
    expect(fitDots(collinear)).toBeNull()
    // Duplicated points are the same singularity by another route.
    const dup = [
      { from: { x: 100, y: 100 }, to: { x: 192, y: 108 } },
      { from: { x: 100, y: 100 }, to: { x: 192, y: 108 } },
      { from: { x: 900, y: 100 }, to: { x: 1728, y: 108 } },
      { from: { x: 900, y: 100 }, to: { x: 1728, y: 108 } },
    ]
    expect(fitDots(dup)).toBeNull()
  })
})
