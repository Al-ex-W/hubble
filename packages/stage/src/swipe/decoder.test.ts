import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLayout, KEY_MM, type Pt } from './layout.ts'
import { createDecoder } from './decoder.ts'
import { LEXICON } from './lexicon.ts'

/*
 * Fixture provenance: MECHANICAL MUTATION OF LAYOUT TEMPLATES. Each swipe is
 * the polyline through a word's key centres with every corner missed by up
 * to `jitterMm` (seeded), sampled every 4 mm with hand tremor on top, and an
 * optional whole-word shift. No real finger made these; the bench records
 * real swipes into window.hubbleSwipes and they should replace these once
 * there are some. Until then these test the matcher, not the feel.
 */

const layout = buildLayout()
const decoder = createDecoder(layout, LEXICON)

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function swipe(word: string, seed: number, jitterMm = 12, shift: Pt = { x: 0, y: 0 }): Pt[] {
  const r = rng(seed)
  const off = (m: number) => {
    const a = r() * Math.PI * 2
    const d = Math.sqrt(r()) * m
    return { x: Math.cos(a) * d, y: Math.sin(a) * d }
  }
  const letters = [...word].filter((c, i) => c !== word[i - 1])
  const corners = letters.map((c) => {
    const p = layout.centre(c)
    const o = off(jitterMm)
    return { x: p.x + o.x + shift.x, y: p.y + o.y + shift.y }
  })
  const path: Pt[] = []
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1]!
    const b = corners[i]!
    const steps = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 4))
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      const n = off(2)
      path.push({ x: a.x + (b.x - a.x) * t + n.x, y: a.y + (b.y - a.y) * t + n.y })
    }
  }
  path.push(corners[corners.length - 1]!)
  return path
}

const top = (path: Pt[]) => decoder.decode(path).map((c) => c.word)

describe('swipe decoder', () => {
  it('reads the demo phrase and the math words from sloppy swipes', () => {
    for (const word of ['hello', 'hubble', 'math', 'solve', 'the', 'integral', 'explain', 'next']) {
      for (let seed = 1; seed <= 20; seed++) {
        const got = top(swipe(word, seed))
        expect(got, `${word} seed ${seed}`).toContain(word)
      }
    }
  })

  it('puts the intended word first for nearly all common words', () => {
    // The 300 commonest words of 3+ letters: what a chat turn is made of.
    const words = LEXICON.filter((w) => w.length >= 3).slice(0, 300)
    let first = 0
    let inTop3 = 0
    words.forEach((w, i) => {
      const got = top(swipe(w, 1000 + i))
      if (got[0] === w) first++
      if (got.includes(w)) inTop3++
    })
    expect(first / words.length).toBeGreaterThan(FIRST_RATE)
    expect(inTop3 / words.length).toBeGreaterThan(TOP3_RATE)
  })

  it('still reads words swiped off-centre, the way a hand drifts on a flat surface', () => {
    // The whole word drawn ~0.4 key right and ~0.3 key down. Location alone
    // now misleads (every key centre is off), so this is the test that needs
    // the shape channel and the frequency prior: without shape the top-1
    // rate measured 0.84, without the prior 0.75; with both, 0.927.
    const words = LEXICON.filter((w) => w.length >= 3).slice(0, 300)
    let first = 0
    let inTop3 = 0
    words.forEach((w, i) => {
      const got = top(swipe(w, 1000 + i, 8, { x: 18, y: 14 }))
      if (got[0] === w) first++
      if (got.includes(w)) inTop3++
    })
    expect(first / words.length).toBeGreaterThan(0.9)
    expect(inTop3 / words.length).toBeGreaterThan(0.98)
  })

  it('never offers a word that starts or ends far from where the swipe did', () => {
    // A candidate from the other side of the board reads as the keyboard not
    // listening, whatever its score. Measured with the prune removed: the
    // recorded "julie" stroke offered "hope" and "type", and 125 of the 400
    // commonest words' exact templates had such a word in their top 3.
    // Fixtures: the four RECORDED strokes (fixtures/IMG_3537.strokes.json)
    // and the exact key-centre polylines (MECHANICAL, layout templates).
    const rec = JSON.parse(readFileSync(join(__dirname, 'fixtures/IMG_3537.strokes.json'), 'utf8')) as { strokes: { points: Pt[] }[] }
    const templates = LEXICON.filter((w) => w.length >= 2)
      .slice(0, 400)
      .map((w) => [...w].filter((c, i) => c !== w[i - 1]).map((c) => layout.centre(c)))
    const paths = [...rec.strokes.map((s) => s.points), ...templates]
    expect(paths).toHaveLength(404) // corpus pin
    for (const path of paths) {
      const start = path[0]!
      const end = path[path.length - 1]!
      for (const c of decoder.decode(path)) {
        const first = layout.centre(c.word[0]!)
        const last = layout.centre(c.word[c.word.length - 1]!)
        // Break caught: the start/end prune removed (far words leak into the top 3).
        expect(Math.hypot(first.x - start.x, first.y - start.y), `${c.word} start`).toBeLessThanOrEqual(1.5 * KEY_MM)
        expect(Math.hypot(last.x - end.x, last.y - end.y), `${c.word} end`).toBeLessThanOrEqual(1.5 * KEY_MM)
      }
    }
  })

  it('reads a short press as a tap on that key', () => {
    const p = layout.centre('k')
    expect(decoder.decode([p, { x: p.x + 3, y: p.y + 2 }])).toEqual([{ word: 'k', score: 0 }])
  })

  it('ignores a tap that lands between or beside the letters', () => {
    expect(decoder.decode([{ x: -KEY_MM, y: -KEY_MM }])).toEqual([])
  })
})

// Measured on this fixture set when the weights were chosen; the margin
// below each is the slack for harmless reordering of near-identical paths.
const FIRST_RATE = 0.95 // measured 0.983
const TOP3_RATE = 0.99 // measured 1.0
