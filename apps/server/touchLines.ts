import type { TouchLine } from '@hubble/stage'
import type { SpatialTouchEvent } from './spatial/service.ts'

/**
 * What a lidar touch shows on the displays (#89): the runtime's decision, kept
 * as one pure mapping so "which tracker event makes a ripple" has one owner.
 *
 * - `candidate` (the first rotation that saw the finger) becomes the display's
 *   `down`, so the ripple starts ~100 ms sooner than waiting for confirmation
 *   (plan Ruling 2: a false ripple costs nothing, a late one feels broken).
 * - The tracker's own `down` (confirmation) becomes nothing on the wire: the
 *   display already rippled, and a second `down` would ripple twice for one
 *   touch. Keyboard consumers that need confirmation read the spatial service,
 *   not this line.
 * - A touch with no projector position (unregistered at that instant) shows
 *   nothing rather than a ripple at (0, 0).
 */
export function touchLineFor(e: SpatialTouchEvent): TouchLine | null {
  if (!e.projector) return null
  const phase = e.type === 'candidate' ? 'down' : e.type === 'down' ? null : e.type
  return phase ? { kind: 'touch', id: e.id, phase, p: { x: e.projector.x, y: e.projector.y } } : null
}
