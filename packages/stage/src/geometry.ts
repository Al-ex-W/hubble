import type { Box, SceneObject, Surface } from './scene.ts'

/**
 * Spatial relations between things on the table, all in surface pixels.
 * Pure, so the brain (deciding whether a layout is acceptable) and the
 * renderer agree on every number.
 */

export const area = (b: Box) => Math.max(0, b.w) * Math.max(0, b.h)

export function intersection(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const w = Math.min(a.x + a.w, b.x + b.w) - x
  const h = Math.min(a.y + a.h, b.y + b.h) - y
  return w > 0 && h > 0 ? { x, y, w, h } : null
}

/** Overlap as a fraction of `a`'s area (how much of a is covered). */
export function overlapFraction(a: Box, b: Box): number {
  const i = intersection(a, b)
  return i && area(a) > 0 ? area(i) / area(a) : 0
}

/** Edge-to-edge distance; 0 when they touch or overlap. */
export function gap(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w))
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h))
  return Math.hypot(dx, dy)
}

export type Side = 'right' | 'left' | 'above' | 'below' | 'overlapping'

/** Where `a` sits relative to `of`, by the direction with the clearest separation. */
export function sideOf(a: Box, of: Box): Side {
  if (intersection(a, of)) return 'overlapping'
  const right = a.x - (of.x + of.w)
  const left = of.x - (a.x + a.w)
  const below = a.y - (of.y + of.h)
  const above = of.y - (a.y + a.h)
  const best = Math.max(right, left, below, above)
  return best === right ? 'right' : best === left ? 'left' : best === below ? 'below' : 'above'
}

export function nearestObject(b: Box, objects: SceneObject[]): { object: SceneObject; gap: number } | null {
  let best: { object: SceneObject; gap: number } | null = null
  for (const o of objects) {
    const g = gap(b, o.box)
    if (!best || g < best.gap) best = { object: o, gap: g }
  }
  return best
}

/** How far the box sticks out past the surface edges (0 = fully on it). */
export function offSurface(b: Box, s: Surface, margin = 0): number {
  return (
    Math.max(0, margin - b.x) +
    Math.max(0, margin - b.y) +
    Math.max(0, b.x + b.w - (s.widthPx - margin)) +
    Math.max(0, b.y + b.h - (s.heightPx - margin))
  )
}

/**
 * The order a person reads boxes laid out on a table: top to bottom in rows,
 * left to right within a row. Boxes whose vertical ranges overlap by half the
 * smaller height share a row.
 */
export function readingOrder(boxes: { id: string; box: Box }[]): string[] {
  const sorted = [...boxes].sort((a, b) => a.box.y - b.box.y)
  const rows: { id: string; box: Box }[][] = []
  for (const item of sorted) {
    const row = rows.find((r) =>
      r.some((o) => {
        const ov = Math.min(o.box.y + o.box.h, item.box.y + item.box.h) - Math.max(o.box.y, item.box.y)
        return ov > Math.min(o.box.h, item.box.h) / 2
      }),
    )
    if (row) row.push(item)
    else rows.push([item])
  }
  return rows.flatMap((r) => r.sort((a, b) => a.box.x - b.box.x).map((i) => i.id))
}
