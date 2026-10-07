import type { Response as ExpressResponse } from 'express'

/**
 * One input stream for everything a person does at the table: MIDI notes,
 * room buttons, camera hand gestures (#28). Lidar touches left this stream in
 * #89: the spatial service owns the lidar (registration, baseline, tracking)
 * and the runtime turns its touches into ripples, so there is one lidar owner.
 * The lesson and the gesture handlers (#32) read from here, so there is exactly
 * one place where "what did the user just do" is decided.
 */
export type InputEvent =
  | { kind: 'midi'; t: number; type: 'note-on' | 'note-off'; note: number; velocity: number }
  | { kind: 'button'; t: number; id: string }
  | { kind: 'gesture'; t: number; gesture: TableGesture }

/**
 * A hand gesture from the camera (apps/web/src/hands, #28), in table
 * (projector) px: the frame the surface set hit-tests in. The tracker only
 * reports what the hand did; what it *does* (move a surface, open the
 * launcher) is the runtime's decision (#32, #33), made from this stream.
 * Region is where the press started: `surface` = open table, not the keyboard.
 */
type P = { x: number; y: number }
type GestureRegion = 'keys' | 'candidates' | 'surface' | 'none'
export type TableGesture =
  | { type: 'pen-down'; p: P; region: GestureRegion }
  | { type: 'pen-move'; p: P }
  | { type: 'stroke'; region: GestureRegion; points: P[]; cancelled: boolean }
  | { type: 'tap'; p: P; region: GestureRegion }
  | { type: 'drag-start'; p: P }
  | { type: 'drag-move'; p: P }
  | { type: 'drag-end'; p: P; flick: boolean; cancelled: boolean }
  | { type: 'wake'; p?: P }

export function createInputs() {
  const clients = new Set<ExpressResponse>()
  const listeners = new Set<(e: InputEvent) => void>()

  const emit = (e: InputEvent) => {
    for (const l of listeners) l(e)
    const msg = `data: ${JSON.stringify(e)}\n\n`
    for (const c of clients) c.write(msg)
  }

  return {
    emit,
    on(l: (e: InputEvent) => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    subscribe(res: ExpressResponse) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(': connected\n\n')
      clients.add(res)
      res.on('close', () => clients.delete(res))
    },
  }
}

export type Inputs = ReturnType<typeof createInputs>
