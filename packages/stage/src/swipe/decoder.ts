import { KEY_MM, type Layout, type Pt } from './layout.ts'

/**
 * Turns a swipe across the projected keys into words: a SHARK²-style
 * template matcher (Kristensson & Zhai, 2004).
 *
 * Every word has an ideal path, the polyline through its letters' key
 * centres. A swipe is compared with each ideal path on two channels:
 * - location: how far apart the two paths are on the board, so "it" and
 *   "or" (similar shapes, different places) are told apart;
 * - shape: how different they look once both are centred and scaled to the
 *   same size, so a swipe drawn too small or too far left still matches.
 * A word's frequency breaks the remaining ties ("the" over "thee").
 *
 * Chosen over a learned model (#10 names FUTO Swipe) because it needs no
 * download and no runtime, and works on day one with no training swipes. Its
 * weak spot is long words with many near-collinear letters; the top 3 cover it.
 */

export interface Candidate {
  word: string
  score: number
}

export interface Decoder {
  decode: (path: Pt[]) => Candidate[]
}

// Both paths are compared point by point, so both get the same number of
// equally spaced points. 32 is enough for a 10-letter word's corners and
// keeps a full-lexicon pass well under a frame.
const N = 32
// A swipe must start and end near its word's first and last letters: people
// aim those, and the middle is where swipes drift. Wider than one key so a
// sloppy start at the key's edge still counts. This is a speed guard more
// than an accuracy one (location already penalises far-away words): it cuts
// a decode from ~17 ms to ~2 ms, which is what keeps live candidates smooth.
const END_SLACK_MM = 1.5 * KEY_MM
// Shorter than this, a press is a tap on one key, not a swipe.
export const TAP_MM = 0.5 * KEY_MM
// Weights found against the jittered templates in decoder.test.ts: shape
// counts double because location is already in key units and noisier.
const SHAPE_WEIGHT = 2
const PRIOR_WEIGHT = 0.06

interface Template {
  word: string
  rank: number
  first: Pt
  last: Pt
  points: Pt[]
  shape: Pt[]
}

export function createDecoder(layout: Layout, words: string[]): Decoder {
  const templates: Template[] = []
  const seen = new Set<string>()
  words.forEach((raw, rank) => {
    const word = raw.trim().toLowerCase()
    if (!/^[a-z]+$/.test(word) || seen.has(word)) return
    seen.add(word)
    // A double letter is one key, so "hello" traces h-e-l-o (a repeated
    // centre adds no length, so the path is the same either way); counting
    // distinct keys is what finds words with no path at all ("a", "i", "aa"),
    // which only a tap can produce.
    const letters = [...word].filter((c, i) => c !== word[i - 1])
    if (letters.length < 2) return
    const keys = letters.map((c) => layout.centre(c))
    const points = resample(keys, N)
    templates.push({ word, rank, first: keys[0]!, last: keys[keys.length - 1]!, points, shape: normalise(points) })
  })

  return {
    decode(path) {
      if (path.length === 0) return []
      if (length(path) < TAP_MM) {
        const key = layout.keyAt(path[0]!)
        return key?.kind === 'letter' ? [{ word: key.id, score: 0 }] : []
      }
      const start = path[0]!
      const end = path[path.length - 1]!
      const points = resample(path, N)
      const shape = normalise(points)
      const scored: Candidate[] = []
      for (const t of templates) {
        if (dist(start, t.first) > END_SLACK_MM || dist(end, t.last) > END_SLACK_MM) continue
        const location = meanDist(points, t.points) / KEY_MM
        const form = meanDist(shape, t.shape)
        scored.push({ word: t.word, score: location + SHAPE_WEIGHT * form + PRIOR_WEIGHT * Math.log(t.rank + 1) })
      }
      return scored.sort((a, b) => a.score - b.score).slice(0, 3)
    },
  }
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function length(path: Pt[]): number {
  let total = 0
  for (let i = 1; i < path.length; i++) total += dist(path[i - 1]!, path[i]!)
  return total
}

function meanDist(a: Pt[], b: Pt[]): number {
  let total = 0
  for (let i = 0; i < a.length; i++) total += dist(a[i]!, b[i]!)
  return total / a.length
}

/** `n` points spaced evenly along the polyline, ends included. */
export function resample(path: Pt[], n: number): Pt[] {
  const total = length(path)
  if (total === 0) return Array.from({ length: n }, () => ({ ...path[0]! }))
  const step = total / (n - 1)
  const out: Pt[] = [{ ...path[0]! }]
  let carried = 0
  for (let i = 1; i < path.length && out.length < n; i++) {
    let a = path[i - 1]!
    const b = path[i]!
    let seg = dist(a, b)
    while (carried + seg >= step && out.length < n) {
      const t = (step - carried) / seg
      a = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      out.push(a)
      seg = dist(a, b)
      carried = 0
    }
    carried += seg
  }
  // Floating-point shortfall can leave the last point out; it is the end.
  while (out.length < n) out.push({ ...path[path.length - 1]! })
  return out
}

/** Centred on its centroid and scaled so its longer side is 1. */
function normalise(points: Pt[]): Pt[] {
  let cx = 0
  let cy = 0
  for (const p of points) {
    cx += p.x
    cy += p.y
  }
  cx /= points.length
  cy /= points.length
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1
  return points.map((p) => ({ x: (p.x - cx) / size, y: (p.y - cy) / size }))
}
