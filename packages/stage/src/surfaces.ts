import type { Box, Surface } from './scene.ts'

/**
 * What is on the table, as one set: the projection OS's window list.
 *
 * Answers, assets, webpages, the swipe keyboard and the launcher all share one
 * projected table. If each renderer decided for itself what is where, a hand
 * tapping the table would have no single answer to "what did I touch", and two
 * things could claim the same spot. So the set lives in one place (the server
 * runtime owns the live one, apps/server/surfaces.ts) and everything else,
 * displays and hit-testing alike, reads it.
 *
 * Called TableSurface because `Surface` is already the projector itself
 * (scene.ts): every spatial module imports that one.
 *
 * Boxes are in surface (projector) px, the same `Box` scene objects, answer
 * panels, overlays and lidar touches use, so hit-testing needs no conversion.
 * Physical sizes are chosen in mm and converted with `pxFromMm` by whoever
 * opens a surface (AGENTS.md rule 5).
 *
 * Every operation is pure and returns a new set (or the same set when nothing
 * changed, so callers can skip publishing): the runtime, the tests and any
 * future client-side prediction share exactly the same rules.
 */
// 'drawing': a free-form SVG the table agent drew (draw_svg). Its own kind,
// not an asset, because an asset is a library file the server owns and serves
// by url, while a drawing is model output carried in the surface's state and
// shown only as an <img> (apps/web drawingRenderer), never inline.
export type SurfaceKind = 'answer' | 'asset' | 'web' | 'keyboard' | 'launcher' | 'drawing'

export interface TableSurface {
  /** Stable id. `answer` is the single answer surface (latest request wins, like the hub). */
  id: string
  kind: SurfaceKind
  /** Where it is, in surface px. Always fully on the table (see clampBox). */
  box: Box
  /** Stacking order; higher is on top. Only the order matters, not the values. */
  z: number
  /** At most one surface has focus: the one input goes to. */
  focused: boolean
  /** Pinned surfaces ignore moves (e.g. something the operator placed on purpose). */
  pinned: boolean
  /** Kind-specific, JSON-safe (it goes over the wire): an answer's renderId and offset, an asset's url. */
  state: Record<string, unknown>
  /**
   * Which opening of this surface this is: new on every open (a re-open
   * after a close, and every new answer, included), unchanged by moves,
   * raises and updates. Ids are reused (every answer is `answer`; an asset
   * closed and reopened keeps `asset-<id>`), so anything that holds on to a
   * surface across time (a hand's grab, #32) must hold this, or it acts on
   * whatever was opened in its place: a pinch held while an asset was closed
   * and reopened flicked the NEW asset away (manager verification of #49).
   * Owned here, where surfaces are opened, so every kind gets it for free.
   */
  instance: number
}

export type SurfaceSet = readonly TableSurface[]

/**
 * Keep a box fully on the table. A surface pushed half off the projection
 * can't be grabbed back by a hand, and a hand is the only way to move it on
 * the day, so "fully on" is the rule. A box bigger than the table is pinned to
 * the top-left rather than shrunk: shrinking would change the content's
 * layout, which belongs to the kind, not to the window list.
 */
function clampBox(b: Box, t: Surface): Box {
  const x = Math.min(Math.max(b.x, 0), Math.max(0, t.widthPx - b.w))
  const y = Math.min(Math.max(b.y, 0), Math.max(0, t.heightPx - b.h))
  return x === b.x && y === b.y ? b : { ...b, x, y }
}

const topZ = (set: SurfaceSet) => set.reduce((m, s) => Math.max(m, s.z), 0)

/**
 * The last instance handed out. Module state on purpose: it must never repeat
 * within a running server, even after the set is emptied (a set-derived max
 * would hand a reopened surface the number its closed predecessor had), and
 * nothing that holds an instance outlives the process.
 */
let lastInstance = 0

/**
 * Open (or re-open) a surface on top, with the focus. The same id replaces the
 * old entry rather than adding a second: the answer surface is re-opened by
 * every render, and two of them would make hit-testing ambiguous.
 */
export function openSurface(set: SurfaceSet, s: Omit<TableSurface, 'z' | 'focused' | 'instance'>, bounds: Surface): SurfaceSet {
  const z = topZ(set) + 1
  const rest = set.filter((x) => x.id !== s.id).map((x) => (x.focused ? { ...x, focused: false } : x))
  return [...rest, { ...s, box: clampBox(s.box, bounds), z, focused: true, instance: ++lastInstance }]
}

export function moveSurface(set: SurfaceSet, id: string, d: { dx: number; dy: number }, bounds: Surface): SurfaceSet {
  const cur = set.find((s) => s.id === id)
  if (!cur || cur.pinned) return set
  const box = clampBox({ ...cur.box, x: cur.box.x + d.dx, y: cur.box.y + d.dy }, bounds)
  if (box.x === cur.box.x && box.y === cur.box.y) return set
  return set.map((s) => (s.id === id ? { ...s, box } : s))
}

/** Bring to the top and give it the focus (what a tap on a surface does). */
export function raiseSurface(set: SurfaceSet, id: string): SurfaceSet {
  const cur = set.find((s) => s.id === id)
  if (!cur) return set
  const z = topZ(set)
  if (cur.z === z && cur.focused && set.filter((s) => s.focused).length === 1) return set
  return set.map((s) => (s.id === id ? { ...s, z: z + 1, focused: true } : s.focused ? { ...s, focused: false } : s))
}

export function closeSurface(set: SurfaceSet, id: string): SurfaceSet {
  return set.some((s) => s.id === id) ? set.filter((s) => s.id !== id) : set
}

/** Change a surface's box, state or pin without touching its stacking. */
export function updateSurface(set: SurfaceSet, id: string, patch: Partial<Pick<TableSurface, 'box' | 'state' | 'pinned'>>, bounds: Surface): SurfaceSet {
  const cur = set.find((s) => s.id === id)
  if (!cur) return set
  const next = { ...cur, ...patch, box: clampBox(patch.box ?? cur.box, bounds) }
  return set.map((s) => (s.id === id ? next : s))
}

/**
 * Which surface is under a point: the topmost whose box contains it, edges
 * included (a fingertip resting exactly on a border still belongs to it).
 * Null when the point is on bare table. Points are in surface px, the frame
 * lidar touches and camera fingertips are already mapped into.
 */
export function hitTest(set: SurfaceSet, p: { x: number; y: number }): string | null {
  let best: TableSurface | null = null
  for (const s of set) {
    const { x, y, w, h } = s.box
    if (p.x < x || p.x > x + w || p.y < y || p.y > y + h) continue
    if (!best || s.z > best.z) best = s
  }
  return best?.id ?? null
}
