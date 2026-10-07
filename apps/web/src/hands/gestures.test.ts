import { describe, expect, it } from 'vitest'
import type { Features } from './features.ts'
import { GestureMachine, type GestureEvent, type Region } from './gestures.ts'
import type { Pt } from './types.ts'

/**
 * The gesture rules, one at a time. Label: synthetic feature timelines at
 * 30 fps, written to the thresholds measured on the IMG_3537 recording
 * (pinched 0.05-0.12, released 0.25-0.40). Oracle: the timeline written out
 * in each test; the whole recording is replayed in replay.test.ts.
 */
const DT = 33
// Keys below y=0 (the keyboard's frame), candidates just above, any other
// table space further up is a surface.
const regionAt = (p: Pt): Region => (p.y >= 0 ? 'keys' : p.y >= -40 ? 'candidates' : 'surface')
const PINCHED = 0.08
const OPEN = 0.33

function run(steps: { pinch?: number; pen?: Pt; open?: boolean; palm?: Pt; absent?: boolean }[], start = 0, scale = 1) {
  const gm = new GestureMachine({ regionAt, scale })
  const events: GestureEvent[] = []
  steps.forEach((s, i) => {
    const t = start + i * DT
    const f: Features = s.absent
      ? { t, present: false, pen: null, pinch: null, openPalm: false, palm: null, hands: 0 }
      : { t, present: true, pen: s.pen ?? { x: 100, y: 50 }, pinch: s.pinch ?? OPEN, openPalm: s.open ?? false, palm: s.palm ?? s.pen ?? { x: 100, y: 50 }, hands: 1 }
    events.push(...gm.push(f))
  })
  return events
}
const types = (ev: GestureEvent[]) => ev.filter((e) => e.type !== 'pen-move' && e.type !== 'drag-move').map((e) => e.type)
const repeat = <T,>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i))

describe('pinch hysteresis', () => {
  it('a pinch hovering between the close and open thresholds never toggles the pen', () => {
    // Break caught: one threshold for both directions, so a hand resting at
    // ~0.2 typed a stream of one-letter strokes.
    const ev = run(repeat(60, (i) => ({ pinch: i % 2 ? 0.18 : 0.22 })))
    expect(types(ev)).toEqual([])
  })
  it('once closed, hovering in the gap keeps the press: no release until clearly open', () => {
    const ev = run([...repeat(3, () => ({ pinch: PINCHED })), ...repeat(30, (i) => ({ pinch: 0.2, pen: { x: 100 + i * 3, y: 50 } }))])
    expect(types(ev)).toEqual(['pen-down'])
  })
  it('needs two frames past a threshold: a single dipped frame is noise', () => {
    // Break caught: confirmFrames ignored, so one jittery frame started a word.
    expect(types(run([{ pinch: OPEN }, { pinch: PINCHED }, { pinch: OPEN }, { pinch: OPEN }]))).toEqual([])
    expect(types(run([{ pinch: OPEN }, { pinch: PINCHED }, { pinch: PINCHED }]))).toEqual(['pen-down'])
  })
})

describe('the release does not bend the stroke', () => {
  it('frames already reading as open are not added to the stroke before the release is confirmed', () => {
    // Break caught: opening fingers drag the pinch point ~15 mm, which bent
    // every word's tail and turned SEND taps into swipes (lab simulator).
    const press = repeat(10, (i) => ({ pinch: PINCHED, pen: { x: 100 + i * 10, y: 50 } }))
    const opening = [{ pinch: OPEN, pen: { x: 400, y: 120 } }, { pinch: OPEN, pen: { x: 420, y: 130 } }]
    const ev = run([...press, ...opening])
    const stroke = ev.find((e) => e.type === 'stroke') as Extract<GestureEvent, { type: 'stroke' }>
    expect(stroke).toBeTruthy()
    expect(stroke.points.some((p) => p.x >= 400)).toBe(false)
  })
})

describe('a hand lost for a moment', () => {
  const press = repeat(6, (i) => ({ pinch: PINCHED, pen: { x: 100 + i * 15, y: 50 } }))
  it('keeps its stroke through a short dropout (MediaPipe drops single frames mid-motion)', () => {
    const ev = run([...press, ...repeat(4, () => ({ absent: true })), ...repeat(4, (i) => ({ pinch: PINCHED, pen: { x: 200 + i * 15, y: 50 } })), ...repeat(2, () => ({ pinch: OPEN }))])
    // 4 frames ≈ 132 ms < 220 ms: one stroke, not cancelled.
    expect(ev.filter((e) => e.type === 'stroke').map((e) => (e as { cancelled: boolean }).cancelled)).toEqual([false])
  })
  it('after a cancel, a hand that comes back still pinched starts a new press, not the old one', () => {
    // Review #42 survivor: a lost hand forgets its pinch. Without that, a
    // hand returning pinched did nothing (the machine thought it was still
    // closed) until it opened and closed again.
    const back = repeat(4, (i) => ({ pinch: PINCHED, pen: { x: 300 + i * 15, y: 50 } }))
    const ev = run([...press, ...repeat(10, () => ({ absent: true })), ...back, ...repeat(2, () => ({ pinch: OPEN }))])
    expect(types(ev)).toEqual(['pen-down', 'stroke', 'pen-down', 'stroke'])
    const strokes = ev.filter((e) => e.type === 'stroke') as Extract<GestureEvent, { type: 'stroke' }>[]
    expect(strokes[1]!.points[0]!.x).toBeGreaterThanOrEqual(300) // starts where the hand came back
  })
  it('cancels the stroke after a long dropout, and the half word is marked cancelled', () => {
    // Break caught: a hand leaving the camera finishing a half word, which the
    // decoder turns into a confident wrong word.
    const ev = run([...press, ...repeat(10, () => ({ absent: true }))])
    expect(ev.filter((e) => e.type === 'stroke').map((e) => (e as { cancelled: boolean }).cancelled)).toEqual([true])
  })
})

describe('tap or stroke', () => {
  it('a press that trembles a lot but never leaves the spot is a tap (displacement, not path length)', () => {
    // Break caught: path length counting tremble, which turned a held tap on
    // SEND into a "swipe". ~120 mm of path, never more than 8 mm away.
    const press = repeat(8, (i) => ({ pinch: PINCHED, pen: { x: 300 + (i % 2 ? 8 : 0), y: 100 + (i % 3) * 2 } }))
    const ev = run([...repeat(2, () => ({ pinch: PINCHED, pen: { x: 300, y: 100 } })), ...press, ...repeat(2, () => ({ pinch: OPEN, pen: { x: 300, y: 100 } }))])
    expect(types(ev)).toEqual(['pen-down', 'tap'])
  })
  it('a press that travels a key or more is a stroke', () => {
    const press = repeat(10, (i) => ({ pinch: PINCHED, pen: { x: 100 + i * 8, y: 100 } }))
    expect(types(run([...press, ...repeat(2, () => ({ pinch: OPEN }))]))).toEqual(['pen-down', 'stroke'])
  })
})

describe('flick', () => {
  it('a drag that ends fast is a flick, even though the hand slows before the fingers open', () => {
    // Break caught: judging speed at the release frame, where the hand has
    // already stopped (~0 mm/s) even after a hard flick.
    const drag = repeat(6, (i) => ({ pinch: PINCHED, pen: { x: 100 + i * 2, y: -300 } }))
    const fast = repeat(4, (i) => ({ pinch: PINCHED, pen: { x: 112 + (i + 1) * 40, y: -300 } })) // ~1200 mm/s
    const stop = repeat(2, () => ({ pinch: PINCHED, pen: { x: 272, y: -300 } }))
    const ev = run([...drag, ...fast, ...stop, ...repeat(2, () => ({ pinch: OPEN, pen: { x: 272, y: -300 } }))])
    expect(ev.find((e) => e.type === 'drag-end')).toMatchObject({ flick: true, cancelled: false })
  })
  it('judges a flick in real mm/s: the same keyboard-mm motion on a half-scale printout is half as fast', () => {
    // Review #42 survivor: speed must include the sheet's scale. ~1200
    // keyboard mm/s is a flick on the table (scale 1) but only ~600 real
    // mm/s on the 22 mm print (scale 0.5), under the 700 mm/s threshold.
    const drag = repeat(6, (i) => ({ pinch: PINCHED, pen: { x: 100 + i * 2, y: -300 } }))
    const fast = repeat(4, (i) => ({ pinch: PINCHED, pen: { x: 112 + (i + 1) * 40, y: -300 } }))
    const end = [...repeat(2, () => ({ pinch: PINCHED, pen: { x: 272, y: -300 } })), ...repeat(2, () => ({ pinch: OPEN, pen: { x: 272, y: -300 } }))]
    expect(run([...drag, ...fast, ...end], 0, 1).find((e) => e.type === 'drag-end')).toMatchObject({ flick: true })
    expect(run([...drag, ...fast, ...end], 0, 0.5).find((e) => e.type === 'drag-end')).toMatchObject({ flick: false })
  })
  it('a slow drag is not a flick', () => {
    const drag = repeat(20, (i) => ({ pinch: PINCHED, pen: { x: 100 + i * 5, y: -300 } })) // ~150 mm/s
    const ev = run([...drag, ...repeat(2, () => ({ pinch: OPEN, pen: { x: 195, y: -300 } }))])
    expect(ev.find((e) => e.type === 'drag-end')).toMatchObject({ flick: false })
    expect(types(ev)).toEqual(['drag-start', 'drag-end'])
  })
})

describe('wake', () => {
  it('an open palm held still for about a second wakes, once', () => {
    const ev = run(repeat(40, () => ({ open: true, pinch: 0.8, palm: { x: 200, y: -200 } })))
    expect(types(ev)).toEqual(['wake'])
    expect(ev.find((e) => e.type === 'wake')).toMatchObject({ p: { x: 200, y: -200 } })
  })
  it('never while pinching: an open hand during a press is not a wake', () => {
    // Break caught (review #48 survivor): the wake guard's press/closed
    // check removed, so a second open hand in view woke the launcher in the
    // middle of a word.
    const ev = run(repeat(60, (i) => ({ pinch: PINCHED, open: true, pen: { x: 100 + i, y: 50 }, palm: { x: 300, y: -200 } })))
    expect(types(ev)).not.toContain('wake')
  })
  it('a moving open hand (a wave, a reach) does not wake', () => {
    const ev = run(repeat(40, (i) => ({ open: true, pinch: 0.8, palm: { x: 200 + i * 10, y: -200 } })))
    expect(types(ev)).toEqual([])
  })
})
