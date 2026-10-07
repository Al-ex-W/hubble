import { describe, expect, it } from 'vitest'
import jpeg from 'jpeg-js'
import { apply, type H } from './calibrate.ts'
import { calibrateFromFrame, calibrationDots, MINILAB_BODY, observe } from './perceive.ts'

/**
 * Label: synthetic (a known camera→projector homography renders what the
 * camera would see). The solver must recover it from the dots; objects must
 * come out at their true table position and size. Re-checked on site against
 * recorded frames of the real projection, page and MiniLab.
 */
const W = 640
const Hh = 360
// projector→camera: the camera sees the 1920x1080 projection at a third of
// the size, slightly rotated and keystoned (beside the lens, not on its axis).
const P2C: H = [0.33, 0.012, 22, -0.01, 0.335, 14, 0.000004, 0.000002, 1]
const invert = (m: H): H => {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det)
}
const C2P = invert(P2C)

function render(lit: (px: { x: number; y: number }) => boolean): Uint8Array {
  const data = Buffer.alloc(W * Hh * 4)
  for (let y = 0; y < Hh; y++)
    for (let x = 0; x < W; x++) {
      const v = lit(apply(C2P, { x, y })) ? 235 : 16
      const i = (y * W + x) * 4
      data[i] = data[i + 1] = data[i + 2] = v
      data[i + 3] = 255
    }
  return new Uint8Array(jpeg.encode({ width: W, height: Hh, data }, 85).data)
}

describe('camera calibration from projected dots', () => {
  it('recovers the camera→projector mapping to within a few projector pixels', () => {
    const dots = calibrationDots(1920, 1080)
    const frame = render((p) => dots.some((d) => Math.hypot(p.x - d.x, p.y - d.y) < 18))
    const cal = calibrateFromFrame(frame, dots)!
    expect(cal).not.toBeNull()
    expect(cal.rms).toBeLessThan(3)
    const probe = apply(cal.h, apply(P2C, { x: 1500, y: 300 }))
    expect(Math.hypot(probe.x - 1500, probe.y - 300)).toBeLessThan(4)
  })
})

describe('observe', () => {
  const mmPerPx = 1500 / 1920
  it('finds a notebook and a MiniLab with a keybed on its near side', () => {
    const page = { x: 300, y: 380, w: 210 / mmPerPx, h: 297 / mmPerPx }
    const kb = { x: 900, y: 650, w: MINILAB_BODY.w / mmPerPx, h: MINILAB_BODY.h / mmPerPx }
    const inBox = (p: { x: number; y: number }, b: typeof page) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h
    const seen = observe(render((p) => inBox(p, page) || inBox(p, kb)), C2P, mmPerPx)
    const notebook = seen.find((s) => s.kind === 'notebook')!
    const keyboard = seen.find((s) => s.kind === 'keyboard')!
    expect(Math.abs(notebook.box.x - page.x)).toBeLessThan(10)
    expect(Math.abs(keyboard.box.w - kb.w)).toBeLessThan(14)
    // The keybed sits in the near (larger-y) part of the body.
    const kbNearY = Math.max(...keyboard.keybed!.corners.map((c) => c.y))
    expect(kbNearY).toBeGreaterThan(kb.y + kb.h * 0.85)
  })
})
