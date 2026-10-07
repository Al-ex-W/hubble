/**
 * The swipe keyboard's rules, shared by every place that types (#29).
 *
 * They lived in apps/web/src/swipe until the keyboard became a surface on the
 * table: the runtime (server) now owns what is typed on the projected
 * keyboard, so it runs the same reducer the bench's mouse and the hand
 * tracker do. One copy, here, because two copies of "what delete takes back"
 * drift. A subpath (`@hubble/stage/swipe`), not the package root: the root
 * already exports the answer panels' `layout.ts`, and `Layout` / `buildLayout`
 * would collide.
 *
 * No DOM, no React, like the rest of stage.
 */
import { buildLayout, type Pt } from './layout.ts'
import { WIDGET } from './keyboard.ts'

export * from './layout.ts'
export * from './decoder.ts'
export * from './keyboard.ts'
export { LEXICON } from './lexicon.ts'

const board = buildLayout()

/** The whole widget (text line, candidates, keys) in mm: the keyboard surface's physical size. */
export const SWIPE_KEYBOARD_MM = { w: board.width, h: WIDGET.keysY + board.height } as const

/**
 * The keyboard surface's `state` on the wire (TableSurface.state): what a
 * display draws. The runtime owns it (apps/server/swipeKeyboard.ts); displays only
 * mirror it, so the table, the bench and a reconnecting Pi show the same line.
 *
 * Candidates go as words in decoder order (best first); SLOT_ORDER decides
 * where each is drawn, on every display alike. `sent` counts sends, so a
 * display can flash the sent line once per send and not again on a replay of
 * the same set.
 */
export interface KeyboardSurfaceState extends Record<string, unknown> {
  text: string
  candidates: string[]
  sent: { n: number; text: string } | null
}

/**
 * Keyboard mm (the reducer's frame: origin at the q key's top-left, the text
 * line and candidates at negative y) ↔ table px, through the keyboard
 * surface's box. The box's px size was made from SWIPE_KEYBOARD_MM, so its
 * width alone gives the scale.
 *
 * Both directions live here, together, because two sides use them: the
 * runtime turns posted table-px strokes into keyboard mm, and the bench
 * turns pointer and hand strokes (keyboard mm) into table px to post. If each
 * side wrote its own, a moved keyboard would type 80 mm off on one of them.
 */
export function keyboardMmFromTable(box: { x: number; y: number; w: number }, p: Pt): Pt {
  const mmPerPx = SWIPE_KEYBOARD_MM.w / box.w
  return { x: (p.x - box.x) * mmPerPx, y: (p.y - box.y) * mmPerPx - WIDGET.keysY }
}
export function tableFromKeyboardMm(box: { x: number; y: number; w: number }, p: Pt): Pt {
  const pxPerMm = box.w / SWIPE_KEYBOARD_MM.w
  return { x: box.x + p.x * pxPerMm, y: box.y + (p.y + WIDGET.keysY) * pxPerMm }
}

/**
 * The projected keyboard as a scene object, for the model's layout to keep
 * answers off the keys. Shared by the runtime's send and the bench's own
 * chat turn, so both describe the keyboard the same way. Kind `other`: the
 * scene's `keyboard` kind is the MiniLab, a physical object the lesson lights.
 */
export function keyboardSceneObject(box: { x: number; y: number; w: number; h: number }) {
  return { id: 'swipe-keyboard', kind: 'other' as const, label: 'projected keyboard', box: { x: box.x, y: box.y, w: box.w, h: box.h } }
}

/** How far above the table's near edge the keyboard opens: in reach without leaning (#10). */
export const KEYBOARD_NEAR_EDGE_MM = 40

/**
 * Where the keyboard opens unless told otherwise: bottom-centre, its 44 mm
 * keys at their physical size. Shared by the runtime (which opens it) and the
 * bench's hand mapping before it is open, so the two can't disagree.
 */
export function defaultKeyboardBox(surface: { widthPx: number; heightPx: number; mmPerPx: number }) {
  const w = SWIPE_KEYBOARD_MM.w / surface.mmPerPx
  const h = SWIPE_KEYBOARD_MM.h / surface.mmPerPx
  return { x: (surface.widthPx - w) / 2, y: surface.heightPx - h - KEYBOARD_NEAR_EDGE_MM / surface.mmPerPx, w, h }
}
