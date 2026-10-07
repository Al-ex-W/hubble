import { describe, expect, it } from 'vitest'
import { lessonCues, midiToHz, type LessonView } from './pianoSound.ts'

// Provenance: schema-derived. The lesson snapshots have the shape of
// /api/operator/status's `lesson` (apps/web/src/operator/status.ts).
const L = (index: number, expected: number | null, song = 'Twinkle'): LessonView => ({ song, index, total: 3, expected })

describe('midiToHz', () => {
  // Catches a wrong reference pitch or a semitone off-by-one: the oracle is
  // the standard tuning table, not the formula.
  it('maps A4, middle C and A5 to their concert pitches', () => {
    expect(midiToHz(69)).toBe(440)
    expect(midiToHz(60)).toBeCloseTo(261.63, 2)
    expect(midiToHz(81)).toBe(880)
  })
})

describe('lessonCues', () => {
  // Catches a missing start hint (the owner's first rule).
  it('hints the first note when a lesson starts', () => {
    expect(lessonCues(null, L(0, 60), null)).toEqual([{ kind: 'hint', note: 60 }])
  })
  // Catches hinting the pressed note instead of the NEW expected one.
  it('hints the next note after a correct press', () => {
    expect(lessonCues(L(0, 60), L(1, 62), 60)).toEqual([{ kind: 'hint', note: 62 }])
  })
  // Catches a silent wrong press: bonk, then what they should have played.
  it('bonks and replays the expected note after a wrong press', () => {
    expect(lessonCues(L(1, 62), L(1, 62), 64)).toEqual([{ kind: 'bonk' }, { kind: 'hint', note: 62 }])
  })
  // Catches a double hint: the poll that lands after the press-driven fetch sees no change.
  it('says nothing when a poll sees no change', () => {
    expect(lessonCues(L(1, 62), L(1, 62), null)).toEqual([])
  })
  it('blips when the song completes', () => {
    expect(lessonCues(L(2, 64), L(3, null), 64)).toEqual([{ kind: 'blip' }])
  })
})
