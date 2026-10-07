/**
 * Accuracy probe for the camera task reader (#86), on RECORDED frames only:
 * apps/server/fixtures/camera-task-2026-10-07/*.jpg (the room's Brio, 7 Oct
 * 08:36). Calls the real gateway (not room hardware, so allowed any time),
 * runs the exact server pipeline (crop → both models hedged → agreement), and
 * prints, per frame and repeat, whether the read was trusted and whether its
 * maths matches the frame's ground truth.
 *
 *   npx tsx scripts/read-task-probe.ts [repeats=3]
 *
 * Why the iPad box is hand-measured here, not ipadBox(): the recordings were
 * taken before the iPad's spot was taped, and the default spot misses it by
 * ~200 mm (plan, Evidence). The live check pins the real spot.
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { DEFAULT_SURFACE } from '@hubble/stage'
import { createTaskReader, mathKey } from '../apps/server/readTask.ts'
import { RECORDED_IPAD, recordedIpadBox, standardCamera } from '../apps/server/readTask.fixture.ts'

const repeats = Number(process.argv[2] ?? 3)
const key = process.env.HUBBLE_LLM_API_KEY
if (!key) throw new Error('HUBBLE_LLM_API_KEY is not set (.env)')
const llm = { baseUrl: process.env.HUBBLE_LLM_BASE_URL ?? 'https://llm.aiqu.ai/v1', apiKey: key }
let trusted = 0, right = 0, wrongTrusted = 0, n = 0
for (const f of RECORDED_IPAD) {
  for (let r = 0; r < repeats; r++) {
    const reader = createTaskReader({
      frame: async () => readFileSync(f.file),
      calibration: standardCamera,
      region: () => recordedIpadBox(),
      surface: () => DEFAULT_SURFACE,
      llm,
      worksheetTasks: () => [],
    })
    const read = await reader.read()
    n++
    const ok = read.source === 'camera' && read.tasks.length === 1 && mathKey(read.tasks[0]!.text) === mathKey(f.gt.at(-1)!)
    if (read.source === 'camera') trusted++
    if (ok) right++
    if (read.source === 'camera' && !ok) wrongTrusted++
    console.log(JSON.stringify({ frame: f.name, rep: r, source: read.source, ok, ms: read.ms, tasks: read.tasks.map((t) => `${t.n}: ${t.text}`), raw: read.raw, error: read.error }))
  }
}
console.log(JSON.stringify({ reads: n, trusted, rightAndTrusted: right, wrongButTrusted: wrongTrusted }))
