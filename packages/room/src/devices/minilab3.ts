/**
 * Where each key of an Arturia MiniLab 3 is, given where its keybed is.
 *
 * The lesson needs to light *the* key the user should press, on the real
 * keyboard. Detecting 25 individual slim keys in a camera frame under
 * projector light is fragile (review #11: ~12 px per key at 1080p); finding
 * the keybed once is not. The rest is known geometry: 25 keys = 15 white keys
 * of equal width, black keys in the 2-3 piano pattern. So the keybed's four
 * corners (from OpenCV, or two calibration taps on the outer keys) fully
 * determine every key's box.
 *
 * UNVERIFIED until our unit is on the table: the lowest note with the octave
 * buttons at 0 (assumed C3 = MIDI 48, 25 keys up to C5 = 72) and the black
 * keys' exact length (assumed 62 % of the white keys'). The lesson matches
 * MIDI note numbers, so an octave shift only moves `lowestNote`.
 */
export interface Point {
  x: number
  y: number
}

export interface KeyQuad {
  note: number
  black: boolean
  /** Corners in projector px: near-left, near-right, far-right, far-left (near = the player's edge). */
  corners: [Point, Point, Point, Point]
}

export interface Keybed {
  /** Four corners of the keybed in projector px, same order as KeyQuad corners. */
  corners: [Point, Point, Point, Point]
  lowestNote: number
}

export const MINILAB3 = { keys: 25, whiteKeys: 15, blackLength: 0.62, blackWidth: 0.58, defaultLowest: 48 } as const

const BLACK_PC = new Set([1, 3, 6, 8, 10])
const isBlack = (note: number) => BLACK_PC.has(((note % 12) + 12) % 12)

/** Bilinear point on the keybed: u across (0 left → 1 right), v along a key (0 near → 1 far). */
function at(k: Keybed, u: number, v: number): Point {
  const [nl, nr, fr, fl] = k.corners
  const near = { x: nl.x + (nr.x - nl.x) * u, y: nl.y + (nr.y - nl.y) * u }
  const far = { x: fl.x + (fr.x - fl.x) * u, y: fl.y + (fr.y - fl.y) * u }
  return { x: near.x + (far.x - near.x) * v, y: near.y + (far.y - near.y) * v }
}

export function keyQuads(k: Keybed): KeyQuad[] {
  const out: KeyQuad[] = []
  const W = 1 / MINILAB3.whiteKeys
  let white = 0
  for (let i = 0; i < MINILAB3.keys; i++) {
    const note = k.lowestNote + i
    if (!isBlack(note)) {
      const u0 = white * W
      out.push({ note, black: false, corners: [at(k, u0, 0), at(k, u0 + W, 0), at(k, u0 + W, 1), at(k, u0, 1)] })
      white++
    } else {
      // A black key straddles the boundary between the white key before it and the next.
      const c = white * W
      const half = (W * MINILAB3.blackWidth) / 2
      const v0 = 1 - MINILAB3.blackLength
      out.push({ note, black: true, corners: [at(k, c - half, v0), at(k, c + half, v0), at(k, c + half, 1), at(k, c - half, 1)] })
    }
  }
  return out
}
