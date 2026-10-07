import { describe, expect, it } from 'vitest'
import { keyQuads, MINILAB3 } from '@hubble/room'
import { createLesson, SONGS } from './lesson.ts'

/** Label: schema-derived (the song is the spec; MIDI note numbers are the input). */
describe('createLesson', () => {
  it('advances only on the right key and reports wrong keys without moving on', () => {
    const l = createLesson(SONGS['ode-to-joy'])
    expect(l.expected()).toBe(64)
    expect(l.press(65)).toEqual({ kind: 'wrong', expected: 64, got: 65 })
    // Break caught: a wrong press skipping ahead, so the user can never recover.
    expect(l.expected()).toBe(64)
    expect(l.press(64)).toMatchObject({ kind: 'correct', done: false })
    expect(l.expected()).toBe(64) // the song repeats E: same key stays lit
  })

  it('finishes after the last note', () => {
    const l = createLesson({ title: 't', notes: [60, 62] })
    l.press(60)
    expect(l.press(62)).toMatchObject({ kind: 'correct', done: true })
    expect(l.expected()).toBeNull()
  })

  it('names the key after the expected one, and none on the last note', () => {
    const l = createLesson({ title: 't', notes: [60, 60, 62] })
    // Break caught: upcoming returning the expected note itself (index, not index + 1).
    expect(l.upcoming()).toBe(60)
    l.press(60)
    expect(l.upcoming()).toBe(62)
    l.press(60)
    // Break caught: a "next" marker on the last note, pointing past the song.
    expect(l.upcoming()).toBeNull()
    l.press(62)
    expect(l.upcoming()).toBeNull()
  })

  it('every song fits on the MiniLab from its default lowest note', () => {
    for (const s of Object.values(SONGS))
      for (const n of s.notes) expect(n >= MINILAB3.defaultLowest && n < MINILAB3.defaultLowest + MINILAB3.keys).toBe(true)
  })
})

describe('keyQuads (MiniLab 3)', () => {
  const bed = { corners: [{ x: 0, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 0 }, { x: 0, y: 0 }] as never, lowestNote: 48 }
  it('lays out 25 keys, 15 white and 10 black, left to right', () => {
    const q = keyQuads(bed)
    expect(q.length).toBe(25)
    expect(q.filter((k) => !k.black).length).toBe(15)
    const whiteLefts = q.filter((k) => !k.black).map((k) => k.corners[0].x)
    expect(whiteLefts).toEqual([...whiteLefts].sort((a, b) => a - b))
  })
  it('puts each black key on the boundary between its two white neighbours', () => {
    const q = keyQuads(bed)
    const cs = q.find((k) => k.note === 49)! // C#3
    const c = q.find((k) => k.note === 48)!
    const d = q.find((k) => k.note === 50)!
    const mid = (cs.corners[0].x + cs.corners[1].x) / 2
    expect(Math.abs(mid - c.corners[1].x)).toBeLessThan(0.5)
    expect(mid).toBeLessThan(d.corners[1].x)
    // Black keys are on the far (raised) part only.
    expect(cs.corners[0].y).toBeLessThan(100)
  })
})
