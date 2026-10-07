import { DEFAULT_SURFACE, type Box, type Scene } from '@hubble/stage'

/**
 * Glue between the bench's simulated table and the rest of the system: the
 * same facts the room's camera and lidar will produce, derived from the
 * simulator's objects.
 *
 * keybedFromBox must agree with the simulator's MiniLab drawing and with
 * packages/room's MINILAB_BODY (keybed at 2–98 % of the width, 50–96 % of the
 * depth from the far edge), or the light lands beside the keys.
 */
export function keybedFromBox(b: Box) {
  const x = (u: number) => b.x + u * b.w
  const y = (v: number) => b.y + v * b.h
  // near-left, near-right, far-right, far-left (near = the player's edge).
  return [
    { x: x(0.02), y: y(0.96) },
    { x: x(0.98), y: y(0.96) },
    { x: x(0.98), y: y(0.5) },
    { x: x(0.02), y: y(0.5) },
  ]
}

// Heights above the cloth, mm: what the lidar's ~3 cm beam can or can't see.
// A notebook is invisible to it; the MiniLab's body (~5 cm) and a cup are not.
const HEIGHT: Record<string, number> = { notebook: 5, paper: 2, book: 25, keyboard: 50, cup: 100, phone: 9, other: 60 }

/** Simulator objects (projector px) → emulator shapes (table mm, lit area centred in depth). */
export function emulatorShapes(scene: Scene) {
  const mm = scene.surface.mmPerPx ?? DEFAULT_SURFACE.mmPerPx
  const top = (1500 - scene.surface.heightPx * mm) / 2
  return scene.objects.map((o) => ({ kind: 'rect', x: o.box.x * mm, y: top + o.box.y * mm, w: o.box.w * mm, h: o.box.h * mm, heightMm: HEIGHT[o.kind] ?? 60 }))
}
