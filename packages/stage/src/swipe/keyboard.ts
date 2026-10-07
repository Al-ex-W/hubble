import { buildLayout, type Layout, type Pt } from './layout.ts'
import { createDecoder, TAP_MM, type Candidate, type Decoder } from './decoder.ts'
import { LEXICON } from './lexicon.ts'

/**
 * The swipe keyboard's text editing, with no React and no pointer: finished
 * strokes in (in keyboard mm), text and sent messages out.
 *
 * Why this exists as its own module: the rules (what a tap does, what delete
 * takes back, which candidate a swipe writes) used to live inside
 * SwipeKeyboard.tsx's event handlers, and the hands lab
 * (experiments/hands/src/keyboard.ts) had to keep a copy to drive them from a
 * camera. Two copies of "delete after a swipe" drift. Now the mouse on the
 * bench and the hand tracker (#28) feed this one reducer, and the component
 * only draws its state.
 *
 * Frame: the decoder's KEYBOARD MM (origin at the q key cell's top-left, y
 * towards the user, 44 mm keys). The text line and the candidate row sit
 * above the keys, at negative y, exactly as stage-react's KeyboardFace draws
 * them (SwipeKeyboard on the bench and the table's keyboard surface both
 * render through it); the hands lab's sheet.ts uses the same numbers, which
 * is why its recorded strokes replay here unchanged.
 */

/** Widget rows above the keys, in keyboard mm (negative y = above the q row). */
export const WIDGET = {
  /** The keys start this far below the widget's top edge. */
  keysY: 80,
  textLine: { y: -80, h: 36 },
  candidates: { y: 42 - 80, h: 30 },
  /**
   * Each key cap is drawn this far inside its 44 mm cell. Shared because the
   * hand tracker calibrates on the caps' printed corners (hands/calibration.ts):
   * if the drawing and the calibration disagreed, every stroke would land 3 mm off.
   */
  capGap: 3,
} as const

export interface KeyboardState {
  text: string
  /** Best first. Drawn with the best in the middle slot. */
  candidates: Candidate[]
  /**
   * Whether the last thing written was a swiped word. Delete then takes back
   * the whole word, as on a phone: a swipe wrote it in one gesture, so one
   * gesture undoes it. After a tapped letter it takes back one character.
   */
  lastWasSwipe: boolean
}

export type KeyboardOutput =
  | { kind: 'word'; word: string | null; candidates: Candidate[] }
  | { kind: 'key'; key: string }
  | { kind: 'choose'; word: string }
  | { kind: 'sent'; text: string }
  | { kind: 'none' }

export const initialKeyboard = (): KeyboardState => ({ text: '', candidates: [], lastWasSwipe: false })

/**
 * Candidate slots left to right hold candidates 1, 0, 2: the best sits in
 * the middle, where the eye already is after reading the text line (as on
 * iOS and Gboard). The component and stroke geometry both read this, so a
 * tap on the middle slot always means the best word.
 */
export const SLOT_ORDER = [1, 0, 2] as const

export interface Keyboard {
  layout: Layout
  /** One finished stroke (pen-down to pen-up): a tap if it barely moved, else a swipe. */
  stroke(s: KeyboardState, points: Pt[]): [KeyboardState, KeyboardOutput]
  /** Swap in candidate `index` (0 = best) for the word the last swipe wrote. */
  choose(s: KeyboardState, index: number): [KeyboardState, KeyboardOutput]
}

export function createKeyboard(layout: Layout = buildLayout(), decoder: Decoder = createDecoder(layout, LEXICON)): Keyboard {
  const tapKey = (s: KeyboardState, p: Pt): [KeyboardState, KeyboardOutput] => {
    const key = layout.keyAt(p)
    if (!key) return [s, { kind: 'none' }]
    switch (key.kind) {
      case 'letter':
        return [{ text: s.text + key.id, candidates: [], lastWasSwipe: false }, { kind: 'key', key: key.id }]
      case 'space':
        // Never a double space and never a leading one: a projected key has no
        // feel, so an accidental second tap is common and must cost nothing.
        return [{ text: s.text && !s.text.endsWith(' ') ? s.text + ' ' : s.text, candidates: [], lastWasSwipe: false }, { kind: 'key', key: 'space' }]
      case 'delete':
        return [{ text: s.lastWasSwipe ? s.text.replace(/\s*\S+\s*$/, '') : s.text.slice(0, -1), candidates: [], lastWasSwipe: false }, { kind: 'key', key: 'delete' }]
      case 'send': {
        const text = s.text.trim()
        // Nothing to send stays nothing: an empty chat turn would still cost
        // a model call and put a "?" answer on the table.
        if (!text) return [s, { kind: 'none' }]
        return [initialKeyboard(), { kind: 'sent', text }]
      }
    }
  }

  const choose = (s: KeyboardState, index: number): [KeyboardState, KeyboardOutput] => {
    const c = s.candidates[index]
    if (!c) return [s, { kind: 'none' }]
    const text = join(s.text.replace(/\S+$/, '').trimEnd(), c.word)
    // The chosen word moves to the front, so it shows as the best (middle)
    // and a second tap on the middle slot keeps it.
    const candidates = [c, ...s.candidates.filter((x) => x !== c)]
    return [{ ...s, text, candidates }, { kind: 'choose', word: c.word }]
  }

  return {
    layout,
    choose,
    stroke(s, points) {
      if (points.length === 0) return [s, { kind: 'none' }]
      const start = points[0]!
      // A tap is judged by how far the pen got from where it went down, not
      // by path length: a tracked fingertip trembles, and tremble adds path
      // length without the pen going anywhere. The hands lab moved to
      // displacement for the same reason after its simulator turned SEND taps
      // into swipes (experiments/hands PLAN.md, execution notes).
      let reach = 0
      for (const p of points) reach = Math.max(reach, Math.hypot(p.x - start.x, p.y - start.y))
      if (reach < TAP_MM) {
        if (start.y >= 0) return tapKey(s, start)
        const { y, h } = WIDGET.candidates
        if (start.y >= y && start.y <= y + h && start.x >= 0 && start.x <= layout.width) {
          const slot = Math.min(2, Math.max(0, Math.floor((start.x / layout.width) * 3)))
          return choose(s, SLOT_ORDER[slot])
        }
        return [s, { kind: 'none' }]
      }
      // A swipe has to start on the keys: one that starts on the text line
      // or the candidates is the hand passing over the widget, and decoding
      // it would write a word nobody asked for.
      if (start.y < 0) return [s, { kind: 'none' }]
      const found = decoder.decode(points)
      const best = found[0]?.word ?? null
      const next = best ? { text: join(s.text, best), candidates: found, lastWasSwipe: true } : { ...s, candidates: found }
      return [next, { kind: 'word', word: best, candidates: found }]
    },
  }
}

/** Appends a word with exactly one space before it. */
function join(text: string, word: string): string {
  return text === '' || text.endsWith(' ') ? text + word : `${text} ${word}`
}
