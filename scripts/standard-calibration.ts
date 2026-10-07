import { readFileSync, writeFileSync } from 'node:fs'
import { DEFAULT_SURFACE } from '@hubble/stage'
import type { H } from '@hubble/room'
import { runCalibration, type Dot } from '../apps/server/calibration.ts'
import { STANDARD_CALIBRATION_FILE } from '../apps/server/standardCalibration.ts'

/**
 * Regenerate `apps/server/calibration.standard.json` from the recording of the
 * good room run (label: recording; fixture `fixtures/calibration-2026-10-07/`).
 *
 * Why a script and not a hand-written file: the committed map must equal a
 * fresh refit of the recording, or it drifts from the code that will actually
 * fit live runs. `standardCalibration.test.ts` re-runs this refit and compares
 * with an explicit bound, so editing the JSON by hand fails the suite.
 *
 * The page origin (Codex review, finding 1): the recording was taken on 7 Oct
 * 06:20Z, when /table was a 1920x1080 page centred on the room's 1920x1200
 * projector — so the page sat 60 px below the projector's top edge. Later that
 * morning (stage 7bb5c00, 08:56) the page became the full DEFAULT_SURFACE
 * 1920x1200, so a map fitted on the 1080 page is 60 px (about 48 mm) off in y.
 * We therefore left-multiply the refit by the translation that recentres the
 * page. That recentring is computed from the manifest's own `pagePx` and
 * DEFAULT_SURFACE, never hard-coded: if either page size changes, the offset
 * follows. H28's `experiments/room-cli/keyboard_scheme_stats.py` records the
 * same fact ("the 1920x1080 /table page sits centred on the 1920x1200
 * projector, y - 60"), and the test pins a recorded dot to its page px + 60.
 *
 * Run inside (or outside) the hardware window: it only reads committed frames,
 * never a device. `npm run calibration:standard`.
 */
const DIR = new URL('../apps/server/fixtures/calibration-2026-10-07/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')) as {
  dots: Dot[]
  frames: string[]
  pagePx: { width: number; height: number }
}

// Left-multiply H by a translation of (tx, ty) px: a point first goes through
// H, then slides. Rows 0 and 1 each gain the translation scaled by H's
// projective row (h[6..8]); row 2 is unchanged. This is T·H, not H·T: the
// offset is in the *destination* (page) frame the map outputs into.
function translate(h: H, tx: number, ty: number): H {
  return [h[0]! + tx * h[6]!, h[1]! + tx * h[7]!, h[2]! + tx * h[8]!, h[3]! + ty * h[6]!, h[4]! + ty * h[7]!, h[5]! + ty * h[8]!, h[6]!, h[7]!, h[8]!]
}

// Replay the recorded frames in the order the run took them, exactly as
// standardCalibration.test.ts does. settleMs 0: no kiosk to wait for; the
// frames are already captured.
function replay() {
  const queue = manifest.frames.map((name) => new Uint8Array(readFileSync(new URL(`${name}.jpg`, DIR))))
  return { frame: async () => queue.shift()!, overlay: () => {} }
}

const run = await runCalibration({ ...replay(), dots: manifest.dots, settleMs: 0 })
if (!run.ok) throw new Error(`the recorded run did not calibrate: ${run.error}`)

// Recentre the recorded page onto today's DEFAULT_SURFACE. Both page sizes are
// centred on the projector, so the offset is half the difference in each axis.
const pageOffsetPx = {
  x: (DEFAULT_SURFACE.widthPx - manifest.pagePx.width) / 2,
  y: (DEFAULT_SURFACE.heightPx - manifest.pagePx.height) / 2,
}
const cameraToProjector = translate(run.h!, pageOffsetPx.x, pageOffsetPx.y)

const standard = {
  // derived from a recording, not a live measurement — see the runtime fallback
  source: 'apps/server/fixtures/calibration-2026-10-07 (recording)',
  cameraToProjector,
  // The geometry the runtime records on a live run: the first frame's size.
  cameraGeometry: run.cameraGeometry ?? { width: 1920, height: 1080 },
  rms: run.rms,
  // The recording's UTC instant, from its manifest. Fixed, not `new Date()`:
  // regenerating the file must be byte-stable so a rebuild is a no-op.
  measuredAt: '2026-10-07T06:20:00Z',
  // Recorded so a reader can see the map was fitted on another page origin.
  pageOffsetPx,
  dots: run.dots,
}
writeFileSync(STANDARD_CALIBRATION_FILE, JSON.stringify(standard, null, 1) + '\n')
console.log(`wrote ${STANDARD_CALIBRATION_FILE}: rms ${run.rms!.toFixed(2)} px, ${run.dots.filter((d) => d.seen).length}/${run.dots.length} dots, ${run.dropped?.length ?? 0} dropped, page offset (${pageOffsetPx.x}, ${pageOffsetPx.y}) px`)
