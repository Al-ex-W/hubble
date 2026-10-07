import type { OverlayShape } from '@hubble/stage'

/**
 * The reference-marker contract (#91): which markers exist, where the
 * projected ones are drawn, and how they are drawn. The ONE owner of marker
 * ids and positions: the overlay that projects them, the detector's id
 * whitelist and the localizer's correspondences all read this file, so the
 * place a marker is drawn and the place the fit thinks it was drawn cannot
 * drift apart (that drift would be a confident, wrong camera map).
 *
 * Family: ArUco 4×4 (OpenCV DICT_4X4_1000, the same code list js-aruco2
 * ships). Why 4×4: the fewest cells per marker, so the biggest cells for a
 * given size. The room camera arrives JPEG-compressed at 2–5 fps and sees
 * ~0.78 camera px per table px (the recorded dot run); the iPad on a stand is
 * further away still. Bigger cells survive both. The cost is a small code
 * space (a 16-bit code is easier to hallucinate), so detections are kept
 * only for the ids below, and the fit's RANSAC drops what's left.
 */

export type Pt = { x: number; y: number }
export type Corners = [Pt, Pt, Pt, Pt]

/** js-aruco2's name for OpenCV's DICT_4X4_1000. */
export const DICTIONARY = 'ARUCO_4X4_1000'

/** Overlay layer of the projected markers. OverlayLayer.tsx draws it crisp (no glow, full opacity). */
export const REFERENCE_LAYER = 'reference'

/**
 * The reference grid is a lease, not a state (Codex review of #95, finding 3).
 * The server re-sends the grid every REFERENCE_REFRESH_MS while a run is on
 * (spatial/reference.ts), and a display drops it once REFERENCE_TTL_MS pass
 * with no refresh (OverlayLayer.tsx). Why: a clear only reaches a display
 * the server is alive to send it to. If the server dies or the Wi-Fi drops
 * mid-run, the projector would otherwise keep 12 markers on a table the
 * organisers and other teams share, past our hardware window, until someone
 * reloads the kiosk. TTL > 2× refresh so one late or lost refresh (SSE over
 * the venue Wi-Fi) doesn't blink the grid off mid-run.
 */
export const REFERENCE_REFRESH_MS = 2000
export const REFERENCE_TTL_MS = 5000

/**
 * Projected marker ids, one per point of a 4×3 grid: the same grid shape as
 * the dot calibration (calibration.ts bootDots), more than 4 so a hand over
 * a few still leaves a good fit, spread so the map holds at the edges.
 */
export const PROJECTED_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const

/**
 * Printed markers, one near each table corner. A different id range from
 * the projected ones, so a projected marker can never be mistaken for a
 * printed one (their positions come from different owners: the layout here,
 * the learned anchors there).
 */
export const PHYSICAL_IDS = [40, 41, 42, 43] as const

/**
 * Table px per marker cell. 20 px = 16 mm at DEFAULT_SURFACE's 0.807 mm/px,
 * ~15 camera px per cell on the recorded room view; js-aruco2 reads a marker
 * from a 49 px warp (~8 px per cell), so there is headroom for the iPad being
 * further away. Bigger hides more of the table, but only for the seconds a
 * reference run shows them.
 */
export const CELL_PX = 20
/** 4 data cells + the black border on each side. */
export const MARKER_CELLS = 6
/** The lit margin around each marker: ArUco finds the black border as a dark square on a light ground. */
export const QUIET_CELLS = 1
/** Printed size of the physical markers (black square edge), mm. */
export const PHYSICAL_MM = 60

const GRID_X = 4
const GRID_Y = 3
const INSET = 0.1

/** Corners clockwise from the marker's own top-left: OpenCV's (and js-aruco2's) corner order. */
export function square(cx: number, cy: number, side: number): Corners {
  const h = side / 2
  return [
    { x: cx - h, y: cy - h },
    { x: cx + h, y: cy - h },
    { x: cx + h, y: cy + h },
    { x: cx - h, y: cy + h },
  ]
}

export interface Marker {
  id: number
  corners: Corners
}

/** Where each projected marker is drawn, in table px. */
export function projectedMarkers(surface: { widthPx: number; heightPx: number }): Marker[] {
  const side = CELL_PX * MARKER_CELLS
  const out: Marker[] = []
  for (let gy = 0; gy < GRID_Y; gy++) {
    for (let gx = 0; gx < GRID_X; gx++) {
      const cx = Math.round(INSET * surface.widthPx + (gx / (GRID_X - 1)) * (1 - 2 * INSET) * surface.widthPx)
      const cy = Math.round(INSET * surface.heightPx + (gy / (GRID_Y - 1)) * (1 - 2 * INSET) * surface.heightPx)
      out.push({ id: PROJECTED_IDS[gy * GRID_X + gx]!, corners: square(cx, cy, side) })
    }
  }
  return out
}

/**
 * The marker's bits as the dictionary has them: 16 chars, row-major from the
 * marker's top-left, '1' = white cell. The detector module supplies them
 * (it owns the dictionary), so this file stays free of js-aruco2.
 */
export type Bits = (id: number) => string

const rect = (x: number, y: number, w: number, h: number, color: string): OverlayShape => ({
  points: [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ],
  color,
})

/**
 * Overlay shapes for the projected markers, painted in order: the lit quiet
 * zone, the black marker square over it, then the white data cells. Black is
 * drawn explicitly (not left out) because whatever else is on the table
 * under the overlay (an answer, the keyboard) is light too, and would
 * otherwise fill the "black" cells.
 */
export function markerShapes(markers: Marker[], bits: Bits): OverlayShape[] {
  const shapes: OverlayShape[] = []
  for (const m of markers) {
    const x0 = m.corners[0].x
    const y0 = m.corners[0].y
    const side = CELL_PX * MARKER_CELLS
    const q = CELL_PX * QUIET_CELLS
    shapes.push(rect(x0 - q, y0 - q, side + 2 * q, side + 2 * q, '#ffffff'))
    shapes.push(rect(x0, y0, side, side, '#000000'))
    const code = bits(m.id)
    for (let i = 0; i < 16; i++) {
      if (code[i] !== '1') continue
      shapes.push(rect(x0 + CELL_PX * (1 + (i % 4)), y0 + CELL_PX * (1 + Math.floor(i / 4)), CELL_PX, CELL_PX, '#ffffff'))
    }
  }
  return shapes
}
