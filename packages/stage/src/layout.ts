import { PANEL_MM, mmFromPx, pxFromMm, type Box, type Scene, type SceneObject, type Surface } from './scene.ts'

/**
 * Turns the model's spatial requests into boxes on the table.
 *
 * The model owns the layout: it says where a panel goes (x/y, or beside an
 * object). This module only enforces what the room makes non-negotiable, and
 * otherwise leaves the request alone:
 * - everything stays on the projected surface;
 * - panels never cover a physical object (projected light on a notebook makes
 *   it unreadable for the user and blinds the camera reading it);
 * - panels don't land on top of each other;
 * - widths stay within what reads well at table distance.
 * Pure and deterministic, so the guard is tested rather than eyeballed.
 */

/**
 * Clearances on the table, in millimetres. They used to be fixed pixels
 * (30 px from the edge, 40 px from objects) while type was already in mm, so
 * a projector with more pixels over the same table shrank every gap while the
 * text stayed the same size, and the same answer passed or failed differently.
 * The values are the pixels they were tuned as on the surface of the time
 * (1920 px over 1.5 m, 0.78125 mm/px), converted once.
 *
 * Pinned to that tuning surface, not to DEFAULT_SURFACE: they are physical
 * gaps, and when DEFAULT_SURFACE became the room's real 1920 × 1200 over
 * 1.55 m (7 Oct), converting through it silently widened every gap by 3 %
 * and changed recorded layout diagnoses that nobody had re-judged.
 */
const TUNED_ON: Surface = { widthPx: 1920, heightPx: 1080, mmPerPx: 1500 / 1920 }
export const CLEARANCE_MM = {
  /** Keep panels this far inside the projected edge (the image is soft and keystoned there). */
  edge: mmFromPx(TUNED_ON, 30),
  /** Gap the model is told to leave between a panel and an object it sits beside. */
  object: mmFromPx(TUNED_ON, 40),
  /** Resolution of the search for a clear spot when the asked one is blocked. */
  searchStep: mmFromPx(TUNED_ON, 20),
} as const

/** The clearances in this surface's pixels. */
export function clearances(surface: Surface) {
  return {
    edge: pxFromMm(surface, CLEARANCE_MM.edge),
    object: pxFromMm(surface, CLEARANCE_MM.object),
    searchStep: pxFromMm(surface, CLEARANCE_MM.searchStep),
  }
}

export interface PanelRequest {
  x?: number
  y?: number
  w?: number
  near?: string
  side?: 'right' | 'left' | 'above' | 'below'
}

/**
 * - `as-asked`: the request was valid and is used exactly.
 * - `moved`: the guard moved or resized it to a clear spot.
 * - `no-room`: there is no clear spot of this size; the box returned is the
 *   asked one, pulled onto the surface, and still overlaps something. It is
 *   returned rather than nothing because a slightly covered notebook is the
 *   lesser evil than dropping the answer, but callers that must not overlap
 *   (the brain's repair hints) have to be able to tell. It used to be folded
 *   into `adjusted: true`, indistinguishable from a fine move.
 */
export type PlacementStatus = 'as-asked' | 'moved' | 'no-room'

export interface Placement extends Box {
  status: PlacementStatus
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const inflate = (b: Box, d: number): Box => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d })
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))

export function findObject(scene: Scene, id: string | undefined): SceneObject | undefined {
  return id ? scene.objects.find((o) => o.id === id) : undefined
}

/** Width a request resolves to, after the readable-width limits. */
export function panelWidth(req: PanelRequest, scene: Scene): { w: number; wanted: number } {
  const { surface } = scene
  const { edge } = clearances(surface)
  const maxW = Math.min(pxFromMm(surface, PANEL_MM.max * 2), surface.widthPx - 2 * edge)
  const minW = Math.min(pxFromMm(surface, PANEL_MM.min), maxW)
  const wanted = req.w ?? pxFromMm(surface, PANEL_MM.default)
  return { w: clamp(wanted, minW, maxW), wanted }
}

/** Where a request of width `w` and height `h` lands, before any guard. */
function boxFor(req: PanelRequest, scene: Scene, w: number, h: number): Box {
  const { edge, object: gapPx } = clearances(scene.surface)
  const anchor = findObject(scene, req.near)
  if (req.x !== undefined && req.y !== undefined) return { x: req.x, y: req.y, w, h }
  if (anchor) {
    const o = anchor.box
    switch (req.side ?? 'right') {
      case 'left':
        return { x: o.x - gapPx - w, y: o.y, w, h }
      case 'above':
        return { x: o.x + o.w / 2 - w / 2, y: o.y - gapPx - h, w, h }
      case 'below':
        return { x: o.x + o.w / 2 - w / 2, y: o.y + o.h + gapPx, w, h }
      default:
        return { x: o.x + o.w + gapPx, y: o.y, w, h }
    }
  }
  return { x: req.x ?? edge, y: req.y ?? edge, w, h }
}

/**
 * Exactly the box the model asked for, before any guard, at the width it
 * wrote. The layout report judges this, so feedback to the model is about
 * *its* choice, not about what the guard quietly fixed. The width used to be
 * clamped to the readable range first, which meant `w={250}` never got a
 * too-narrow warning and an over-wide panel was judged at a width that fit.
 */
export function requestedBox(req: PanelRequest, scene: Scene, estimatedHeight: number): Box {
  return boxFor(req, scene, panelWidth(req, scene).wanted, estimatedHeight)
}

/**
 * @param taken boxes of panels already placed, so a later panel avoids them
 * @param estimatedHeight best guess of the panel's height (content streams in,
 *   so the real height is unknown when it is placed)
 */
export function placePanel(req: PanelRequest, scene: Scene, taken: Box[], estimatedHeight: number): Placement {
  const { surface } = scene
  const { edge, object: gapPx, searchStep } = clearances(surface)
  const { w, wanted } = panelWidth(req, scene)
  const h = Math.min(estimatedHeight, surface.heightPx - 2 * edge)
  // Positions relative to an object use the width that will render, so a
  // clamped panel still sits the right gap away from what it is beside.
  const { x, y } = boxFor(req, scene, w, h)

  const fit = (px: number, py: number): Box => ({
    x: clamp(px, edge, surface.widthPx - edge - w),
    y: clamp(py, edge, surface.heightPx - edge - h),
    w,
    h,
  })
  const blockers = [...scene.objects.map((o) => inflate(o.box, gapPx / 2)), ...taken.map((b) => inflate(b, gapPx / 4))]
  const clear = (b: Box) => !blockers.some((k) => overlaps(b, k))

  const asked = fit(x, y)
  const moved = asked.x !== x || asked.y !== y || w !== wanted
  if (clear(asked)) return { ...asked, status: moved ? 'moved' : 'as-asked' }

  // Nearest clear spot to what was asked for, searched on a coarse grid. The
  // nearest one keeps the model's intent (beside the notebook stays beside it).
  let best: Box | null = null
  let bestD = Infinity
  for (let gy = edge; gy <= surface.heightPx - edge - h; gy += searchStep) {
    for (let gx = edge; gx <= surface.widthPx - edge - w; gx += searchStep) {
      const b = { x: gx, y: gy, w, h }
      if (!clear(b)) continue
      const d = (gx - asked.x) ** 2 + (gy - asked.y) ** 2
      if (d < bestD) {
        bestD = d
        best = b
      }
    }
  }
  return best ? { ...best, status: 'moved' } : { ...asked, status: 'no-room' }
}

/**
 * Maps Canvas anchor/size (the implicit panel for content written straight in
 * the Canvas) to a panel request against the real scene.
 *
 * Current, not legacy: anchor/size is in the catalog and the prompt, and 30 of
 * the 42 recorded stage streams use it, so this path renders real answers.
 *
 * Known quirk, kept on purpose: `top` and `center` both fall to the default
 * (horizontally centred, one inset from the top edge), so anchor="top" lands
 * exactly like anchor="center". Changing where `center` goes would move every
 * recorded answer that relies on it, and making `top` differ would need a
 * reason the recordings don't give yet; the day of the demo is not the time.
 */
export function implicitPanelRequest(attrs: Record<string, unknown>, scene: Scene): PanelRequest {
  const sizeMm = { small: 340, medium: PANEL_MM.default, large: 560, full: 900 }[String(attrs.size ?? 'medium')] ?? PANEL_MM.default
  const w = pxFromMm(scene.surface, sizeMm)
  // Three edge clearances in from the corner: physical, like the clearance.
  const inset = clearances(scene.surface).edge * 3
  const anchor = String(attrs.anchor ?? 'center')
  const m = /^(right-of|left-of|above|below):(.+)$/.exec(anchor)
  if (m && findObject(scene, m[2])) {
    const side = { 'right-of': 'right', 'left-of': 'left', above: 'above', below: 'below' }[m[1]] as PanelRequest['side']
    return { near: m[2], side, w }
  }
  const W = scene.surface.widthPx
  switch (anchor) {
    case 'left':
      return { x: inset, y: inset, w }
    case 'right':
      return { x: W - w - inset, y: inset, w }
    case 'bottom':
      return { x: (W - w) / 2, y: scene.surface.heightPx * 0.55, w }
    default:
      return { x: (W - w) / 2, y: inset, w }
  }
}

export interface Point {
  x: number
  y: number
}

/** The point on a box's edge facing `toward`, so arrows start at a border, not a center. */
export function edgePoint(b: Box, toward: Point): Point {
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const sx = dx === 0 ? Infinity : b.w / 2 / Math.abs(dx)
  const sy = dy === 0 ? Infinity : b.h / 2 / Math.abs(dy)
  const s = Math.min(sx, sy)
  return { x: cx + dx * s, y: cy + dy * s }
}

export type EndpointTarget = { kind: 'point'; point: Point } | { kind: 'box'; box: Box }

/**
 * Resolves an Arrow endpoint: "#panelId", "objectId", "objectId@u,v", or "x,y".
 * Returns null for anything unresolvable, so a bad reference draws nothing
 * rather than an arrow to the corner of the table. A point must be finite and
 * on the projected surface: the number pattern used to be `[\d.]+`, so
 * "1..2,3" resolved to NaN, and an off-table point resolved too; both passed
 * the layout report and drew an arrow to nowhere.
 */
export function resolveEndpoint(ref: string, scene: Scene, panels: Map<string, Box>): EndpointTarget | null {
  const s = ref.trim()
  if (s.startsWith('#')) {
    const b = panels.get(s.slice(1))
    return b ? { kind: 'box', box: b } : null
  }
  const NUM = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)`
  const onSurface = (p: Point): EndpointTarget | null =>
    Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x <= scene.surface.widthPx && p.y <= scene.surface.heightPx
      ? { kind: 'point', point: p }
      : null
  const at = new RegExp(`^([\\w-]+)@(${NUM}),\\s*(${NUM})$`).exec(s)
  if (at) {
    const o = findObject(scene, at[1])
    return o ? onSurface({ x: o.box.x + Number(at[2]) * o.box.w, y: o.box.y + Number(at[3]) * o.box.h }) : null
  }
  // Anything else with an @ is a malformed object point, not an object id.
  if (s.includes('@')) return null
  const xy = new RegExp(`^(${NUM}),\\s*(${NUM})$`).exec(s)
  if (xy) return onSurface({ x: Number(xy[1]), y: Number(xy[2]) })
  const o = findObject(scene, s)
  return o ? { kind: 'box', box: o.box } : null
}

/** A box in object-relative coordinates (u, v = center; w, h = fractions). */
export function objectRect(o: SceneObject, u = 0.5, v = 0.5, w = 0.5, h = 0.12): Box {
  return { x: o.box.x + (u - w / 2) * o.box.w, y: o.box.y + (v - h / 2) * o.box.h, w: w * o.box.w, h: h * o.box.h }
}
