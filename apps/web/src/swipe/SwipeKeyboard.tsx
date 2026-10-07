import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { KeyboardFace } from '@hubble/stage-react'
import { buildLayout, SWIPE_KEYBOARD_MM, WIDGET, type KeyboardSurfaceState, type Pt } from '@hubble/stage/swipe'

export { SWIPE_KEYBOARD_MM }

/**
 * The bench's way to type on the table's swipe keyboard: the keyboard's face
 * plus a pointer, with the hand tracker's presses fed in beside the mouse's.
 *
 * Before #29 this component held the keyboard: its own text, its own
 * reducer, its own send. Now the keyboard is a surface the runtime owns
 * (apps/server/swipeKeyboard.ts), drawn by every display, so this component
 * keeps no text at all. It draws the state it is given (the surface's), and
 * hands every finished pointer stroke to `onStroke`, which posts it to the
 * runtime (tableKeyboard.ts; the hand tracker's presses take the same
 * function, without passing through here, so a press still lands when the
 * keyboard is closed and must open first). The rules stay in one place (@hubble/stage/swipe's
 * reducer, run by the runtime), so the bench, the hand and /table can't
 * disagree about what a stroke typed.
 *
 * What stays here is what only the pen's holder can know: the stroke being
 * drawn (its trail, the keys it crossed), since pen moves are local (#42).
 *
 * Frame: the SVG's viewBox is the widget in mm; strokes go out in keyboard
 * mm (keys from y = 0, the candidates and text line above, at negative y),
 * the reducer's frame.
 */
const layout = buildLayout()
const W = SWIPE_KEYBOARD_MM.w
const KB_Y = WIDGET.keysY
const CAND_Y = WIDGET.candidates.y + KB_Y
// Pointer samples closer than this add nothing to the shape and only cost
// decode time and SVG nodes.
const MIN_STEP_MM = 1.5

interface SwipeRecord {
  t: number
  path: Pt[]
}

declare global {
  interface Window {
    /** Every swipe made on the bench, for turning real paths into decoder fixtures. */
    hubbleSwipes?: SwipeRecord[]
  }
}

interface Props {
  /** What to draw: the keyboard surface's state, as the runtime published it. */
  state: Pick<KeyboardSurfaceState, 'text' | 'candidates' | 'sent'>
  /** A finished stroke (pen-down to pen-up), in keyboard mm. */
  onStroke: (points: Pt[]) => void
  /** The hand's press in progress, keyboard mm: drawn as the trail, like a pointer stroke. */
  handTrail?: Pt[]
}

export function SwipeKeyboard({ state, onStroke, handTrail }: Props) {
  const hitRef = useRef<SVGRectElement | null>(null)
  // The stroke being drawn lives in a ref, not only in state: pointer events
  // can arrive faster than React renders (a move and the up in one batch),
  // and a handler reading `path` state would send the previous render's
  // stroke and lose the end of the word (review #39). State is for drawing.
  const samples = useRef<Pt[] | null>(null)
  const [path, setPath] = useState<Pt[]>([])
  const [swiping, setSwiping] = useState(false)
  const [lit, setLit] = useState<Set<string>>(new Set())
  const [hot, setHot] = useState<string | null>(null)

  /**
   * Pointer → keyboard mm. Measured on the SVG that holds the hit area (its
   * owner), so the conversion works wherever the face is placed and scaled.
   */
  const toMm = (e: { clientX: number; clientY: number }): Pt => {
    const r = hitRef.current!.closest('svg')!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * SWIPE_KEYBOARD_MM.h - KB_Y }
  }
  const letterAt = (p: Pt) => (p.y >= 0 ? layout.keyAt(p) : null)

  const down = (e: ReactPointerEvent<SVGRectElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const p = toMm(e)
    const k = letterAt(p)
    samples.current = [p]
    setPath([p])
    setSwiping(true)
    setLit(new Set(k?.kind === 'letter' ? [k.id] : []))
    setHot(k?.id ?? null)
  }

  const add = (p: Pt) => {
    const s = samples.current
    if (!s) return false
    const last = s[s.length - 1]
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < MIN_STEP_MM) return false
    s.push(p)
    return true
  }

  const move = (e: ReactPointerEvent<SVGRectElement>) => {
    const p = toMm(e)
    if (!add(p)) return
    setPath([...samples.current!])
    const k = letterAt(p)
    setHot(k?.id ?? null)
    if (k?.kind === 'letter') setLit((prev) => (prev.has(k.id) ? prev : new Set(prev).add(k.id)))
  }

  const clear = () => {
    samples.current = null
    setSwiping(false)
    setHot(null)
    setLit(new Set())
  }

  // The release point is part of the stroke: a pointer can go up somewhere
  // no move event reported (review #39: A-down, S-up wrote "a", not "as").
  const up = (e: ReactPointerEvent<SVGRectElement>) => {
    const s = samples.current
    if (!s) return
    add(toMm(e))
    clear()
    send(s)
  }

  // A cancelled pointer (the browser took the gesture, the window lost
  // focus) is abandoned, never sent: committing it once sent a draft the
  // user never released on SEND (review #39).
  const cancel = () => {
    if (!samples.current) return
    clear()
  }

  const send = (points: Pt[]) => {
    if (points.length > 1) (window.hubbleSwipes ??= []).push({ t: Date.now(), path: points })
    onStroke(points)
  }

  const trail = handTrail && handTrail.length ? handTrail : path

  return (
    <KeyboardFace
      state={state}
      lit={lit}
      hot={hot}
      trail={trail}
      swiping={swiping || Boolean(handTrail?.length)}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
      // One hit area over the candidates and the keys: a swipe crosses many
      // keys, so no single key may own the pointer, and a candidate press is
      // a stroke like any other, so the reducer alone decides whether it was
      // a tap on a slot or a hand passing over (the hand tracker has no
      // per-element handlers to lean on).
      overlay={<rect ref={hitRef} x={0} y={CAND_Y} width={W} height={SWIPE_KEYBOARD_MM.h - CAND_Y} className="swk-hit" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} />}
    />
  )
}
