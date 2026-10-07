/**
 * Calibration solvers: camera px → projector px (homography from projected
 * markers found in the camera image), table mm → projector px (homography
 * from objects placed on projected dots). Run once on site and saved; the
 * camera, lidar and projector stay fixed all day (spec).
 *
 * Plain DLT with Hartley normalisation: the inputs are a handful of points
 * with ~1 px noise, which is exactly where unnormalised DLT goes unstable.
 */
export type H = number[] // 3x3 row-major
export interface Pair {
  from: { x: number; y: number }
  to: { x: number; y: number }
}

export function apply(h: H, p: { x: number; y: number }): { x: number; y: number } {
  const w = h[6] * p.x + h[7] * p.y + h[8]
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w }
}

function normaliser(pts: { x: number; y: number }[]): H {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  const d = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length || 1
  const k = Math.SQRT2 / d
  return [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1]
}

function mul(a: H, b: H): H {
  const r = new Array(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]
  return r
}

function invert(m: H): H {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det)
}

/** Least squares on the normal equations (8 unknowns, h33 = 1), Gaussian elimination. */
function solve8(rows: number[][], rhs: number[]): number[] {
  const n = 8
  const A = Array.from({ length: n }, () => new Array(n).fill(0))
  const y = new Array(n).fill(0)
  rows.forEach((r, k) => {
    for (let i = 0; i < n; i++) {
      y[i] += r[i] * rhs[k]
      for (let j = 0; j < n; j++) A[i][j] += r[i] * r[j]
    }
  })
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    ;[A[c], A[p]] = [A[p], A[c]]
    ;[y[c], y[p]] = [y[p], y[c]]
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c]
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k]
      y[r] -= f * y[c]
    }
  }
  const x = new Array(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = y[r]
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]
    x[r] = s / A[r][r]
  }
  return x
}

/** Needs ≥ 4 pairs, no three collinear. */
export function solveHomography(pairs: Pair[]): H {
  if (pairs.length < 4) throw new Error('a homography needs at least 4 point pairs')
  const Tf = normaliser(pairs.map((p) => p.from))
  const Tt = normaliser(pairs.map((p) => p.to))
  const rows: number[][] = []
  const rhs: number[] = []
  for (const { from, to } of pairs) {
    const a = apply(Tf, from)
    const b = apply(Tt, to)
    rows.push([a.x, a.y, 1, 0, 0, 0, -a.x * b.x, -a.y * b.x])
    rhs.push(b.x)
    rows.push([0, 0, 0, a.x, a.y, 1, -a.x * b.y, -a.y * b.y])
    rhs.push(b.y)
  }
  const h = [...solve8(rows, rhs), 1]
  const H = mul(invert(Tt), mul(h, Tf))
  return H.map((v) => v / H[8])
}

/** Root-mean-square reprojection error in target units: the number to show on the calibration page. */
export function residual(h: H, pairs: Pair[]): number {
  const s = pairs.reduce((acc, { from, to }) => {
    const p = apply(h, from)
    return acc + (p.x - to.x) ** 2 + (p.y - to.y) ** 2
  }, 0)
  return Math.sqrt(s / pairs.length)
}

export interface Calibration {
  /** Camera pixels → projector pixels. */
  cameraToProjector: H | null
  /** Table millimetres → projector pixels. */
  tableToProjector: H | null
  measuredAt: string | null
}
