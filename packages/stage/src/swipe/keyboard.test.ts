import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createKeyboard, initialKeyboard, type KeyboardState } from './keyboard.ts'
import type { Pt } from './layout.ts'

/*
 * The keyboard model's text-editing rules.
 *
 * Fixtures:
 * - fixtures/IMG_3537.strokes.json, label: RECORDING. Four real pinch-swipes
 *   from a top-down iPhone video of a hand over the printed keyboard, taken
 *   through the hands lab's MediaPipe → homography → pinch pipeline into
 *   keyboard mm, extracted mechanically (see its meta). The oracle is what
 *   the person was asked to write ("my name is julie"), not the decoder.
 * - Everything else, label: SYNTHETIC: single points at key centres, computed
 *   here by plain arithmetic on the 44 mm grid (not layout.centre), and a
 *   hand-made tremble.
 */

const kb = createKeyboard()
const K = 44
// Key centres in keyboard mm, from the grid itself: row r starts at y = r·K,
// staggered 0 / 0.5 / 1 key; delete spans x 8K–10K on row 2; space 1.5K–7K
// and send 7.5K–10K on row 3.
const at = {
  a: { x: 0.5 * K + K / 2, y: K + K / 2 },
  i: { x: 7 * K + K / 2, y: K / 2 },
  delete: { x: 9 * K, y: 2.5 * K },
  space: { x: 4.25 * K, y: 3.5 * K },
  send: { x: 8.75 * K, y: 3.5 * K },
}
// Candidate slots sit 38 to 8 mm above the keys (keys start 80 mm below the
// widget top, candidates at 42–72 mm).
const slot = (i: 0 | 1 | 2): Pt => ({ x: (i + 0.5) * ((10 * K) / 3), y: -23 })

const run = (strokes: Pt[][], s: KeyboardState = initialKeyboard()) => {
  const outs = []
  for (const p of strokes) {
    const [next, out] = kb.stroke(s, p)
    s = next
    outs.push(out)
  }
  return { s, outs }
}
const tap = (p: Pt) => [p]

const rec = JSON.parse(readFileSync(join(__dirname, 'fixtures/IMG_3537.strokes.json'), 'utf8')) as {
  meta: { label: string; truth: string }
  strokes: { points: Pt[] }[]
}

describe('keyboard model: a real recorded hand', () => {
  it('writes "my name is julie" from the four recorded swipes, then sends it', () => {
    expect(rec.meta.label).toBe('recording')
    // Corpus pin: a shrinking fixture must fail loudly, not pass on less.
    expect(rec.strokes).toHaveLength(4)
    const { s, outs } = run(rec.strokes.map((w) => w.points))
    // Break caught: words joined without spaces, or a swipe judged a tap.
    expect(s.text).toBe(rec.meta.truth)
    expect(outs.every((o) => o.kind === 'word')).toBe(true)
    const [after, sent] = kb.stroke(s, tap(at.send))
    expect(sent).toEqual({ kind: 'sent', text: 'my name is julie' })
    // Break caught: the text line keeping the message after send (it would be sent twice).
    expect(after).toEqual(initialKeyboard())
  })
})

describe('keyboard model: editing rules', () => {
  it('delete after a swipe takes back the whole word; after a tapped letter, one character', () => {
    const swiped = run(rec.strokes.slice(0, 2).map((w) => w.points)).s // "my name"
    // Break caught: delete after a swipe taking one letter ("my nam").
    expect(run([tap(at.delete)], swiped).s.text).toBe('my')
    const tapped = run([tap(at.a), tap(at.i)], swiped).s // "my nameai"
    // Break caught: delete after a tap taking the whole word.
    expect(run([tap(at.delete)], tapped).s.text).toBe('my namea')
  })

  it('space never doubles and never leads', () => {
    // Break caught: an accidental second tap leaving "a  " (no feel on a projected key).
    expect(run([tap(at.space), tap(at.a), tap(at.space), tap(at.space)]).s.text).toBe('a ')
  })

  it('send with nothing written sends nothing', () => {
    const [s, out] = kb.stroke(initialKeyboard(), tap(at.send))
    // Break caught: an empty chat turn (a model call and a "?" on the table).
    expect(out).toEqual({ kind: 'none' })
    expect(s).toEqual(initialKeyboard())
    expect(kb.stroke({ ...initialKeyboard(), text: '   ' }, tap(at.send))[1]).toEqual({ kind: 'none' })
  })

  it('a tap on a candidate slot swaps it in for the last swiped word: middle = best, left = second', () => {
    const { s } = run(rec.strokes.slice(0, 2).map((w) => w.points)) // "my name", candidates for "name"
    expect(s.candidates.length).toBeGreaterThanOrEqual(2)
    const second = s.candidates[1]!.word
    const [left, out] = kb.stroke(s, tap(slot(0)))
    // Break caught: slots read left-to-right as 0,1,2 (the middle is the best word).
    expect(out).toEqual({ kind: 'choose', word: second })
    // Break caught: choosing replacing more than the last word, or appending.
    expect(left.text).toBe(`my ${second}`)
    // The chosen word is now the best, so the middle slot keeps it.
    expect(kb.stroke(left, tap(slot(1)))[0].text).toBe(`my ${second}`)
  })

  it('the right slot is the third candidate, and a tap beside the row chooses nothing', () => {
    const { s } = run(rec.strokes.slice(0, 2).map((w) => w.points))
    expect(s.candidates.length).toBe(3)
    // Break caught: the right slot mapped to the best word.
    expect(kb.stroke(s, tap(slot(2)))[1]).toEqual({ kind: 'choose', word: s.candidates[2]!.word })
    // Level with the candidate row but left of the widget: a hand off the keyboard.
    // Break caught: the row's x bounds dropped (an off-widget tap swaps words).
    expect(kb.stroke(s, tap({ x: -20, y: -23 }))[1]).toEqual({ kind: 'none' })
    expect(kb.stroke(s, tap({ x: 10 * K + 20, y: -23 }))[1]).toEqual({ kind: 'none' })
  })

  it('a trembling press on SEND is a tap, not a swipe', () => {
    // 30 samples zig-zagging ±8 mm around the key centre: about 0.5 m of path,
    // never more than 12 mm from where the pen went down.
    const tremble = Array.from({ length: 30 }, (_, i) => ({ x: at.send.x + (i % 2 ? 8 : -8), y: at.send.y + (i % 3) * 2 }))
    const [, out] = kb.stroke({ ...initialKeyboard(), text: 'hello' }, [at.send, ...tremble])
    // Break caught: taps judged by path length (the tremble would decode as a word).
    expect(out).toEqual({ kind: 'sent', text: 'hello' })
  })

  it('a stroke that starts above the keys writes nothing', () => {
    // A hand sweeping down over the text line and candidates onto the keys.
    const pass = Array.from({ length: 20 }, (_, i) => ({ x: 200, y: -70 + i * 8 }))
    const [s, out] = kb.stroke(initialKeyboard(), pass)
    // Break caught: decoding a pass over the widget into an unasked-for word.
    expect(out).toEqual({ kind: 'none' })
    expect(s.text).toBe('')
  })
})
