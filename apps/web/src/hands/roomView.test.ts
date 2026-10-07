import { describe, expect, it } from 'vitest'
import { createRoomSwitch, FULL, mirrorFor, observationFor, viewFor } from './roomView.ts'
import type { Hand } from './types.ts'

/**
 * Room-camera landmarks leaving the browser, cropped (#84). Label:
 * schema-derived. The server body is GET /api/camera/roi's shape, and the
 * hand is MediaPipe's 21 points in image px. Oracle: plain offset arithmetic
 * by the Pi's snapped crop (camera.py's rule, checked in roi.test.ts).
 */
const SERVER = { roi: { x: 0.123, y: 0.47, w: 0.2, h: 0.21 }, crop: { x: 224, y: 496, w: 400, h: 240 }, frame: { width: 1920, height: 1080, geometry: 'room:full-frame' } }
// A hand with distinct points so a wrong index shows up: point i = (i, 100 + i).
const hand: Hand = { handedness: 'Right', score: 0.9, lm: Array.from({ length: 21 }, (_, i) => [i, 100 + i] as [number, number]) }
const cropped = { videoWidth: 400, videoHeight: 240 }
const meta = { session: 's', seq: 1, capturedAt: 10, input: undefined }

describe('room view from the server', () => {
  it('opens the cropped stream with exactly the fractions it maps with', () => {
    // Break caught: requesting one rectangle and mapping with another.
    const v = viewFor(SERVER)
    expect(v.url).toBe('/api/camera/stream?roi=0.123,0.47,0.2,0.21')
    expect(v.crop).toEqual({ x: 224, y: 496, w: 400, h: 240 })
  })

  it('falls back to the full frame on no keyboard or a malformed answer', () => {
    // Break caught: a null roi (no keyboard yet) opening "?roi=null" or throwing.
    expect(viewFor({ roi: null })).toEqual(FULL)
    expect(viewFor({ roi: { x: 2, y: 0, w: 1, h: 1 }, frame: SERVER.frame })).toEqual(FULL)
    expect(viewFor(null)).toEqual(FULL)
  })
})

describe('what leaves the browser, cropped', () => {
  it('the spatial observation carries full-frame points and the full-frame size', () => {
    // Breaks caught: landmarks sent in crop px (typing at the wrong key), and
    // the crop's 400x240 reported as the frame size (the spatial service
    // refuses it: it only accepts the calibrated 1920x1080).
    const o = observationFor([hand], cropped, viewFor(SERVER), meta)!
    expect(o.width).toBe(1920)
    expect(o.height).toBe(1080)
    expect(o.geometry).toBe('room:full-frame')
    expect(o.hands[0]!.index).toEqual({ x: 224 + 8, y: 496 + 108 })
    expect(o.hands[0]!.pinch).toEqual({ thumb: { x: 228, y: 600 }, wrist: { x: 224, y: 596 }, middle: { x: 233, y: 605 } })
  })

  it('the hands mirror carries every landmark in full-frame px and the full-frame size', () => {
    // Break caught: the operator's camera view drawing the hand over the full
    // frame from crop coordinates (a hand in the wrong corner).
    const m = mirrorFor([hand], cropped, viewFor(SERVER), true)!
    expect([m.width, m.height]).toEqual([1920, 1080])
    expect(m.hands[0]!.lm[20]).toEqual([224 + 20, 496 + 120])
    expect(m.pinch).toBe(true)
  })

  it('sends nothing when the video is not the crop asked for', () => {
    // Break caught: guessing a scale when the Pi sends another size (another
    // camera mode, or a crop changed under us): typing at the wrong key.
    expect(observationFor([hand], { videoWidth: 1920, videoHeight: 1080 }, viewFor(SERVER), meta)).toBeNull()
    expect(mirrorFor([hand], { videoWidth: 800, videoHeight: 480 }, viewFor(SERVER), false)).toBeNull()
  })

  it('without a crop, sends the video as it is (today\'s full-frame behaviour)', () => {
    // Break caught: the crop path changing the full-frame path it falls back to.
    const o = observationFor([hand], { videoWidth: 1920, videoHeight: 1080 }, FULL, meta)!
    expect([o.width, o.height]).toEqual([1920, 1080])
    expect(o.hands[0]!.index).toEqual({ x: 8, y: 108 })
  })
})

describe('createRoomSwitch: the crop and its stream change together, newest reopen wins', () => {
  const A = viewFor({ roi: { x: 0.4, y: 0.2, w: 0.3, h: 0.3 }, frame: { width: 1920, height: 1080, geometry: 'room:full-frame' } })
  const B = viewFor({ roi: { x: 0.1, y: 0.5, w: 0.3, h: 0.3 }, frame: { width: 1920, height: 1080, geometry: 'room:full-frame' } })

  it('swaps the view and the stream as one, and hands the old stream back to stop', () => {
    // Break caught (review of #85, a surviving mutation): the stream switched
    // but the view left on the old crop. Same-size crops at another origin
    // pass every size check, and each landmark is then mapped with the old
    // offset: typing on the wrong key after the keyboard moves.
    const swaps: [string, string | null, string | null][] = []
    const sw = createRoomSwitch<string>((v, cam, prev) => swaps.push([v.url, cam, prev]))
    expect(sw.commit(sw.begin(), A, 'streamA')).toBe(true)
    expect(sw.commit(sw.begin(), B, 'streamB')).toBe(true)
    expect(sw.view.url).toBe(B.url)
    expect(sw.cam).toBe('streamB')
    expect(swaps).toEqual([
      [A.url, 'streamA', null],
      [B.url, 'streamB', 'streamA'],
    ])
  })

  it('refuses a slower, older reopen that finishes after a newer one', () => {
    // Break caught (review of #85): the keyboard moves to A, then B; B's
    // stream opens first, then A's lands and overwrites it, so the crop shows
    // where the keyboard WAS and the hand drops out of view.
    const sw = createRoomSwitch<string>(() => {})
    const toA = sw.begin()
    const toB = sw.begin()
    expect(sw.commit(toB, B, 'streamB')).toBe(true)
    expect(sw.commit(toA, A, 'streamA')).toBe(false)
    expect(sw.view.url).toBe(B.url)
    expect(sw.cam).toBe('streamB')
  })

  it('after a reset (tracker stopped) no earlier reopen can land', () => {
    // Break caught: a reopen still in flight when the tracker stops, then
    // reviving a stream nobody owns.
    const sw = createRoomSwitch<string>(() => {})
    const t = sw.begin()
    sw.reset()
    expect(sw.commit(t, A, 'late')).toBe(false)
    expect(sw.cam).toBeNull()
    expect(sw.view).toBe(FULL)
  })
})
