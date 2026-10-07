/**
 * The projected keyboard's geometry, in millimetres on the table, measured from
 * the keyboard's top-left corner.
 *
 * Millimetres, not pixels, because the thing that has to fit is a fingertip:
 * a projected key gives no tactile edge, so it must be wide enough that a
 * finger tracked to ±1 cm by the camera still lands inside it. #10 sets the
 * floor at 40 mm; 44 mm keeps the whole board (~44 × 18 cm) inside the near
 * strip of the lit area, in reach without leaning.
 */

export const KEY_MM = 44

export type KeyKind = 'letter' | 'space' | 'delete' | 'send'

export interface Key {
  id: string
  label: string
  kind: KeyKind
  x: number
  y: number
  w: number
  h: number
}

export interface Pt {
  x: number
  y: number
}

export interface Layout {
  width: number
  height: number
  keys: Key[]
  /** The centre of a letter's key: the point a perfect swipe passes through. */
  centre: (letter: string) => Pt
  /** The key under a point, or null between and outside keys. */
  keyAt: (p: Pt) => Key | null
}

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']
// Half-key stagger per row, as on a physical QWERTY board, so a swipe's shape
// matches the one a phone user's hand already knows.
const STAGGER = [0, 0.5, 1]

export function buildLayout(): Layout {
  const keys: Key[] = []
  ROWS.forEach((row, r) => {
    for (let i = 0; i < row.length; i++) {
      const ch = row[i]!
      keys.push({ id: ch, label: ch, kind: 'letter', x: (STAGGER[r]! + i) * KEY_MM, y: r * KEY_MM, w: KEY_MM, h: KEY_MM })
    }
  })
  // Delete sits where backspace does on a phone: the end of the z row.
  keys.push({ id: 'delete', label: 'delete', kind: 'delete', x: 8 * KEY_MM, y: 2 * KEY_MM, w: 2 * KEY_MM, h: KEY_MM })
  keys.push({ id: 'space', label: 'space', kind: 'space', x: 1.5 * KEY_MM, y: 3 * KEY_MM, w: 5.5 * KEY_MM, h: KEY_MM })
  keys.push({ id: 'send', label: 'send', kind: 'send', x: 7.5 * KEY_MM, y: 3 * KEY_MM, w: 2.5 * KEY_MM, h: KEY_MM })

  const byLetter = new Map(keys.filter((k) => k.kind === 'letter').map((k) => [k.id, k]))
  return {
    width: 10 * KEY_MM,
    height: 4 * KEY_MM,
    keys,
    centre(letter) {
      const k = byLetter.get(letter)
      if (!k) throw new Error(`no key for ${JSON.stringify(letter)}`)
      return { x: k.x + k.w / 2, y: k.y + k.h / 2 }
    },
    keyAt(p) {
      return keys.find((k) => p.x >= k.x && p.x < k.x + k.w && p.y >= k.y && p.y < k.y + k.h) ?? null
    },
  }
}
