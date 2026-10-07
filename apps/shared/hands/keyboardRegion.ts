import { buildLayout, WIDGET } from '@hubble/stage/swipe'
import type { Pt } from './types.ts'
import type { Region } from './gestures.ts'

const layout = buildLayout()
const WIDGET_RECT = { x: 0, y: -WIDGET.keysY, w: layout.width, h: WIDGET.keysY + layout.height }
const inRect = (p: Pt, r: { x: number; y: number; w: number; h: number }, m = 0) => p.x >= r.x - m && p.x <= r.x + r.w + m && p.y >= r.y - m && p.y <= r.y + r.h + m

/**
 * Which part of the table a press starts on, from the keyboard's geometry.
 * Candidates first: the keys' half-key slack reaches up into the candidate
 * row, and a candidate tap landing there was read as a tap on no key (lab).
 * The rest of the widget (the text line) is nothing to press; anything
 * outside the widget is table, where a press drags a surface.
 */
export function regionAt(p: Pt): Region {
  const c = WIDGET.candidates
  if (inRect(p, { x: 0, y: c.y, w: layout.width, h: c.h })) return 'candidates'
  if (inRect(p, { x: 0, y: 0, w: layout.width, h: layout.height }, 22)) return 'keys'
  if (inRect(p, WIDGET_RECT)) return 'none'
  return 'surface'
}

