import { useEffect, useState } from 'react'
import type { SurfacesLine, TableSurface } from '@hubble/stage'
import { subscribeStage } from './stageStream.ts'

/**
 * The table's surface set as a display holds it: the newest `surfaces` line
 * the server sent (apps/server/surfaces.ts owns the live set).
 *
 * A display only ever mirrors. The one rule here is ordering: `rev` only grows
 * within one connection, so a line older than the one already applied is a
 * replay racing a live update and is dropped. A new connection starts over
 * (`null`), because a restarted server counts revs from 1 again and its lines
 * must not be refused as "older" forever.
 */
export function applySurfacesLine(prev: SurfacesLine | null, line: SurfacesLine): SurfacesLine {
  return prev && line.rev <= prev.rev ? prev : line
}

/**
 * The live surface set from /api/stage/events (its own subscription, like the
 * overlays). `null` until this connection received a set: "nothing received
 * yet" and "the server says the table is empty" are different facts, and the
 * answer fallback below must only ever cover the first (review #38).
 */
export function useSurfaces(): readonly TableSurface[] | null {
  const [line, setLine] = useState<SurfacesLine | null>(null)
  useEffect(() => {
    // The page's one shared connection (stageStream.ts: one EventSource per
    // hook used up Chrome's connection limit and froze every request).
    return subscribeStage({
      // Every (re)connect gets the latest set replayed by the hub; forget the
      // old revision first so a restarted server's set is accepted.
      open: () => setLine(null),
      line: (l) => {
        if (l.kind === 'surfaces') setLine((prev) => applySurfacesLine(prev, l as unknown as SurfacesLine))
      },
    })
  }, [])
  return line?.surfaces ?? null
}

/**
 * The answer surface to draw a given render with.
 *
 * Before this connection has received any set (`null`: the surfaces line
 * lands just after the answer starts, or a server that predates surfaces),
 * the answer is still drawn, at the bottom and unmoved: the math act must
 * never depend on the window list to appear. Once a set has arrived it is the
 * truth: no answer surface means the answer was closed, and inventing one
 * kept a closed answer on the table (review #38).
 */
export function answerSurfaceFor(received: readonly TableSurface[] | null, renderId: string | undefined, hasContent: boolean): { set: readonly TableSurface[]; offset: { x: number; y: number } | undefined } {
  const surfaces = received ?? []
  const answer = surfaces.find((s) => s.kind === 'answer')
  if (answer) {
    const st = answer.state as { renderId?: string; offset?: { x: number; y: number } }
    // A move belongs to the render it was made on; another render (the
    // bench showing an older run) is drawn where it was laid out.
    return { set: surfaces, offset: st.renderId === renderId ? st.offset : undefined }
  }
  if (received !== null || !hasContent) return { set: surfaces, offset: undefined }
  const fallback: TableSurface = { id: 'answer', kind: 'answer', box: { x: 0, y: 0, w: 0, h: 0 }, z: -Infinity, focused: false, instance: 0, pinned: false, state: {} }
  return { set: [fallback, ...surfaces], offset: undefined }
}

/**
 * Surface kinds drawn over the keyboard that own every press starting on
 * them: the launcher (#33). The hand pipeline asks this before it gives a
 * press to the keyboard, so a pick on the launcher never also types the key
 * under it (review #48). #32 adds kinds here as other surfaces take hand
 * input.
 */
const OWNS_PRESSES: ReadonlySet<string> = new Set(['launcher'])
export function ownsPress(surfaces: readonly TableSurface[] | null, p: { x: number; y: number }): boolean {
  return !!surfaces?.some((s) => OWNS_PRESSES.has(s.kind) && p.x >= s.box.x && p.x <= s.box.x + s.box.w && p.y >= s.box.y && p.y <= s.box.y + s.box.h)
}
