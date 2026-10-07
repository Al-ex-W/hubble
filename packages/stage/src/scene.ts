import type { AssetInfo } from './assets.ts'
/**
 * The physical table, in the projector's own pixels.
 *
 * Everything spatial (where the model may put things, how big text is, where a
 * notebook lies) is expressed against one Surface, so when the room is
 * measured only `DEFAULT_SURFACE` changes.
 *
 * The room as configured on 7 Oct 2026 (organisers' repo 995f275):
 * - the projector is a BenQ LU960 at 1920 × 1200, which is also the `screen`
 *   pi-projector's /status reports (recorded in packages/room/fixtures/pis);
 * - its band on the 1.5 × 1.5 m table is 16:10 and "at most about
 *   1.55 × 0.97 m" (SPEC.md §2).
 *
 * So 1550 / 1920 = 0.807 mm/px across, and 970 / 1200 = 0.808 down: square
 * pixels, as they must be. The earlier 1920 × 1080 over 1.5 m came from the
 * public Draft 0.1 ("16:9, roughly covers"). That left the image's bottom
 * 120 px unused, and made every physical size about 3 % off.
 */

export interface Surface {
  widthPx: number
  heightPx: number
  /** Physical size of one projector pixel on the table. */
  mmPerPx: number
}

export const DEFAULT_SURFACE: Surface = { widthPx: 1920, heightPx: 1200, mmPerPx: 1550 / 1920 }

/** A rectangle in surface pixels. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export type ObjectKind = 'notebook' | 'book' | 'paper' | 'keyboard' | 'cup' | 'phone' | 'tablet' | 'other'

/** Something physical lying on the table, as the camera (or the simulator) sees it. */
export interface SceneObject {
  /** Stable id the model refers to: `near="notebook"`, `target="notebook"`. */
  id: string
  kind: ObjectKind
  label?: string
  box: Box
}

export interface Scene {
  surface: Surface
  objects: SceneObject[]
  /**
   * What the library can show (assets.ts). Filled by the server from its own
   * manifest on every render, never taken from a client: it decides which
   * Asset ids the model may write and where displays fetch them.
   */
  assets?: AssetInfo[]
}

/** Real-world footprints, so simulated objects are as big as the real ones. */
export const OBJECT_SIZE_MM: Record<ObjectKind, { w: number; h: number }> = {
  notebook: { w: 210, h: 297 }, // A4 page
  book: { w: 170, h: 240 },
  paper: { w: 210, h: 297 },
  // The Arturia MiniLab 3 of the piano lesson (#9). UNVERIFIED outer size;
  // measured on site, see packages/room/src/perceive.ts MINILAB_BODY.
  keyboard: { w: 355, h: 220 },
  cup: { w: 90, h: 90 },
  phone: { w: 75, h: 155 },
  // The iPad (A16) the math act's worksheet is shown on (hubble#60): the
  // camera can't read paper well enough on site, so the task moved to a screen
  // we serve. Apple's tech specs: body 248.6 × 179.5 mm. Lying in portrait,
  // like a page. The *body*, not the 227 × 158 mm screen: answers must keep
  // off the bezel too, and a panel on the bezel would shine into the screen.
  tablet: { w: 179.5, h: 248.6 },
  other: { w: 150, h: 150 },
}

export const pxFromMm = (surface: Surface, mm: number) => mm / surface.mmPerPx
export const mmFromPx = (surface: Surface, px: number) => px * surface.mmPerPx

/**
 * Sizes that keep projected text readable while standing at the table. Below
 * ~20 px a glyph at 0.78 mm/px breaks up into visible pixels on cloth, which
 * is what sets the floor, not taste.
 */
export const TYPE_MM = { body: 18.75, small: 14.8, heading: 25, math: 23.4 } as const

export function typeScale(surface: Surface) {
  return {
    body: Math.round(pxFromMm(surface, TYPE_MM.body)),
    small: Math.round(pxFromMm(surface, TYPE_MM.small)),
    heading: Math.round(pxFromMm(surface, TYPE_MM.heading)),
    math: Math.round(pxFromMm(surface, TYPE_MM.math)),
  }
}

/** A comfortable answer panel: about 35–50 cm wide. */
export const PANEL_MM = { min: 300, default: 440, max: 700 } as const
