import { describe, expect, it } from 'vitest'
import jpeg from 'jpeg-js'
import { brightBlobs, decode, rectCorners } from './camera.ts'

/**
 * Label: synthetic frames (black cloth, bright shapes, JPEG-compressed with
 * noise like the MX Brio stream) until the room's camera is recorded on
 * Tuesday; then these get recorded frames of the real dots, page and MiniLab.
 */
function frame(w: number, h: number, paint: (x: number, y: number) => number): Uint8Array {
  const data = Buffer.alloc(w * h * 4)
  let s = 9
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      const v = Math.max(0, Math.min(255, paint(x, y) + ((s % 17) - 8)))
      const i = (y * w + x) * 4
      data[i] = data[i + 1] = data[i + 2] = v
      data[i + 3] = 255
    }
  return new Uint8Array(jpeg.encode({ width: w, height: h, data }, 80).data)
}

describe('brightBlobs', () => {
  it('finds projected calibration dots at sub-pixel centres', () => {
    const dots = [
      [60, 40],
      [260, 45],
      [255, 150],
      [70, 160],
    ]
    const img = frame(320, 200, (x, y) => (dots.some(([dx, dy]) => (x - dx) ** 2 + (y - dy) ** 2 < 16) ? 240 : 18))
    const found = brightBlobs(decode(img)).filter((b) => b.area < 200)
    expect(found.length).toBe(4)
    for (const [dx, dy] of dots) expect(found.some((b) => Math.hypot(b.cx - dx, b.cy - dy) < 1.2)).toBe(true)
  })

  it('recovers a rotated white rectangle (a notebook or the MiniLab) as four corners', () => {
    const cx = 160
    const cy = 100
    const a = 0.3
    const inside = (x: number, y: number) => {
      const u = (x - cx) * Math.cos(a) + (y - cy) * Math.sin(a)
      const v = -(x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)
      return Math.abs(u) < 80 && Math.abs(v) < 30
    }
    const b = brightBlobs(decode(frame(320, 200, (x, y) => (inside(x, y) ? 230 : 15))))[0]
    expect(Math.abs(b.angle - a)).toBeLessThan(0.03)
    expect(Math.abs(b.halfLong - 80)).toBeLessThan(3)
    expect(Math.abs(b.halfShort - 30)).toBeLessThan(3)
    expect(rectCorners(b)).toHaveLength(4)
  })
})
