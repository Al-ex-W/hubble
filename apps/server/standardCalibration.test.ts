import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply } from '@hubble/room'
import { DEFAULT_SURFACE } from '@hubble/stage'
import { runCalibration, type Dot } from './calibration.ts'
import { readCalibrationFile, resolveCalibration, STANDARD_CALIBRATION_FILE } from './standardCalibration.ts'
import { createSpatialService } from './spatial/service.ts'
import { createRuntime } from './runtime.ts'

/**
 * The standard-calibration fallback (#85): the room must boot calibrated even
 * when the gitignored `.hubble/calibration.json` is lost (as it was on 7 Oct,
 * with a deleted worktree), without a live recalibration that needs the
 * projector showing our page.
 *
 * Fixtures: `fixtures/calibration-2026-10-07/` (label: recording) is the good
 * room run; `apps/server/calibration.standard.json` is derived from it by
 * `npm run calibration:standard`. Oracles are independent of the fallback
 * code: a fresh `runCalibration` refit, the recorded page origin H28 measured
 * by hand, and the map read back out of the spatial service, never the
 * runtime's own helper.
 */
const DIR = new URL('./fixtures/calibration-2026-10-07/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')) as {
  dots: Dot[]
  frames: string[]
  pagePx: { width: number; height: number }
}
const standard = readCalibrationFile(STANDARD_CALIBRATION_FILE)!

/** Replay the recording through the real fitter; `settleMs: 0` because the frames are already captured. */
async function refitRecording() {
  const queue = manifest.frames.map((name) => new Uint8Array(readFileSync(new URL(`${name}.jpg`, DIR))))
  return runCalibration({ frame: async () => queue.shift()!, overlay: () => {}, dots: manifest.dots, settleMs: 0 })
}

/** Left-multiply by a destination-frame translation, the page-origin correction (finding 1). */
function translate(h: number[], tx: number, ty: number): number[] {
  return [h[0]! + tx * h[6]!, h[1]! + tx * h[7]!, h[2]! + tx * h[8]!, h[3]! + ty * h[6]!, h[4]! + ty * h[7]!, h[5]! + ty * h[8]!, h[6]!, h[7]!, h[8]!]
}

/** A temp calibration path that does not exist, so the runtime falls back. */
function missingCalFile() {
  return join(mkdtempSync(join(tmpdir(), 'hubble-cal-missing-')), 'calibration.json')
}
/** A temp calibration file holding `body`, so the runtime reads it. */
function calFileWith(body: string) {
  const file = join(mkdtempSync(join(tmpdir(), 'hubble-cal-')), 'calibration.json')
  writeFileSync(file, body)
  return file
}
/** A runtime over its own spatial service, so the installed map can be read back. */
function runtimeAt(file: string, cameraFrame?: () => Promise<Uint8Array>, calibrationSettleMs?: number) {
  const spatial = createSpatialService({})
  const rt = createRuntime({ overlay: () => {}, autoTick: false, calibrationFile: file, spatial, cameraFrame, calibrationSettleMs })
  return { rt, spatial }
}

describe('the committed standard calibration', () => {
  it('is derived from the recording, recentred onto today’s page, and every matrix entry matches a fresh refit to 1e-6', async () => {
    const run = await refitRecording()
    expect(run.ok).toBe(true)
    expect(run.h).toHaveLength(9)
    // The recording's page (1080) sat centred on the 1200 projector, so the
    // refit must be slid down by half the difference — computed here from the
    // manifest and DEFAULT_SURFACE, the way the script does.
    const offset = { x: (DEFAULT_SURFACE.widthPx - manifest.pagePx.width) / 2, y: (DEFAULT_SURFACE.heightPx - manifest.pagePx.height) / 2 }
    const expected = translate(run.h!, offset.x, offset.y)
    // Break caught: a hand-edited file, the fitter changed without
    // regenerating, OR the page-origin shift dropped (finding 1) — a missing
    // 60 px here is ~48 mm of y error at the room's 0.81 mm/px. Explicit
    // absolute bound: the second toBeCloseTo argument is a DIGIT count, so
    // `toBeCloseTo(v, 1e-6)` would let a 0.001 change (553 px rms) pass
    // (finding 3).
    run.h!.forEach((_, i) => expect(Math.abs(standard.cameraToProjector[i]! - expected[i]!)).toBeLessThanOrEqual(1e-6))
    expect(standard.measuredAt).toBe('2026-10-07T06:20:00Z')
    expect(standard.cameraGeometry).toEqual(run.cameraGeometry)
    expect(standard.pageOffsetPx).toEqual(offset)
  })

  it('maps a recorded dot to its page position + 60 in y, within the fit’s rms', async () => {
    const run = await refitRecording()
    // Oracle, independent of the fallback: H28's
    // experiments/room-cli/keyboard_scheme_stats.py header says the 1920x1080
    // /table page sits centred on the 1920x1200 projector, y - 60. So a dot
    // recorded at page y must land at page y + 60 on today's page. Only the
    // dots the fit kept count; the two it dropped had their brightest change
    // elsewhere (the flicker frames) and would blow any bound up.
    const dropped = new Set(run.dropped!.map((d) => `${d.x},${d.y}`))
    const kept = run.dots.filter((d) => d.seen && !dropped.has(`${d.at.x},${d.at.y}`))
    expect(kept).toHaveLength(10) // corpus pin: 12 seen, 2 dropped
    // Break caught: the page-origin shift missing (every y is 60 low). The
    // y-only residual RMS is <= the full 2-D fit rms by construction, so
    // `rms` is the honest bound.
    const rmsY = Math.sqrt(kept.reduce((s, d) => s + (apply(standard.cameraToProjector, d.seen!).y - (d.at.y + 60)) ** 2, 0) / kept.length)
    expect(rmsY).toBeLessThanOrEqual(standard.rms!)
  })

  it('boots the runtime calibrated from the standard when the measured file is missing', () => {
    const { rt, spatial } = runtimeAt(missingCalFile())
    // Break caught: removing the fallback — the room then boots uncalibrated
    // after the measured file is lost, and the keyboard light/projection sit
    // on no map at all.
    expect(rt.calibrated()).toBe(true)
    expect(rt.calibrationSource()).toBe('standard')
    expect(rt.calibration()?.source).toBe('standard')
    // Oracle: the map installed in the spatial service is the standard's,
    // entry for entry.
    expect(spatial.calibration.cameraTransform()).toEqual(standard.cameraToProjector)
    expect(Math.abs(rt.calibration()!.rms! - standard.rms!)).toBeLessThanOrEqual(1e-6)
  })

  it('prefers a valid measured file and reports source measured', () => {
    const measured = { cameraToProjector: [1, 0, 5, 0, 1, 7, 0, 0, 1], cameraGeometry: { width: 1920, height: 1080 }, rms: 0.5, measuredAt: '2026-10-07T07:00:00Z', dots: [] }
    const { rt, spatial } = runtimeAt(calFileWith(JSON.stringify(measured)))
    // Break caught: swapping the precedence — the standard would shadow the
    // live measurement the operator just ran to fix the room.
    expect(rt.calibrationSource()).toBe('measured')
    expect(rt.calibration()?.at).toBe('2026-10-07T07:00:00Z')
    // Oracle: the installed map is the measured one, not the standard's.
    expect(spatial.calibration.cameraTransform()).toEqual(measured.cameraToProjector)
    expect(apply(spatial.calibration.cameraTransform()!, { x: 960, y: 540 })).toEqual(apply(measured.cameraToProjector, { x: 960, y: 540 }))
  })

  it('a live calibration flips the source to measured', async () => {
    // Start on the standard (no measured file), then run the real
    // calibration path over the recorded frames. The live measurement must
    // win the source, or the operator would keep reading "standard" after
    // fixing the room. Uses today's page dots; the recorded frame's uniform
    // offset is absorbed by the fit.
    const queue = manifest.frames.map((name) => new Uint8Array(readFileSync(new URL(`${name}.jpg`, DIR))))
    // settleMs 0: the recorded frames are already captured, so no kiosk wait.
    const { rt } = runtimeAt(missingCalFile(), async () => queue.shift()!, 0)
    expect(rt.calibrationSource()).toBe('standard')
    const run = await rt.calibrate()
    expect(run.ok).toBe(true)
    // Break caught: removing the live `calibrationSource = 'measured'` update
    // (finding 3) — the operator would still read the fallback after a fresh
    // run, and never trust the new map.
    expect(rt.calibrationSource()).toBe('measured')
    expect(rt.calibration()?.source).toBe('measured')
  })

  it('falls back to the standard when the measured file is corrupt, without crashing', () => {
    // A half-written file (the write died mid-run) must not throw out of boot.
    const { rt } = runtimeAt(calFileWith('{"cameraToProjector": [1, 2, 3'))
    // Break caught: JSON.parse throwing out of boot on a truncated cache.
    expect(rt.calibrated()).toBe(true)
    expect(rt.calibrationSource()).toBe('standard')

    // A valid-looking JSON with a singular homography (all-zero matrix) must
    // be refused too: installing it would light keys on NaN corners.
    const { rt: rt2, spatial: sp2 } = runtimeAt(calFileWith(JSON.stringify({ cameraToProjector: [0, 0, 0, 0, 0, 0, 0, 0, 1] })))
    // Break caught: installing a singular map and later producing NaN corners.
    expect(rt2.calibrationSource()).toBe('standard')
    expect(sp2.calibration.cameraTransform()).toEqual(standard.cameraToProjector)
  })

  it('falls back to the standard when a measured file has invalid camera geometry', () => {
    // setCamera throws on width/height <= 0 or non-integer, so a file that
    // parses and has a valid matrix but a zero/negative/fractional size must
    // be refused at read time, not crash the boot.
    const h = [1, 0, 5, 0, 1, 7, 0, 0, 1]
    for (const cameraGeometry of [{ width: 0, height: 1080 }, { width: -1920, height: 1080 }, { width: 1920.5, height: 1080 }, { width: 1920, height: 0.5 }]) {
      // Break caught: accepting a dimension setCamera rejects, then throwing
      // "Invalid camera registration" out of createRuntime (finding 2).
      const file = calFileWith(JSON.stringify({ cameraToProjector: h, cameraGeometry, measuredAt: '2026-10-07T07:00:00Z' }))
      expect(readCalibrationFile(file), `geometry ${JSON.stringify(cameraGeometry)}`).toBeNull()
      const { rt, spatial } = runtimeAt(file)
      expect(rt.calibrationSource(), `geometry ${JSON.stringify(cameraGeometry)}`).toBe('standard')
      expect(spatial.calibration.cameraTransform()).toEqual(standard.cameraToProjector)
    }
  })

  it('still accepts a legacy measured file with no cameraGeometry', () => {
    // The on-site file written before geometry was recorded must keep working;
    // it defaults to full-frame 1080p, not to the standard.
    const file = calFileWith(JSON.stringify({ cameraToProjector: [1, 0, 5, 0, 1, 7, 0, 0, 1] }))
    // Break caught: rejecting a geometry-less legacy file and silently
    // replacing the operator's live map with the standard.
    expect(resolveCalibration(file)?.source).toBe('measured')
  })
})
