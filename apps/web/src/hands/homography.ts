import type { Pt } from './types.ts'

/**
 * Plane-to-plane maps. The printed keyboard (and the table) is flat, so camera
 * pixels and keyboard millimetres are related by one 3x3 homography, whatever
 * the camera's tilt: four tapped corners are enough to get it.
 *
 * Its own copy rather than packages/room's calibrate.ts: that package's index
 * also pulls in the room's Node transports (ws, sockets), which the browser
 * bundle must not import; this is the exact 4-point solve the lab proved.
 */

export type H = number[] // row-major 3x3

/** The homography taking each src[i] to dst[i] (exactly 4 pairs, DLT with h33 = 1). */
export function fromPoints(src: Pt[], dst: Pt[]): H {
  if (src.length !== 4 || dst.length !== 4) throw new Error('homography needs exactly 4 point pairs')
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!
    const { x: u, y: v } = dst[i]!
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    b.push(u)
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    b.push(v)
  }
  const h = solve(A, b)
  return [...h, 1]
}

export function apply(m: H, p: Pt): Pt {
  const w = m[6]! * p.x + m[7]! * p.y + m[8]!
  return { x: (m[0]! * p.x + m[1]! * p.y + m[2]!) / w, y: (m[3]! * p.x + m[4]! * p.y + m[5]!) / w }
}

export function invert(m: H): H {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number]
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) throw new Error('degenerate homography (are three calibration points in a line?)')
  const r = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d]
  return r.map((v) => v / det)
}

/** Gaussian elimination with partial pivoting; 8x8 is all we ever solve. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]!])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r
    if (Math.abs(M[piv]![col]!) < 1e-12) throw new Error('degenerate calibration points')
    ;[M[col], M[piv]] = [M[piv]!, M[col]!]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const k = M[r]![col]! / M[col]![col]!
      for (let c = col; c <= n; c++) M[r]![c]! -= k * M[col]![c]!
    }
  }
  return M.map((row, i) => row[n]! / row[i]!)
}
