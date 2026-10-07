import type { GestureEvent } from './gestures.ts'

/**
 * Hand gestures to the server's input stream (#28), strictly in the order
 * the hand made them.
 *
 * Why a queue: the runtime keeps one grab (#32), and a drag only makes sense
 * as start → moves → end. Fired as independent requests, a slow `drag-end`
 * could reach the server after the next `drag-start` and end the new grab
 * (review #49, suspicion). One request at a time costs nothing at a hand's
 * rate (drag moves are the busiest, ~30/s, each a tiny local POST).
 *
 * Failures are dropped, not retried: a gesture is only meaningful now, and
 * replaying a stale drag later would move something the hand left long ago.
 */
export function createGesturePoster(f: typeof fetch = (...a) => fetch(...a)) {
  let queue: Promise<unknown> = Promise.resolve()
  return {
    post(e: GestureEvent): Promise<unknown> {
      // Pen moves are the keyboard's business and arrive 30 times a second;
      // the runtime needs presses, taps, drags and wakes. Drag moves do go:
      // a surface follows the hand.
      if (e.type === 'pen-move') return queue
      const { t: _t, ...rest } = e
      // A tap's path is keyboard evidence, not part of the server's gesture schema.
      const gesture = rest.type === 'tap' ? { type: 'tap', p: rest.p, region: rest.region } : rest
      queue = queue.then(() => f('/api/input/gesture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gesture) }).catch(() => undefined))
      return queue
    },
  }
}
