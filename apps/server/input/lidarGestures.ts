import type { Point } from '../spatial/coordinates.ts'
import type { SpatialTouchEvent } from '../spatial/service.ts'
import type { TableGesture } from '../inputs.ts'

/**
 * What a lidar touch DOES (docs/plans/2026-10-07-lidar-web.md): a tap clicks,
 * a drag scrolls or moves, and in the `room-lidar` keyboard mode a stroke on
 * the projected keyboard types.
 *
 * Why it emits TableGestures into runtime.gesture instead of acting on pages:
 * the launcher, the focus rule and the web handler (#100) already decide what
 * a tap or a drag means on each surface, for hands and the bench. A lidar
 * finger is one more source of the same gestures; a second router here would
 * be a second owner of "what did that tap hit", and the two would drift.
 *
 * Pure, with its dependencies passed in, so its rulings are tested with
 * schema-derived events and no socket.
 */

/** Ruling 6: travel below this is a tap, above it a drag (the hand tracker's own tapMaxMm, apps/shared/hands/gestures.ts). */
export const LIDAR_TAP_MAX_MM = 24
/** Ruling 6: a tap must lift within this. Longer without travel is a resting hand, not a click. */
export const LIDAR_TAP_MAX_MS = 600

export interface LidarGestureDeps {
  /** The kind of surface under a projector point (stage's hitTest over the live set), or null for open table. */
  kindAt(p: Point): string | null
  /** runtime.gesture: the one router of taps and drags. */
  gesture(g: TableGesture): void
  /** Is lidar typing on (keyboardInput mode `room-lidar`)? Read per touch, so a mode switch applies at once. */
  lidarTyping(): boolean
  /** The keyboard's own stroke (swipeKeyboard.stroke), in projector px. */
  keyboardStroke(points: Point[]): void
  /** Projector px per mm, from the Surface (both thresholds are physical). */
  mmPerPx: number
  now(): number
}

type Active =
  | { id: number; kind: 'keys'; points: Point[] }
  | { id: number; kind: 'surface'; down: Point; at: number; last: Point; dragging: boolean }

export function createLidarGestures(d: LidarGestureDeps) {
  // Ruling 5: one track owns the gesture until it ends; surfaceGestures holds
  // one grab, and a second finger's drag-moves would interleave with the first.
  let active: Active | null = null
  const travel = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) * d.mmPerPx

  return {
    touch(e: SpatialTouchEvent) {
      // A candidate only ripples (touchLines.ts): one rotation is not enough to
      // act on. A touch with no projector position can't hit anything.
      if (e.type === 'candidate' || !e.projector) return
      const p = e.projector
      if (e.type === 'down') {
        if (active) return
        const kind = d.kindAt(p)
        if (kind === 'keyboard') {
          // Off by default (Ruling 7): the plane sits 3–7 cm up, and a hover
          // typing ghost letters is worse than no lidar typing.
          if (d.lidarTyping()) active = { id: e.id, kind: 'keys', points: [p] }
          return
        }
        active = { id: e.id, kind: 'surface', down: p, at: d.now(), last: p, dragging: false }
        return
      }
      if (!active || active.id !== e.id) return
      const a = active
      if (e.type === 'move') {
        if (a.kind === 'keys') {
          // Bounded like the pinch path: a stuck track never grows a minute of points.
          if (a.points.length < 1000) a.points.push(p)
          return
        }
        a.last = p
        if (!a.dragging && travel(a.down, p) >= LIDAR_TAP_MAX_MM) {
          a.dragging = true
          // The drag starts where the finger went down, so the first move
          // carries the travel that made it a drag instead of losing it.
          d.gesture({ type: 'drag-start', p: a.down })
        }
        if (a.dragging) d.gesture({ type: 'drag-move', p })
        return
      }
      active = null
      if (e.type === 'cancel') {
        // Nobody saw a lift (silence, a new baseline, a new registration):
        // undo a drag, and never commit a stroke or a tap from it.
        if (a.kind === 'surface' && a.dragging) d.gesture({ type: 'drag-end', p: a.last, flick: false, cancelled: true })
        return
      }
      // up
      if (a.kind === 'keys') {
        d.keyboardStroke(a.points)
        return
      }
      if (a.dragging) {
        d.gesture({ type: 'drag-end', p: a.last, flick: false, cancelled: false })
        return
      }
      // Ruling 6: at the DOWN point. A lifting finger drifts toward the person.
      if (d.now() - a.at <= LIDAR_TAP_MAX_MS && travel(a.down, a.last) < LIDAR_TAP_MAX_MM) d.gesture({ type: 'tap', p: a.down, region: 'surface' })
    },
    /** For stop: forget a live track without acting on it. */
    reset() {
      active = null
    },
  }
}
