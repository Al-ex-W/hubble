import { describe, expect, it } from 'vitest'
import { DEFAULT_SURFACE } from '@hubble/stage'
import type { SpatialTouchEvent } from '../spatial/service.ts'
import type { TableGesture } from '../inputs.ts'
import { createLidarGestures, LIDAR_TAP_MAX_MM, LIDAR_TAP_MAX_MS } from './lidarGestures.ts'

/*
 * Lidar touch → gestures (docs/plans/2026-10-07-lidar-web.md Rulings 5–7).
 * Fixtures: schema-derived SpatialTouchEvents, as the spatial service emits
 * them (touchLines.test.ts style). Oracles: the thresholds in mm, converted
 * here with the Surface's own mm/px.
 */
const mmPerPx = DEFAULT_SURFACE.mmPerPx
const px = (mm: number) => mm / mmPerPx
const ev = (type: SpatialTouchEvent['type'], p: { x: number; y: number }, id = 1): SpatialTouchEvent => ({ type, id, table: { x: p.x * mmPerPx, y: p.y * mmPerPx }, spanMm: 15, projector: p, sourceSession: 's' })

function rig(o: { kind?: string | null; typing?: boolean } = {}) {
  let t = 0
  const gestures: TableGesture[] = []
  const strokes: { x: number; y: number }[][] = []
  const g = createLidarGestures({
    kindAt: () => (o.kind === undefined ? 'web' : o.kind),
    gesture: (x) => gestures.push(x),
    lidarTyping: () => o.typing ?? false,
    keyboardStroke: (p) => strokes.push(p),
    mmPerPx,
    now: () => t,
  })
  return { g, gestures, strokes, advance: (ms: number) => (t += ms) }
}

const P = { x: 900, y: 500 }

describe('lidar gestures', () => {
  // Break caught: a tap on a page not clicking it, or clicking where the
  // finger lifted instead of where it went down (Ruling 6).
  it('a short touch is one tap, at the down point', () => {
    const { g, gestures, advance } = rig()
    g.touch(ev('candidate', P))
    g.touch(ev('down', P))
    advance(200)
    g.touch(ev('move', { x: P.x + px(10), y: P.y }))
    g.touch(ev('up', { x: P.x + px(10), y: P.y }))
    expect(gestures).toEqual([{ type: 'tap', p: P, region: 'surface' }])
  })

  // Break caught: a swipe on a page clicking instead of scrolling, or the
  // drag starting where it was recognised (losing the first 24 mm).
  it('travel past the tap threshold is a drag from the down point, and no tap', () => {
    const { g, gestures } = rig()
    g.touch(ev('down', P))
    const far = { x: P.x, y: P.y + px(LIDAR_TAP_MAX_MM + 6) }
    g.touch(ev('move', far))
    g.touch(ev('up', far))
    expect(gestures).toEqual([
      { type: 'drag-start', p: P },
      { type: 'drag-move', p: far },
      { type: 'drag-end', p: far, flick: false, cancelled: false },
    ])
  })

  // Break caught: a resting hand clicking whatever is under it.
  it('a long hold without travel does nothing', () => {
    const { g, gestures, advance } = rig()
    g.touch(ev('down', P))
    advance(LIDAR_TAP_MAX_MS + 100)
    g.touch(ev('up', P))
    expect(gestures).toEqual([])
  })

  // Break caught: acting on one rotation's evidence (a candidate is the ripple's, not a click).
  it('a candidate that never confirms does nothing', () => {
    const { g, gestures } = rig()
    g.touch(ev('candidate', P))
    g.touch(ev('cancel', P))
    expect(gestures).toEqual([])
  })

  // Break caught: two fingers interleaving drags into one grab (Ruling 5).
  it('a second finger is ignored while the first owns the gesture', () => {
    const { g, gestures } = rig()
    g.touch(ev('down', P, 1))
    g.touch(ev('down', { x: 100, y: 100 }, 2))
    g.touch(ev('move', { x: 100, y: 400 }, 2))
    g.touch(ev('up', { x: 100, y: 400 }, 2))
    g.touch(ev('up', P, 1))
    expect(gestures).toEqual([{ type: 'tap', p: P, region: 'surface' }])
  })

  // Break caught: a lost track (silence, re-registration) leaving a page
  // grabbed mid-scroll, or committing a click nobody lifted for.
  it('cancel mid-drag ends the drag as cancelled; cancel before travel does nothing', () => {
    const a = rig()
    a.g.touch(ev('down', P))
    const far = { x: P.x, y: P.y + px(60) }
    a.g.touch(ev('move', far))
    a.g.touch(ev('cancel', far))
    expect(a.gestures.at(-1)).toEqual({ type: 'drag-end', p: far, flick: false, cancelled: true })
    const b = rig()
    b.g.touch(ev('down', P))
    b.g.touch(ev('cancel', P))
    expect(b.gestures).toEqual([])
  })

  // Break caught: lidar typing on the keyboard while it isn't selected (Ruling 7:
  // a hover would type ghost letters), and the keyboard getting a drag instead.
  it('on the keyboard: nothing unless room-lidar typing is on', () => {
    const { g, gestures, strokes } = rig({ kind: 'keyboard', typing: false })
    g.touch(ev('down', P))
    g.touch(ev('move', { x: P.x + px(40), y: P.y }))
    g.touch(ev('up', { x: P.x + px(40), y: P.y }))
    expect(gestures).toEqual([])
    expect(strokes).toEqual([])
  })

  // Break caught: a swipe on the keys not reaching the keyboard as one stroke
  // with every point, in order, when lidar typing is on.
  it('on the keyboard with room-lidar typing: one stroke from down to up', () => {
    const { g, gestures, strokes } = rig({ kind: 'keyboard', typing: true })
    const path = [P, { x: P.x + 40, y: P.y }, { x: P.x + 80, y: P.y + 10 }]
    g.touch(ev('down', path[0]))
    g.touch(ev('move', path[1]))
    g.touch(ev('move', path[2]))
    g.touch(ev('up', path[2]))
    expect(strokes).toEqual([path])
    expect(gestures).toEqual([])
  })

  // Break caught: a cancelled stroke typing a word nobody finished.
  it('a cancelled keyboard stroke types nothing', () => {
    const { g, strokes } = rig({ kind: 'keyboard', typing: true })
    g.touch(ev('down', P))
    g.touch(ev('move', { x: P.x + 40, y: P.y }))
    g.touch(ev('cancel', { x: P.x + 40, y: P.y }))
    expect(strokes).toEqual([])
  })
})
