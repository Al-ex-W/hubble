import { apply, residual, solveHomography, type H, type Pair } from '@hubble/room'
export interface Point {
  x: number
  y: number
}

/** Homographies are scale invariant; normalize before checking singularity.
 * A singular fit can have NaN residual (which also passes `rms > limit`). Never
 * let that become a calibration just because an error comparison was false. */
export function validTransform(h: H): boolean {
  if (h.length !== 9 || h.some((v) => !Number.isFinite(v))) return false
  const scale = Math.max(...h.map(Math.abs))
  if (!scale) return false
  const [a, b, c, d, e, f, g, i, j] = h.map((v) => v / scale)
  return Math.abs(a * (e * j - f * i) - b * (d * j - f * g) + c * (d * i - e * g)) > 1e-14
}
export function inverse(h: H): H | null {
  if (!validTransform(h)) return null
  const [a, b, c, d, e, f, g, i, j] = h
  const det = a * (e * j - f * i) - b * (d * j - f * g) + c * (d * i - e * g)
  return [e * j - f * i, c * i - b * j, b * f - c * e, f * g - d * j, a * j - c * g, c * d - a * f, d * i - e * g, b * g - a * i, a * e - b * d].map((v) => v / det)
}
export function map(h: H | null, p: Point): Point | null {
  if (!h || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
  const q = apply(h, p)
  return Number.isFinite(q.x) && Number.isFinite(q.y) && Math.abs(q.x) < 1e7 && Math.abs(q.y) < 1e7 ? q : null
}
export function fit(pairs: Pair[], heldOut: Pair[], maxError: number) {
  if (!Number.isFinite(maxError) || maxError <= 0) throw new Error('Tolerance must be finite and positive')
  const all = [...pairs, ...heldOut]
  if (all.some((p) => !p || !p.from || !p.to || ![p.from.x, p.from.y, p.to.x, p.to.y].every(Number.isFinite))) throw new Error('Targets must be finite')
  if (new Set(all.map((p) => `${p.from.x},${p.from.y}`)).size !== all.length) throw new Error('Check targets must be distinct from fit targets')
  if (pairs.length < 4 || heldOut.length < 2) throw new Error('Need four fit targets and two independent check targets')
  const h = solveHomography(pairs)
  if (!validTransform(h)) throw new Error('Targets do not define an invertible plane mapping')
  const rms = residual(h, heldOut)
  if (!Number.isFinite(rms) || rms > maxError) throw new Error('Independent target error exceeds the declared tolerance')
  return { h, rms }
}
