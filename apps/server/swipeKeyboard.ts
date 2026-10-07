import type { Box, RenderRequest, SceneObject } from '@hubble/stage'
import { createKeyboard, defaultKeyboardBox, initialKeyboard, keyboardMmFromTable, type Keyboard, type KeyboardOutput, type KeyboardState, type KeyboardSurfaceState, type Pt } from '@hubble/stage/swipe'
import { KEYBOARD_ID, type SurfaceManager } from './surfaces.ts'

/**
 * The swipe keyboard on the table (#29): the one owner of what is typed on it.
 *
 * Why the server and not the display: the keyboard is drawn by every display
 * at once (/table on the Pi, the bench's table simulator), and the strokes
 * come from wherever the pen is (the bench mouse, the hand tracker, #28). If
 * each display kept its own text, two displays would show two drafts and a
 * reload would lose one. So the text line, the candidates and send live
 * here, beside the rest of the product state, and displays only draw the
 * keyboard surface's `state`.
 *
 * The rules themselves are not here: a finished stroke goes through
 * `@hubble/stage/swipe`'s reducer, the same one the bench's mouse and the
 * hand tracker use, so a stroke means the same thing on every path.
 *
 * Frames: strokes arrive in table (projector) px, the frame lidar touches,
 * camera fingertips and surface boxes all share. The reducer works in
 * keyboard mm (origin at the q key's top-left, the text line and candidates
 * at negative y). The conversion uses the surface's own box, so a keyboard
 * that has been moved still types where it is drawn.
 */

export interface StrokeResult {
  /** Whether the stroke started on the keyboard (a stroke elsewhere is not the keyboard's). */
  hit: boolean
  output: KeyboardOutput
}

export function createSwipeKeyboard(d: {
  surfaces: SurfaceManager
  /** SEND's one seam (index.ts `ask`): by default it publishes the text for the puppet master (puppetInput.ts), not Julius's brain. False = refused, and the text goes back on the line. */
  ask(request: RenderRequest): boolean
  /** What the camera last saw, so the answer is laid out around the real objects. */
  seen(): SceneObject[]
  /**
   * Where SEND goes instead of the brain, when something else is the target:
   * the focused web page (runtime.ts), which types the text and presses
   * Enter. Null (or absent): SEND asks, as before. Read at the moment of
   * SEND, so a page closed since it was focused is never typed into.
   * The callee returns false when it couldn't take the text; then it asks.
   */
  sendTo?(): ((text: string) => boolean) | null
}) {
  // Built on first use, not at startup: the decoder builds ~10k word
  // templates, and a server that never opens the keyboard (the math act on
  // its own) shouldn't pay for it.
  let keyboard: Keyboard | null = null
  let kb: KeyboardState = initialKeyboard()
  let sent: KeyboardSurfaceState['sent'] = null

  const wire = (): KeyboardSurfaceState => ({ text: kb.text, candidates: kb.candidates.map((c) => c.word), sent })
  const current = () => d.surfaces.list().find((s) => s.id === KEYBOARD_ID) ?? null

  return {
    /**
     * Open the keyboard: at `at` (its top-left, table px) or bottom-centre.
     * Its size is physical (44 mm keys, AGENTS.md rule 5): the projector's
     * mm per px turns the widget's mm into a box.
     */
    open(at?: { x: number; y: number }) {
      keyboard ??= createKeyboard()
      const b = d.surfaces.bounds()
      const def = defaultKeyboardBox(b)
      const box: Box = at ? { ...def, x: at.x, y: at.y } : def
      return d.surfaces.openKeyboard(box, wire())
    },

    /** Close it (the draft goes with it: see `discardDraft`). */
    close() {
      return d.surfaces.close(KEYBOARD_ID)
    },

    /**
     * The keyboard left the table, by whatever path (the surface manager
     * calls this for all of them). The draft goes with it: a half-typed line
     * reappearing the next time someone opens the keyboard, possibly someone
     * else, is a surprise; retyping a few words is not.
     */
    discardDraft() {
      kb = initialKeyboard()
    },

    /**
     * One finished stroke (pen-down to pen-up), in table px.
     *
     * `ask: false` leaves SEND's question to the caller: the bench sends it
     * as its own chat turn, which carries what only the bench has (the
     * notebook photo, the chosen model) and shows in its log and simulator.
     * The runtime still owns the line and counts the send. Every other
     * caller (a pen with no conversation of its own) gets the default: the
     * runtime asks.
     */
    stroke(points: Pt[], opts: { ask?: boolean } = {}): StrokeResult {
      const s = current()
      if (!s || !keyboard || points.length === 0) return { hit: false, output: { kind: 'none' } }
      const { box } = s
      const start = points[0]!
      // Only a stroke that *starts* on the keyboard is the keyboard's: a
      // swipe that begins on an answer and crosses the keys is a drag of the
      // answer (#32), and typing a word from it would be a word nobody asked
      // for. Edges count, as in hitTest.
      if (start.x < box.x || start.x > box.x + box.w || start.y < box.y || start.y > box.y + box.h) return { hit: false, output: { kind: 'none' } }
      // Through the box as it is now, so a moved keyboard types where it is drawn.
      const mm = points.map((p) => keyboardMmFromTable(box, p))
      const [next, output] = keyboard.stroke(kb, mm)
      kb = next
      let typed = false
      if (output.kind === 'sent') {
        // The keyboard itself is added to the scene by renderToTable, for
        // every render while it is open, not only this one (review #47).
        // A focused page takes the text first (compose, then SEND types it:
        // the 7 Oct ruling). Only when nothing is focused does SEND ask.
        const target = d.sendTo?.() ?? null
        typed = target !== null && target(output.text)
        const asked = typed || opts.ask === false || d.ask({ intent: output.text, scene: { surface: d.surfaces.bounds(), objects: [...d.seen()] } })
        // No model: the text is put back on the line instead of vanishing
        // into a silent no-op, so the person sees it still waiting to be
        // sent, and the display doesn't flash a send that never happened.
        if (asked) sent = { n: (sent?.n ?? 0) + 1, text: output.text }
        else kb = { ...kb, text: output.text }
      }
      d.surfaces.setKeyboardState(wire())
      // Typed into a page: the caller sees no 'sent'. Why: the bench posts
      // strokes with ask:false and sends a 'sent' text as its own chat turn
      // (tableKeyboard.ts onSent), so the same words went into Amazon's
      // search box *and* to the brain as a question. The page was the target.
      if (typed) return { hit: true, output: { kind: 'none' } }
      return { hit: true, output }
    },

    state: (): KeyboardSurfaceState | null => (current() ? wire() : null),
  }
}

export type SwipeKeyboardOwner = ReturnType<typeof createSwipeKeyboard>
