import jpeg from 'jpeg-js'

/**
 * What the overhead camera can tell us without a model: bright things on a
 * black cloth. That covers calibration dots (projected at known pixels), a
 * notebook page, and the white MiniLab 3, which is everything the demo needs.
 * The camera's exposure is locked by the room, so a fixed threshold relative
 * to the frame's own brightness is stable all day.
 *
 * Pure JavaScript (jpeg-js plus connected components) rather than OpenCV:
 * these are a few simple shapes, and avoiding an 8 MB WASM build or a native
 * module keeps the laptop setup to `npm install`.
 */
export interface Gray {
  width: number
  height: number
  data: Uint8Array
}

export function decode(jpegBytes: Uint8Array): Gray {
  const img = jpeg.decode(jpegBytes, { useTArray: true, formatAsRGBA: true })
  const data = new Uint8Array(img.width * img.height)
  for (let i = 0; i < data.length; i++) data[i] = (img.data[i * 4] * 77 + img.data[i * 4 + 1] * 150 + img.data[i * 4 + 2] * 29) >> 8
  return { width: img.width, height: img.height, data }
}

export interface Blob {
  /** Pixel count. */
  area: number
  cx: number
  cy: number
  /** Axis-aligned bounds. */
  x0: number
  y0: number
  x1: number
  y1: number
  /** Orientation of the long axis, radians, and the half-lengths along/across it (from second moments). */
  angle: number
  halfLong: number
  halfShort: number
}

/** Connected bright regions (4-connectivity), largest first. */
export function brightBlobs(g: Gray, opts: { threshold?: number; minArea?: number } = {}): Blob[] {
  // Default threshold: well above the cloth. Mean + a margin adapts to how
  // bright the projector leaves the table, which the locked exposure fixes.
  let sum = 0
  for (const v of g.data) sum += v
  const thr = opts.threshold ?? Math.min(250, sum / g.data.length + 60)
  const minArea = opts.minArea ?? 12
  const seen = new Uint8Array(g.data.length)
  const out: Blob[] = []
  const stack: number[] = []
  for (let start = 0; start < g.data.length; start++) {
    if (seen[start] || g.data[start] < thr) continue
    let area = 0
    let sx = 0
    let sy = 0
    let sxx = 0
    let syy = 0
    let sxy = 0
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -1
    let y1 = -1
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()!
      const x = i % g.width
      const y = (i - x) / g.width
      area++
      sx += x
      sy += y
      sxx += x * x
      syy += y * y
      sxy += x * y
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
      for (const n of [i - 1, i + 1, i - g.width, i + g.width]) {
        if (n < 0 || n >= g.data.length || seen[n] || g.data[n] < thr) continue
        if ((n === i - 1 && x === 0) || (n === i + 1 && x === g.width - 1)) continue
        seen[n] = 1
        stack.push(n)
      }
    }
    if (area < minArea) continue
    const cx = sx / area
    const cy = sy / area
    const vxx = sxx / area - cx * cx
    const vyy = syy / area - cy * cy
    const vxy = sxy / area - cx * cy
    // Principal axes of the region; for a filled rectangle the half-length
    // along an axis is sqrt(3 * variance) along it.
    const tr = vxx + vyy
    const det = vxx * vyy - vxy * vxy
    const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det))
    const l2 = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det))
    out.push({ area, cx, cy, x0, y0, x1, y1, angle: 0.5 * Math.atan2(2 * vxy, vxx - vyy), halfLong: Math.sqrt(3 * l1), halfShort: Math.sqrt(3 * Math.max(0, l2)) })
  }
  return out.sort((a, b) => b.area - a.area)
}

/** The four corners of a blob treated as a rotated rectangle (long axis first). */
export function rectCorners(b: Blob): { x: number; y: number }[] {
  const ux = Math.cos(b.angle)
  const uy = Math.sin(b.angle)
  const vx = -uy
  const vy = ux
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, c]) => ({ x: b.cx + a * b.halfLong * ux + c * b.halfShort * vx, y: b.cy + a * b.halfLong * uy + c * b.halfShort * vy }))
}
