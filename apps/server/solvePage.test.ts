import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SURFACE } from '@hubble/stage'
import { createTaskReader } from './readTask.ts'
import { RECORDED_IPAD, recordedIpadBox, standardCamera } from './readTask.fixture.ts'
import { readForSolve } from './solvePage.ts'

/**
 * One press of "Solve the page", end to end up to the intent, on recorded
 * data: the real room frame f0 (readTask.fixture.ts, recording) cropped by the
 * real cropPage, and the real gateway answers on crops of that frame
 * (fixtures/camera-task-2026-10-07/answers.json, recording) as the vision seam.
 * Demo-day light: one test file (plan 2026-10-07-solve-page.md).
 */
const answers = JSON.parse(readFileSync(new URL('./fixtures/camera-task-2026-10-07/answers.json', import.meta.url), 'utf8')) as {
  answers: { model: string; case: string; input: string; text: string }[]
}
const recorded = (input: string) => (model: string) => answers.answers.find((a) => a.case === 'ipad-f0' && a.input === input && a.model === model)!.text
const f0 = RECORDED_IPAD.find((f) => f.name === 'f0-4k')!
const IPAD = [{ n: 1, text: 'Lös ekvationen: | 5(2x - 3) = 4x + 9' }]

function reader(ask: (model: string) => Promise<string>, worksheet = IPAD) {
  return createTaskReader({
    frame: async () => readFileSync(f0.file),
    calibration: standardCamera,
    region: () => recordedIpadBox(),
    surface: () => DEFAULT_SURFACE,
    llm: null,
    worksheetTasks: () => worksheet,
    ask: (m) => ask(m),
  })
}

describe('solve the page on the recorded f0 frame', () => {
  // Catches: a trusted camera read not becoming the intent (or one tagged as the iPad's).
  it('both models agree (upscaled crop answers) → solves what the camera read', async () => {
    const r = await readForSolve({ reader: reader(async (m) => recorded('up')(m)), worksheetTasks: () => IPAD })
    expect(r.source).toBe('camera')
    expect(r.intent).toBe('Solve: Lös ekvationen: 5(2x - 3) = 4x + 9')
  })

  // Catches: a disagreeing read reaching the brain. The recorded native-crop
  // answers really disagree ("5|2x - 3|" vs "5(2x - 3)"), so the iPad's problem is solved.
  it('the models disagree (native crop answers) → falls back to the iPad', async () => {
    const r = await readForSolve({ reader: reader(async (m) => recorded('crop')(m)), worksheetTasks: () => IPAD })
    expect(r.source).toBe('ipad')
    expect(r.text).toBe('Lös ekvationen: 5(2x - 3) = 4x + 9')
    expect(r.note).toMatch(/disagree/)
  })

  // Catches: a stalled gateway holding the press past the budget instead of using the iPad.
  it('a stalled read → the iPad within the budget', async () => {
    const r = await readForSolve({ reader: reader(() => new Promise(() => {})), worksheetTasks: () => IPAD, budgetMs: 200 })
    expect(r.source).toBe('ipad')
    expect(r.ms).toBeLessThan(1000)
  })

  // Catches: an empty intent being sent on when nothing could be read.
  it('nothing readable and no iPad → none, with the ask-by-typing note', async () => {
    const r = await readForSolve({ reader: reader(async () => 'UNREADABLE', []), worksheetTasks: () => [] })
    expect(r).toMatchObject({ source: 'none', intent: '' })
    expect(r.note).toBeTruthy()
  })
})
