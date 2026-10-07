/**
 * Is the room's hardware window open? A thin view of the ONE owner,
 * packages/room/src/window.ts (n:10–n:30 Europe/Stockholm since 7 Oct 11:40).
 *
 * WHY this file still exists: Alex's branch (#99) kept its own copy of the
 * rule (n:00–n:20) because @hubble/room wasn't readable from his account.
 * That copy went stale when the window moved, so on the merge it became a
 * re-export: the minutes now come from window.ts and can't drift again.
 * Failing closed on an unreadable clock is window.ts's job too.
 */
import { windowAt } from '@hubble/room'

/** True while the window is open at `nowMs`. */
export function inHardwareWindow(nowMs: number = Date.now()): boolean {
  return windowAt(nowMs).open
}
