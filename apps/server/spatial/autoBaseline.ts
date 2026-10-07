import type { LidarFrame } from '@hubble/room'
import { BINS, binOf } from './baseline.ts'

/**
 * WHEN the empty-table baseline is taken, automatically (demo boot, 7 Oct).
 *
 * WHY automatic: the owner wants zero setup on demo day ("0 of the bs
 * setup"). Before, only an explicit POST took a baseline, because one taken
 * with a hand on the table blinds that spot. The rules below keep that risk
 * small instead of putting it on the operator:
 * - the first take is 5 s after the lidar starts receiving (the boot, when
 *   nobody is reaching over the table yet);
 * - it is taken again whenever the table has been STILL for 20 s: no tracked
 *   touch and frame-to-frame change below the noise. That is what handles the
 *   MiniLab or the iPad moving between acts: once the moved object sits still,
 *   it becomes part of the table instead of a permanent phantom touch;
 * - never while a touch is down (a held finger would be learned as table).
 * The explicit POST stays as the operator's override.
 *
 * Why frame-to-frame change and not "no foreground against the baseline":
 * a moved MiniLab IS foreground against the old baseline forever, so that
 * rule would never re-take, which is exactly the case this exists for.
 *
 * Pure decision logic: the service feeds frames and asks `shouldTake`.
 */
export const FIRST_TAKE_MS = 5000
export const STILL_RETAKE_MS = 20_000
/** A bin "moved" when its range changed by more than this (the C1's ±30 mm accuracy, datasheet). */
export const MOVE_MM = 40
/** The frame is still when under this share of comparable bins moved: rotation-to-rotation dropouts stay below it. */
export const MOVED_SHARE = 0.02

function ranges(frame: LidarFrame) {
  const out = new Float64Array(BINS)
  for (const p of frame.points) if (p.distance > 0) out[binOf(p.angle)] = p.distance
  return out
}

export function createAutoBaseline() {
  let receivingSince: number | null = null
  let stillSince: number | null = null
  let lastTakeAt: number | null = null
  let prev: Float64Array | null = null

  return {
    /** Feed every frame with its receive time and whether any touch is tracked. */
    frame(frame: LidarFrame, at: number, touchDown: boolean) {
      if (receivingSince === null) receivingSince = at
      const cur = ranges(frame)
      let compared = 0
      let moved = 0
      if (prev) for (let i = 0; i < BINS; i++) {
        if (!prev[i] || !cur[i]) continue
        compared++
        if (Math.abs(prev[i]! - cur[i]!) > MOVE_MM) moved++
      }
      prev = cur
      const still = !touchDown && compared > 0 && moved / compared < MOVED_SHARE
      if (!still) stillSince = null
      else if (stillSince === null) stillSince = at
    },
    /** The lidar stopped receiving: the next start is a fresh boot. */
    lost() { receivingSince = null; stillSince = null; prev = null },
    shouldTake(at: number, hasBaseline: boolean, touchDown: boolean): boolean {
      if (touchDown || receivingSince === null) return false
      if (!hasBaseline) return at - receivingSince >= FIRST_TAKE_MS && (lastTakeAt === null || at - lastTakeAt >= FIRST_TAKE_MS)
      return stillSince !== null && at - stillSince >= STILL_RETAKE_MS && (lastTakeAt === null || at - lastTakeAt >= STILL_RETAKE_MS)
    },
    /** A take started: the stillness clock restarts so the next re-take needs another 20 s. */
    took(at: number) { lastTakeAt = at; stillSince = null },
  }
}
