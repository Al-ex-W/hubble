import { defaultKeyboardBox, tableFromKeyboardMm, type Pt } from '@hubble/stage/swipe'
import type { Box, SurfacesLine } from '@hubble/stage'

/**
 * The bench's pen on the table's keyboard (#29): finished strokes, from the
 * mouse or the hand tracker, posted to the runtime that owns the keyboard.
 *
 * One function for both pens, so the hand and the mouse can't type through
 * different paths (before #29 they met in SwipeKeyboard's local reducer;
 * now they meet here, on the way to the runtime's).
 *
 * Strokes arrive in keyboard mm (the reducer's frame, what the hand
 * tracker's calibration and the pointer produce) and leave in table px
 * through the keyboard surface's current box, so a moved keyboard is typed
 * where it is drawn.
 */
export interface TableKeyboardClient {
  /** Queue one finished stroke; resolves when it (and every stroke before it) has been posted. */
  stroke(points: Pt[]): Promise<void>
}

export function createTableKeyboardClient(d: {
  /** The keyboard surface's box right now, if it is open (from the surface set). */
  box(): Box | null
  /** SEND happened: the bench asks the question as its own chat turn. */
  onSent(text: string, box: Box): void
  onError?(message: string): void
  fetch?: typeof fetch
}): TableKeyboardClient {
  const f = d.fetch ?? fetch
  const post = (url: string, body: unknown) => f(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  /** One stroke, start to finish: open if needed, post, report SEND. */
  const run = async (points: Pt[]) => {
    let box = d.box()
    // A hand typing at a closed keyboard means the keyboard should be on
    // the table (#42's rule): open it, then type the press into it rather
    // than dropping the first word.
    if (!box) {
      const res = await post('/api/keyboard/open', {})
      if (!res.ok) return d.onError?.(`could not open the keyboard (${res.status})`)
      box = ((await res.json()) as SurfacesLine).surfaces.find((s) => s.kind === 'keyboard')?.box ?? null
      // Until the surface set catches up over SSE, the next stroke opens
      // again; opening an open keyboard only raises it where it is.
      if (!box) return d.onError?.('the keyboard did not open')
    }
    const at = box
    // ask: false — the bench sends the question itself (see onSent), so
    // the runtime must not ask it a second time.
    const res = await post('/api/keyboard/stroke', { points: points.map((p) => tableFromKeyboardMm(at, p)), ask: false })
    if (!res.ok) return d.onError?.(`stroke refused (${res.status})`)
    const r = (await res.json()) as { output?: { kind: string; text?: string } }
    if (r.output?.kind === 'sent' && r.output.text) d.onSent(r.output.text, at)
  }

  // Strokes are posted strictly one after another, in pen order. Callers
  // fire and forget (pointer and hand events don't wait), and two strokes
  // in flight at once raced: with the keyboard closed, "my" waited on the
  // open while "name" went straight through, and the line read "name my";
  // a SEND could likewise overtake the word before it (review #47).
  let queue: Promise<void> = Promise.resolve()

  return {
    stroke(points) {
      if (points.length === 0) return queue
      queue = queue.then(async () => {
        try {
          await run(points)
        } catch (e) {
          // A dropped connection or an unreadable reply: say so, never lose
          // a stroke silently. No retry: a SEND whose reply was lost may
          // already have cleared the line on the server, and sending it
          // again would ask twice.
          d.onError?.(`stroke failed (${e instanceof Error ? e.message : 'network'})`)
        }
      })
      return queue
    },
  }
}

/**
 * Where the keyboard is on the table, in table mm, for the hand tracker's
 * keyboard → table map (calibration.ts keyboardToTable): the open surface's
 * box, else where the runtime will open it. Its own function so the bench's
 * hand mapping and the runtime's placement provably agree (review #47: a
 * mapping fixed at the origin passed every test).
 */
export function keyboardAtMm(box: Box | null, surface: { widthPx: number; heightPx: number; mmPerPx: number }): { xMm: number; yMm: number } {
  const b = box ?? defaultKeyboardBox(surface)
  return { xMm: b.x * surface.mmPerPx, yMm: b.y * surface.mmPerPx }
}
