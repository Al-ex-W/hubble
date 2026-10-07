import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { apply } from '@hubble/room'
import type { Box } from '@hubble/stage'
import type { CameraCalibration } from './readTask.ts'
import { STANDARD_CALIBRATION_FILE } from './standardCalibration.ts'

/**
 * Recorded room frames for the camera task reader (#86), shared by its test
 * and scripts/read-task-probe.ts.
 *
 * Provenance: recording. experiments/room-cli/focus/ (gitignored), the room's
 * Brio on pi-projector, 7 Oct 08:36, focus 0. The iPad lies upside down on the
 * right panel showing the worksheet; final1/final2 are 1080p, f0 is 4K.
 * Ground truth: the worksheet manifest's lines for the task it showed (the
 * #86 research, prep.py).
 */
const dir = fileURLToPath(new URL('./fixtures/camera-task-2026-10-07/', import.meta.url))

export const RECORDED_IPAD = [
  { name: 'final1', file: `${dir}final1.jpg`, gt: ['Beräkna integralen:', '∫ x·eˣ dx'] },
  { name: 'final2', file: `${dir}final2.jpg`, gt: ['Beräkna integralen:', '∫ x·eˣ dx'] },
  { name: 'f0-4k', file: `${dir}f0.jpg`, gt: ['Lös ekvationen:', '5(2x - 3) = 4x + 9'] },
]

/**
 * The iPad's outer bezel corners in final1.jpg, camera px at 1080p, measured
 * by hand on the frame (7 Oct). The same spot in every frame (the iPad wasn't
 * moved during the focus sweep; f0 is the same view at 4K).
 */
export const RECORDED_IPAD_CORNERS_CAM = [
  { x: 1428, y: 338 },
  { x: 1578, y: 338 },
  { x: 1578, y: 545 },
  { x: 1428, y: 545 },
]

export const standardCamera = (): CameraCalibration => {
  const c = JSON.parse(readFileSync(STANDARD_CALIBRATION_FILE, 'utf8')) as { cameraToProjector: number[]; cameraGeometry: { width: number; height: number } }
  return { h: c.cameraToProjector, width: c.cameraGeometry.width, height: c.cameraGeometry.height }
}

/** The iPad's box in table px: the measured corners through the committed calibration. */
export function recordedIpadBox(): Box {
  const h = standardCamera().h
  const pts = RECORDED_IPAD_CORNERS_CAM.map((p) => apply(h, p))
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}
