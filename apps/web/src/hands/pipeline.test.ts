import { describe, expect, it } from 'vitest'
import { keyboardToTable } from './calibration.ts'
import { createHandPipeline, regionAt } from './pipeline.ts'
import type { Frame, Hand, Pt } from './types.ts'
import { createKeyboard, initialKeyboard } from '@hubble/stage/swipe'

/**
 * The pipeline's routing: which presses reach the keyboard and how gestures
 * reach the table. Label: synthetic landmark frames (a hand built so its
 * pinch ratio and pen point are exactly what each step says), with an
 * identity camera map so image px are keyboard mm.
 */
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const DT = 33

/** A curled hand (never an open palm) whose thumb–index midpoint is `pen` and pinch ratio `pinch` (palm length 100). */
function hand(pen: Pt, pinch: number): Hand {
  const lm: [number, number][] = Array.from({ length: 21 }, () => [pen.x, pen.y + 60] as [number, number])
  lm[0] = [pen.x, pen.y + 160] // wrist
  lm[9] = [pen.x, pen.y + 60] // middle knuckle: palm length 100
  const half = (pinch * 100) / 2
  lm[4] = [pen.x - half, pen.y] // thumb tip
  lm[8] = [pen.x + half, pen.y] // index tip
  return { handedness: 'Right', score: 0.95, lm }
}
const frames = (steps: ({ pen: Pt; pinch: number } | null)[]): Frame[] => steps.map((s, i) => ({ t: i * DT, hands: s ? [hand(s.pen, s.pinch)] : [] }))
const repeat = <T,>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i))
const run = (fs: Frame[], kbToTable?: number[]) => {
  const p = createHandPipeline({ camToKb: I, scale: 1, kbToTable })
  return fs.map((f) => p.push(f))
}

describe('what reaches the keyboard', () => {
  it('a tap on a key reaches it, as its whole press', () => {
    // Break caught: taps dropped, so tapped letters, space, delete and SEND do nothing.
    const steps = run(frames([...repeat(4, () => ({ pen: { x: 110, y: 66 }, pinch: 0.08 })), ...repeat(2, () => ({ pen: { x: 110, y: 66 }, pinch: 0.33 }))]))
    const presses = steps.flatMap((s) => s.presses)
    expect(presses).toHaveLength(1)
    expect(presses[0]!.every((p) => p.x === 110 && p.y === 66)).toBe(true)
  })
  it('the keyboard, not the gesture machine, decides tap or swipe for a short press', () => {
    // Review #42: a 23 mm press (A to S) is a tap to the gesture machine
    // (24 mm) but a swipe to the keyboard (22 mm). Collapsing it to one point
    // typed "a"; the same mouse path types "as". Label: synthetic landmarks.
    const steps = run(frames([{ pen: { x: 65, y: 66 }, pinch: 0.08 }, { pen: { x: 65, y: 66 }, pinch: 0.08 }, { pen: { x: 88, y: 66 }, pinch: 0.08 }, { pen: { x: 88, y: 66 }, pinch: 0.33 }, { pen: { x: 88, y: 66 }, pinch: 0.33 }]))
    const kb = createKeyboard()
    let state = initialKeyboard()
    for (const press of steps.flatMap((s) => s.presses)) [state] = kb.stroke(state, press)
    const [mouse] = kb.stroke(initialKeyboard(), [{ x: 65, y: 66 }, { x: 88, y: 66 }])
    expect(state.text).toBe(mouse.text)
  })
  it('an open palm in the camera wakes, end to end from landmarks', () => {
    // Review #42 survivor: wake was only tested on hand-made features, so a
    // features() that never saw an open palm passed. Fingers straight, thumb
    // away from the index (pinch ratio > 0.6), held still ~1 s.
    const open = (): Hand => {
      const lm: [number, number][] = Array.from({ length: 21 }, () => [300, 300] as [number, number])
      lm[0] = [300, 400] // wrist
      lm[9] = [300, 300] // middle knuckle (palm length 100)
      for (const [pip, tip, x] of [[6, 8, 260], [10, 12, 300], [14, 16, 340], [18, 20, 380]] as const) {
        lm[pip] = [x, 260]
        lm[tip] = [x, 180]
      }
      lm[4] = [170, 300] // thumb out to the side: |4-8| ≈ 148 → ratio ≈ 1.5
      for (const i of [5, 13, 17]) lm[i] = [300, 300]
      return { handedness: 'Right', score: 0.95, lm }
    }
    const steps = run(repeat(40, (i) => ({ t: i * DT, hands: [open()] })))
    expect(steps.flatMap((s) => s.events).filter((e) => e.type === 'wake')).toHaveLength(1)
  })
  it('a wake carries the palm, in table px like every other gesture (#33)', () => {
    // Break caught: the launcher opening in a fixed place, or in keyboard mm
    // read as projector px, instead of near the hand that asked for it.
    const open = (): Hand => {
      const lm: [number, number][] = Array.from({ length: 21 }, () => [300, 300] as [number, number])
      lm[0] = [300, 400]
      for (const [pip, tip, x] of [[6, 8, 260], [10, 12, 300], [14, 16, 340], [18, 20, 380]] as const) {
        lm[pip] = [x, 260]
        lm[tip] = [x, 180]
      }
      lm[4] = [170, 300]
      return { handedness: 'Right', score: 0.95, lm }
    }
    const steps = run(repeat(40, (i) => ({ t: i * DT, hands: [open()] })), keyboardToTable({ xMm: 500, yMm: 400 }, 0.78125))
    const wake = steps.flatMap((s) => s.table).find((e) => e.type === 'wake') as { p?: Pt }
    // The palm is the mean of the wrist (300, 400) and four knuckles at
    // (300, 300): (300, 320) mm. Table px: (500 + 300) / 0.78125 and
    // (400 + 80 + 320) / 0.78125, written out (80 mm: the candidate row above y 0).
    expect(wake.p!.x).toBeCloseTo(1024, 6)
    expect(wake.p!.y).toBeCloseTo(1024, 6)
  })
})

describe('a surface over the keyboard owns its presses (#33, review #48)', () => {
  // The launcher sits over the keys from keyboard x 0..200, y 0..100 (in
  // keyboard mm; the identity table map makes them table px too).
  const I_TABLE = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const covered = (p: Pt) => p.x >= 0 && p.x <= 200 && p.y >= 0 && p.y <= 100
  const runCovered = (fs: Frame[]) => {
    const p = createHandPipeline({ camToKb: I, scale: 1, kbToTable: I_TABLE, covered })
    return fs.map((f) => p.push(f))
  }
  const tapAt = (pen: Pt) => frames([...repeat(4, () => ({ pen, pinch: 0.08 })), ...repeat(2, () => ({ pen, pinch: 0.33 }))])

  it('a tap on a key under the launcher is a surface press, not a keyboard press', () => {
    // Break caught: the keyboard typing the letter under a launcher item
    // while the server's launcher also picked the item.
    const steps = runCovered(tapAt({ x: 65, y: 66 }))
    expect(steps.flatMap((s) => s.presses)).toEqual([])
    expect(steps.flatMap((s) => s.table).map((e) => e.type).filter((t) => t !== 'drag-move')).toEqual(['drag-start', 'drag-end'])
  })
  it('a key outside the launcher still types', () => {
    const steps = runCovered(tapAt({ x: 300, y: 66 }))
    expect(steps.flatMap((s) => s.presses)).toHaveLength(1)
  })
  it('a fast flick from the launcher over the keys ends as a flick the launcher can close on', () => {
    const steps = runCovered(frames([...repeat(4, (i) => ({ pen: { x: 60 + i * 35, y: 66 }, pinch: 0.08 })), ...repeat(2, () => ({ pen: { x: 200, y: 66 }, pinch: 0.33 }))]))
    expect(steps.flatMap((s) => s.presses)).toEqual([])
    expect(steps.flatMap((s) => s.table).find((e) => e.type === 'drag-end')).toMatchObject({ flick: true })
  })
})

describe('two hands: the wake is the open hand\'s', () => {
  it('a wake carries the open hand\'s palm, not the other hand\'s', () => {
    // Break caught (review #48 suspicion): openPalm read from any hand but
    // the palm from the primary (pinching) hand, so the launcher opened by
    // the resting hand instead of the one held open.
    const open = (): Hand => {
      const lm: [number, number][] = Array.from({ length: 21 }, () => [600, 300] as [number, number])
      lm[0] = [600, 400]
      for (const [pip, tip, x] of [[6, 8, 560], [10, 12, 600], [14, 16, 640], [18, 20, 680]] as const) {
        lm[pip] = [x, 260]
        lm[tip] = [x, 180]
      }
      lm[4] = [470, 300]
      return { handedness: 'Left', score: 0.95, lm }
    }
    // The other hand rests curled, half-pinched (never open), at x 100.
    const steps = run(repeat(40, (i) => ({ t: i * DT, hands: [hand({ x: 100, y: 50 }, 0.2), open()] })))
    const wake = steps.flatMap((s) => s.events).find((e) => e.type === 'wake') as { p?: Pt } | undefined
    // The open hand's palm: mean of its wrist (600, 400) and four knuckles at (600, 300).
    expect(wake?.p).toEqual({ x: 600, y: 320 })
  })
})

describe('what reaches the keyboard (continued)', () => {
  it('a swipe whose hand left the camera midway never reaches it', () => {
    // Break caught: half a word typed as a confident wrong word.
    const steps = run(frames([...repeat(8, (i) => ({ pen: { x: 30 + i * 30, y: 66 }, pinch: 0.08 })), ...repeat(12, () => null)]))
    expect(steps.flatMap((s) => s.events).some((e) => e.type === 'stroke')).toBe(true) // the stroke happened…
    expect(steps.flatMap((s) => s.presses)).toEqual([]) // …and was not typed
  })
  it('a drag on the open table is a surface gesture, not a press, and reaches the runtime in table px', () => {
    const toTable = keyboardToTable({ xMm: 500, yMm: 400 }, 0.78125)
    const steps = run(frames([...repeat(6, (i) => ({ pen: { x: 100 + i * 20, y: -300 }, pinch: 0.08 })), ...repeat(2, () => ({ pen: { x: 200, y: -300 }, pinch: 0.33 }))]), toTable)
    expect(steps.flatMap((s) => s.presses)).toEqual([])
    const start = steps.flatMap((s) => s.table).find((e) => e.type === 'drag-start') as { p: Pt }
    // The pinch is confirmed on the 2nd frame (pen at x 120): (500 + 120) /
    // 0.78125 and (400 + 80 - 300) / 0.78125, written out.
    expect(start.p.x).toBeCloseTo(793.6, 6)
    expect(start.p.y).toBeCloseTo(230.4, 6)
  })
})

describe('regions', () => {
  it('candidates win over the keys slack, the text line is nothing, the table is a surface', () => {
    expect(regionAt({ x: 100, y: -20 })).toBe('candidates')
    expect(regionAt({ x: 100, y: 10 })).toBe('keys')
    expect(regionAt({ x: 100, y: -60 })).toBe('none')
    expect(regionAt({ x: 100, y: -200 })).toBe('surface')
  })
})

describe('the keyboard → table map follows the keyboard', () => {
  it('a table gesture after the keyboard moved is mapped with where it is now', () => {
    // Label: synthetic landmark frames. Two drags with the same hand path;
    // between them the keyboard moves 100 px right. Oracle: the shift.
    let shift = 0
    const p = createHandPipeline({ camToKb: I, scale: 1, kbToTable: () => [1, 0, shift, 0, 1, 0, 0, 0, 1] })
    const drag = () => frames([...repeat(3, () => ({ pen: { x: 900, y: 600 }, pinch: 0.08 })), ...repeat(8, (i) => ({ pen: { x: 900 + i * 5, y: 600 }, pinch: 0.08 })), ...repeat(3, () => ({ pen: { x: 935, y: 600 }, pinch: 0.33 }))])
    const xs: number[] = []
    for (const f of drag()) for (const e of p.push(f).table) if (e.type === 'drag-start') xs.push(e.p.x)
    shift = 100
    for (const f of drag()) for (const e of p.push({ ...f, t: f.t + 10_000 }).table) if (e.type === 'drag-start') xs.push(e.p.x)
    // Break caught (review #47): the map captured once, so after the
    // keyboard moved every surface gesture landed 100 px off.
    expect(xs).toHaveLength(2)
    expect(xs[1]! - xs[0]!).toBe(100)
  })
})
