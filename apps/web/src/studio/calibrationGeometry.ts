import { DEFAULT_SURFACE, pxFromMm, type Surface } from '@hubble/stage'

/**
 * Where everything on the calibration pattern goes, from one Surface.
 *
 * AGENTS.md rule 5: the pattern exists to CHECK the surface's mm/px against a
 * tape measure, so it must not carry any pixel constant of its own. Every
 * position here is millimetres converted by `pxFromMm(surface, mm)`; if the
 * surface's mm/px is wrong, the pattern is wrong in exactly the way the room
 * is, which is what the person measuring wants to see. (The corner markers and
 * the border are the exception on purpose: they are about the frame's PIXELS,
 * to show whether the projector crops or scales the image.)
 *
 * Only the pure numbers live here so tests read them without rendering.
 */
export { DEFAULT_SURFACE }
export type { Surface }

/** Pixels of the frame border: it must occupy exactly the outermost two pixel rows/columns. */
export const BORDER_PX = 2

/** The ruler bars, mm. The printed claim and the drawn length must be this same number. */
export const RULER_MM = 200

/**
 * Tape marks of Julius's lidar takes (scripts/lidar-session/takes.ts on
 * origin/feat/lidar-touch, plan 2026-10-07-lidar-touch.md): 3 x 3, inset about
 * 150 mm from the projection edge, numbered 1-9 in reading order as seen by the
 * person at the FRONT edge. Table mm has its origin at the image's top-left and
 * the lidar sits on the BACK edge, which is the image's top: so 1-3 is the top
 * row (far, near the lidar), 7-9 the bottom row. Mark 2 is the one closest to
 * the lidar, 8 the farthest. If his takes change, change MARK_INSET_MM and the
 * numbering here, in this one place.
 */
export const MARK_INSET_MM = 150

export interface Mark { n: number; mmX: number; mmY: number; px: number; py: number }
export interface GridLine { mm: number; px: number; major: boolean }
export interface Corner { label: string; x: number; y: number; edgeX: number; edgeY: number; sx: 1 | -1; sy: 1 | -1 }
export interface Ruler { mm: number; lengthPx: number; x: number; y: number; orientation: 'h' | 'v' }

export function patternGeometry(surface: Surface = DEFAULT_SURFACE) {
  const { widthPx, heightPx, mmPerPx } = surface
  const widthMm = widthPx * mmPerPx
  const heightMm = heightPx * mmPerPx
  const px = (mm: number) => pxFromMm(surface, mm)

  const lines = (extentMm: number): GridLine[] => {
    const out: GridLine[] = []
    // Integer mm steps: 100 * k never accumulates float error the way a running sum would.
    for (let k = 0; k * 100 <= extentMm; k++) out.push({ mm: k * 100, px: px(k * 100), major: (k * 100) % 500 === 0 })
    return out
  }

  const marks: Mark[] = []
  for (let n = 1; n <= 9; n++) {
    const col = (n - 1) % 3
    const row = Math.floor((n - 1) / 3)
    const mmX = MARK_INSET_MM + (col * (widthMm - 2 * MARK_INSET_MM)) / 2
    const mmY = MARK_INSET_MM + (row * (heightMm - 2 * MARK_INSET_MM)) / 2
    marks.push({ n, mmX, mmY, px: px(mmX), py: px(mmY) })
  }

  // The last pixel is width-1, so the corner labels print 1919 / 1199.
  const lastX = widthPx - 1
  const lastY = heightPx - 1
  const corners: Corner[] = [
    { label: '0,0', x: 0, y: 0, edgeX: 0, edgeY: 0, sx: 1, sy: 1 },
    { label: `${lastX},0`, x: lastX, y: 0, edgeX: widthPx, edgeY: 0, sx: -1, sy: 1 },
    { label: `${lastX},${lastY}`, x: lastX, y: lastY, edgeX: widthPx, edgeY: heightPx, sx: -1, sy: -1 },
    { label: `0,${lastY}`, x: 0, y: lastY, edgeX: 0, edgeY: heightPx, sx: 1, sy: -1 },
  ]

  // Rulers sit between the mark rows so no tape or label is hidden by them.
  const rulers: Ruler[] = [
    { mm: RULER_MM, lengthPx: px(RULER_MM), x: px(300), y: px(320), orientation: 'h' },
    { mm: RULER_MM, lengthPx: px(RULER_MM), x: px(1150), y: px(250), orientation: 'v' },
  ]

  return {
    widthPx, heightPx, mmPerPx, widthMm, heightMm,
    centre: { x: Math.floor(widthPx / 2), y: Math.floor(heightPx / 2) },
    vertical: lines(widthMm), horizontal: lines(heightMm),
    marks, corners, rulers, px,
  }
}
