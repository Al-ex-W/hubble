import type { LidarFrame } from '@hubble/room'

/**
 * What the empty table looks like to the lidar, and which returns in a new
 * rotation are something that wasn't there (#89, plan Design: Baseline).
 *
 * Why a per-angle baseline and not a height threshold: the C1 has no height.
 * It sees one plane, 30–67 mm above the table (research: 0–1.5° pitch), and
 * everything the plane hits that isn't a finger (the room beyond the table, TV
 * stands, the MiniLab, the cloth where a tilted beam dips into it) has to be
 * learned, per angle, from a few seconds with hands clear.
 *
 * Pure: frames in, decisions out. The spatial service owns WHEN a baseline is
 * built (an explicit operator action, hands clear) and which one is current.
 */

/** The C1's nominal angular step (datasheet). Real steps are 0.54–0.86° (research census), so bins are approximate. */
export const BIN_DEG = 0.72
export const BINS = Math.round(360 / BIN_DEG)
/**
 * Bin index for an angle in degrees. A non-finite angle (a corrupt wire
 * return, a bad decoder) must never produce NaN: `per[NaN]` is undefined and
 * `bins[NaN]` is undefined, so buildBaseline and foreground both throw a
 * TypeError, and Express 4 does not catch an async rejection — the baseline
 * request hangs forever. Clamp a non-finite angle to bin 0; the distance
 * checks already drop a garbage return before it matters.
 */
export const binOf = (angle: number) => {
  if (!Number.isFinite(angle)) return 0
  return ((Math.floor(angle / BIN_DEG) % BINS) + BINS) % BINS
}

export interface BaselineBin {
  /** Share of rotations with a positive return in this bin, 0–1. */
  coverage: number
  /** Median range of those returns, mm; 0 when never covered. */
  medianMm: number
  /** Robust spread (1.4826 · MAD), mm: the range noise actually seen here. */
  noiseMm: number
}

export interface Baseline {
  /** The socket session it was learned on. A new session may be a re-mounted lidar: the caller decides whether to keep it. */
  sourceSession: string
  rotations: number
  bins: BaselineBin[]
}

export interface ForegroundOptions {
  /** Minimum closer-than-baseline distance, mm. */
  marginMm: number
  /** ...or this many times the bin's own noise, whichever is larger. */
  noiseK: number
  /** Below this coverage a bin is "open" (the beam sees nothing there): any return in it is new. */
  minCoverage: number
}

/**
 * PROVISIONAL until the on-site empty takes (R1/R2) are recorded; then fitted
 * so those takes give zero candidates, and the corpus hash goes beside them.
 * - marginMm 25: the wire take's static returns at 1.2 m vary only 3–6 mm
 *   (research census), far below the ±30 mm datasheet figure the old 60 mm
 *   margin in packages/room/src/lidar.ts was sized for. A finger lying flat is
 *   ~15 mm thick; a fingertip in front of a far wall is metres closer. 25 mm
 *   keeps a 4× margin over the measured noise without hiding a finger in front
 *   of something close behind it.
 * - noiseK 4: a bin that is genuinely noisy (an edge, a shiny surface) gets a
 *   wider margin from its own measurement instead of a global constant.
 * - minCoverage 0.5: a bin hit in fewer than half the empty rotations is
 *   mostly open; treat it as open rather than trusting a median of a few hits.
 */
export const DEFAULT_FOREGROUND: ForegroundOptions = { marginMm: 25, noiseK: 4, minCoverage: 0.5 }

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

/**
 * At least 30 rotations (3 s at 10 Hz): fewer, and one person walking past
 * behind the table during the capture moves a bin's median. All from one
 * socket session: a reconnect mid-capture could be a moved lidar.
 */
export function buildBaseline(frames: LidarFrame[], minRotations = 30): { ok: true; baseline: Baseline } | { ok: false; reason: string } {
  if (frames.length < minRotations) return { ok: false, reason: `only ${frames.length} rotations; need ${minRotations} with hands clear` }
  // A zero-frame call slips past the line above only when the caller passed
  // minRotations 0 (tests, a future caller), and `frames[0].sourceSession`
  // would then throw. Refuse an empty capture by name instead.
  if (frames.length === 0) return { ok: false, reason: 'no rotations in the capture' }
  const session = frames[0].sourceSession
  if (frames.some((f) => f.sourceSession !== session)) return { ok: false, reason: 'the lidar reconnected during the capture; capture again' }
  const per: number[][] = Array.from({ length: BINS }, () => [])
  const hit: number[] = new Array(BINS).fill(0)
  for (const f of frames) {
    // Coverage counts rotations, not returns: two returns landing in one bin
    // in the same rotation (steps < 0.72°) must not count as two rotations.
    const seen = new Set<number>()
    for (const p of f.points) {
      // A non-finite angle would otherwise bin to NaN (see binOf); skip it so a
      // corrupt return contributes nothing rather than crashing the capture.
      if (!(p.distance > 0) || !Number.isFinite(p.angle)) continue
      const b = binOf(p.angle)
      per[b].push(p.distance)
      seen.add(b)
    }
    for (const b of seen) hit[b]++
  }
  const bins = per.map((v, i): BaselineBin => {
    const m = median(v)
    return { coverage: hit[i] / frames.length, medianMm: m, noiseMm: v.length ? 1.4826 * median(v.map((d) => Math.abs(d - m))) : 0 }
  })
  return { ok: true, baseline: { sourceSession: session, rotations: frames.length, bins } }
}

export interface Return {
  angle: number
  distance: number
  quality: number
}

/**
 * The returns in this rotation that weren't there when the table was empty.
 *
 * Each return is compared with its own bin AND both neighbours, and must be
 * closer than all of the covered ones. Why: at a depth edge (the MiniLab's side
 * against the far wall) the real angles jitter 0.54–0.86° around the nominal
 * 0.72° bins, so a return that hits the near object can land in the far
 * neighbour's bin and look 2 m "closer than the baseline" every few rotations:
 * a phantom touch flickering on the object's edge. Requiring it to be closer
 * than the nearest of the three is what the neighbour check buys.
 *
 * Open bins (coverage below minCoverage, where the empty beam saw nothing) let
 * any return through; the caller's table polygon decides whether it matters.
 * That is what keeps a person beyond the table (open bins toward the room)
 * from being a touch: they are outside the polygon, not "in the baseline".
 */
export function foreground(points: Return[], baseline: Baseline, o: ForegroundOptions = DEFAULT_FOREGROUND): Return[] {
  const out: Return[] = []
  for (const p of points) {
    // A NaN angle bins to NaN and `baseline.bins[NaN]` is undefined, so this
    // loop threw on a corrupt rotation (see binOf). Skip it: a bad return is
    // not a touch.
    if (!(p.distance > 0) || !Number.isFinite(p.angle)) continue
    const b = binOf(p.angle)
    let nearest = Infinity
    let noise = 0
    let open = true
    for (const n of [b - 1, b, b + 1]) {
      const bin = baseline.bins[(n + BINS) % BINS]
      if (bin.coverage < o.minCoverage) continue
      open = false
      nearest = Math.min(nearest, bin.medianMm)
      noise = Math.max(noise, bin.noiseMm)
    }
    if (open || p.distance < nearest - Math.max(o.marginMm, o.noiseK * noise)) out.push(p)
  }
  return out
}
