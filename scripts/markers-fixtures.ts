/**
 * Step 1 of the marker fixtures (#91): the inputs the composer (Python, cv2)
 * needs, from OUR sources of truth, so the fixtures follow the code's layout:
 * - the camera→table map the RECORDED dot run fits (calibration-2026-10-07);
 * - where layout.ts draws each projected marker;
 * - where the synthetic physical markers sit (chosen here, inside the view).
 *
 * Run: npx tsx scripts/markers-fixtures.ts && python3 scripts/markers-fixtures.py
 * The images are a mechanical mutation of the recorded `off.jpg`: markers
 * composited at the recorded geometry. The truth each test compares against
 * is the homography written here and in the composer's manifest, never what
 * the localizer computes.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { apply } from '@hubble/room'
import { DEFAULT_SURFACE } from '@hubble/stage'
import { runCalibration } from '../apps/server/calibration.ts'
import { inverse } from '../apps/server/spatial/coordinates.ts'
import { PHYSICAL_IDS, PHYSICAL_MM, projectedMarkers } from '../apps/shared/markers/layout.ts'

const rec = 'apps/server/fixtures/calibration-2026-10-07/'
const out = 'apps/server/fixtures/markers-2026-10-07/'
const manifest = JSON.parse(readFileSync(`${rec}manifest.json`, 'utf8'))
const queue = manifest.frames.map((n: string) => new Uint8Array(readFileSync(`${rec}${n}.jpg`)))
const run = await runCalibration({ frame: async () => queue.shift()!, overlay: () => {}, dots: manifest.dots, settleMs: 0 })
if (!run.ok || !run.h) throw new Error(`the recorded dot run no longer fits: ${run.error}`)
const toCamera = inverse(run.h)!
// Along the top and bottom edges, between the projected grid's columns:
// the first try put them in the table corners, where they overlapped the
// projected corner markers' lit margins and hid 4 of them (a layout the room
// should avoid too; the README's placement guide says so). The recorded view
// also cuts the table's far edge at camera x≈0, so true corners are out.
const anchors = [
  { id: PHYSICAL_IDS[0], x: 448, y: 60 },
  { id: PHYSICAL_IDS[1], x: 1472, y: 60 },
  { id: PHYSICAL_IDS[2], x: 1472, y: 1140 },
  { id: PHYSICAL_IDS[3], x: 448, y: 1140 },
]
for (const a of anchors) {
  const c = apply(toCamera, a)
  if (c.x < 80 || c.y < 80 || c.x > 1840 || c.y > 1000) throw new Error(`anchor ${a.id} falls outside the camera view at (${c.x.toFixed(0)},${c.y.toFixed(0)})`)
}
writeFileSync(`${out}inputs.json`, JSON.stringify({
  source: `${rec}off.jpg`,
  cameraToTable: run.h,
  dotRms: run.rms,
  surface: DEFAULT_SURFACE,
  projected: projectedMarkers(DEFAULT_SURFACE),
  physical: { mm: PHYSICAL_MM, sidePx: PHYSICAL_MM / DEFAULT_SURFACE.mmPerPx, anchors },
}, null, 1))
console.log(`inputs written; dot fit rms ${run.rms!.toFixed(2)} table px`)
