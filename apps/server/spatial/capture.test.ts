import { describe, expect, it } from 'vitest'
import type { LidarFrame } from '@hubble/room'
import { buildBaseline } from './baseline.ts'
import { measureFinger } from './capture.ts'
import { tableToSensor, wireFrames, withFinger, withObject } from './lidarFixtures.ts'

/*
 * The registration capture's rulings (docs/plans/2026-10-07-lidar-web.md
 * Ruling 1). Fixtures: the real wire take (recording), with fingers, palms and
 * people put in by mechanical mutation (withFinger / withObject). Oracle: the
 * sensor point each mutation was placed at, computed here.
 */
const frames = wireFrames()
const built = buildBaseline(frames.slice(0, 40))
if (!built.ok) throw new Error(built.reason)
const baseline = built.baseline
const window = (from = 50, n = 15) => frames.slice(from, from + n)
const held = (at: { x: number; y: number }, from = 50) => window(from).map((f) => withFinger(f, at))

describe('measureFinger', () => {
  // Break caught: the capture reporting a point that isn't the finger's
  // (wrong frame, wrong clusters). Before any registration: sensor mm.
  it('a held fingertip: its sensor point, within a few mm', () => {
    const at = tableToSensor({ x: 400, y: 300 })
    const r = measureFinger(held(at), baseline)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Math.hypot(r.sensor.x - at.x, r.sensor.y - at.y)).toBeLessThan(10)
    expect(r.hits).toBe(15)
  })

  // Break caught: capturing "a finger" from an empty table (a stray return,
  // the baseline's noise) would put a nonsense pair into the fit.
  it('no finger: refused', () => {
    expect(measureFinger(window(), baseline)).toMatchObject({ ok: false, reason: 'no-finger' })
  })

  // Break caught: a finger that was there for only part of the capture (a tap,
  // a hand passing over) counted as held. Ruling 1: in ≥ 60 % of rotations.
  it('a finger in only half the rotations: refused as no held finger', () => {
    const at = tableToSensor({ x: 600, y: 400 })
    const half = window().map((f, i) => (i % 2 ? withFinger(f, at) : f))
    expect(measureFinger(half, baseline)).toMatchObject({ ok: false, reason: 'no-finger' })
  })

  // Break caught: two fingers (or a finger and a knuckle) averaged into a
  // point between them. Ruling 1: two clusters in > 20 % of rotations refuse.
  it('two fingers: refused', () => {
    const a = tableToSensor({ x: 400, y: 300 })
    const b = tableToSensor({ x: 900, y: 600 })
    const two = window().map((f) => withFinger(withFinger(f, a), b))
    expect(measureFinger(two, baseline)).toMatchObject({ ok: false, reason: 'two-fingers' })
  })

  // Break caught: a finger sliding during the capture giving the median of a
  // smear. Ruling 1: refuse past 20 mm of spread.
  it('a moving finger: refused', () => {
    const moving = window().map((f, i) => withFinger(f, tableToSensor({ x: 400 + i * 6, y: 300 })))
    expect(measureFinger(moving, baseline)).toMatchObject({ ok: false, reason: 'moving' })
  })

  // Break caught: the span filter lost from the capture path, so a flat hand
  // (80 mm across the beam) counts as the finger.
  it('a palm is not a finger', () => {
    const at = tableToSensor({ x: 500, y: 500 })
    const palm = window().map((f) => withObject(f, at, 80))
    expect(measureFinger(palm, baseline)).toMatchObject({ ok: false, reason: 'no-finger' })
  })

  // Break caught: people standing around the table counting as a second
  // finger and refusing every capture. Past the 1.6 m range cap, they don't.
  it('a finger-sized return beyond the table range is ignored', () => {
    const at = tableToSensor({ x: 400, y: 300 })
    const far = tableToSensor({ x: 775, y: 1900 })
    const withPerson = held(at).map((f) => withFinger(f, far))
    const r = measureFinger(withPerson, baseline)
    expect(r).toMatchObject({ ok: true })
  })

  // Break caught: a capture cut short (a stalled socket) taken as a measurement.
  it('too few rotations: refused', () => {
    const at = tableToSensor({ x: 400, y: 300 })
    expect(measureFinger(held(at).slice(0, 3) as LidarFrame[], baseline)).toMatchObject({ ok: false, reason: 'too-few-rotations' })
  })
})
