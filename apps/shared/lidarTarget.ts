import type { OverlayLine, OverlayShape, Surface } from '@hubble/stage'

/**
 * The lidar registration wizard's target on /table (#lidar-wizard): one big
 * white dot, a ring around it and the words "hold a finger here", all light
 * on the white table (black is no light; at 12:20 on 7 Oct the owner stood at
 * a black table with no idea where to put a finger).
 *
 * Shared by the server (which publishes it) and the display (which draws
 * the label and drops the layer when its lease runs out), so the layer name
 * and the lease can't drift between the two.
 */
export const LIDAR_TARGET_LAYER = 'lidar-target'

/**
 * The same lease as the reference grid (shared/markers/layout.ts): the
 * server re-sends the target every refresh, the display drops it when no
 * refresh came within the TTL. A server that dies mid-run must not leave a
 * white dot on a projector we share with other teams.
 */
export const LIDAR_TARGET_REFRESH_MS = 2000
export const LIDAR_TARGET_TTL_MS = 5000

/**
 * Real sizes (AGENTS.md rule 5): a 40 mm dot is a fingertip's target from a
 * standing person's height; the ring at 60 mm makes it read as "a target"
 * rather than a stray light; the label is 14 mm, readable from 1.5 m.
 */
export const TARGET_MM = { dot: 40, ringR: 60, ringStroke: 5, label: 14 } as const

/** An overlay line with the text the display writes under the dot. The stage protocol has no text shape; the extra field rides through the hub as JSON. */
export type LidarTargetLine = OverlayLine & { label?: string }

const circle = (c: { x: number; y: number }, r: number, n = 48) =>
  Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((i * 2 * Math.PI) / n), y: c.y + r * Math.sin((i * 2 * Math.PI) / n) }))

export function lidarTargetLine(at: { x: number; y: number }, surface: Pick<Surface, 'mmPerPx'>, label: string): LidarTargetLine {
  const px = (mm: number) => mm / surface.mmPerPx
  const dot: OverlayShape = { points: circle(at, px(TARGET_MM.dot / 2)), color: '#ffffff' }
  // A ring as ONE polygon: the outer loop, then the inner loop the other way
  // round. Under SVG's default nonzero fill the opposite winding cancels and
  // leaves the hole; the zero-width seam between the loops doesn't show.
  const outer = circle(at, px(TARGET_MM.ringR + TARGET_MM.ringStroke / 2))
  const inner = circle(at, px(TARGET_MM.ringR - TARGET_MM.ringStroke / 2)).reverse()
  const ring: OverlayShape = { points: [...outer, outer[0]!, ...inner, inner[0]!], color: '#ffffff' }
  return { kind: 'overlay', layer: LIDAR_TARGET_LAYER, shapes: [dot, ring], label }
}
