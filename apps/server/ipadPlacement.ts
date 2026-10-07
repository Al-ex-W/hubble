import { OBJECT_SIZE_MM, pxFromMm, type Box, type Scene, type Surface } from '@hubble/stage'

/**
 * Where the iPad lies on the table, in table (projector) px: the one seam.
 *
 * Where things lie is a spatial fact, and the owner agreed on 7 Oct that one
 * spatial service (H41: camera + lidar + projection → one table coordinate
 * system) owns all of them. It doesn't exist yet (no branch has it, checked
 * 7 Oct). Until it does, this file is the iPad's whole placement, and when
 * it lands, this file is the only thing that changes (plan ruling,
 * docs/plans/2026-10-07-ipad-worksheet.md).
 *
 * The interim answer, best first:
 * 1. the request's own `tablet` object: the bench's to-scale table simulator,
 *    where someone dragged an iPad to see how answers lay out around it
 *    (found by kind, because the bench names objects after their kind);
 * 2. else the fixed spot below, where the iPad is placed on the real table.
 *    That is the owner's "hardcode the detection" (7 Oct, read_card.py), and
 *    on the white table a lit iPad isn't reliably found by brightness anyway.
 */

/**
 * The fixed spot: portrait, its left edge 300 mm in from the table's left,
 * centred front to back. Left of centre so the answer has the wider right
 * side of the table to lay out in (a 44 cm panel beside a 18 cm iPad).
 * UNVERIFIED against the real table's layout; tape the spot on site.
 */
export function defaultIpadBox(surface: Surface): Box {
  const w = pxFromMm(surface, OBJECT_SIZE_MM.tablet.w)
  const h = pxFromMm(surface, OBJECT_SIZE_MM.tablet.h)
  return { x: pxFromMm(surface, 300), y: (surface.heightPx - h) / 2, w, h }
}

/** The id the brain knows the iPad by (`near="ipad"`, `target="ipad"`). */
export const IPAD_ID = 'ipad'

export function ipadBox(scene: Scene | undefined, surface: Surface): Box {
  return scene?.objects.find((o) => o.kind === 'tablet')?.box ?? defaultIpadBox(surface)
}
