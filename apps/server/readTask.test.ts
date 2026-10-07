import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import jpeg from 'jpeg-js'
import { DEFAULT_SURFACE } from '@hubble/stage'
import { agree, cropPage, createTaskReader, mathKey, parseRead } from './readTask.ts'
import { RECORDED_IPAD, recordedIpadBox, standardCamera } from './readTask.fixture.ts'

/**
 * The camera task reader (#86), on recorded data only (demo-day light tests).
 * Fixture provenance: readTask.fixture.ts (recorded room frames) and
 * fixtures/camera-task-2026-10-07/answers.json (real gateway answers on crops
 * of those frames).
 */
const answers = JSON.parse(readFileSync(new URL('./fixtures/camera-task-2026-10-07/answers.json', import.meta.url), 'utf8')) as {
  gt: Record<string, string[]>
  answers: { model: string; case: string; input: string; rep: number; text: string }[]
}

/** Mean grey of a band of rows (fractions of height), across the middle of the crop. */
function band(img: { data: Uint8Array; width: number; height: number }, y0: number, y1: number) {
  let sum = 0
  let n = 0
  for (let y = Math.floor(img.height * y0); y < img.height * y1; y++)
    for (let x = Math.floor(img.width * 0.12); x < img.width * 0.7; x++) {
      sum += img.data[(y * img.width + x) * 4]!
      n++
    }
  return sum / n
}

describe('cropPage on recorded frames', () => {
  // Catches: a warp that leaves the page upside down (the camera sees the
  // table turned 180°), or a 4K frame sampled with 1080p coordinates (the
  // crop would land in the wrong quarter of the frame). Oracle: the frame's
  // own pixels: the task's text sits in the top third of the iPad's screen
  // (upright), so that band is darker than the empty middle of the screen.
  for (const f of RECORDED_IPAD.filter((x) => x.name !== 'final2')) {
    it(`${f.name}: upright, with the text band above the empty screen`, () => {
      const out = cropPage(readFileSync(f.file), standardCamera(), recordedIpadBox(), DEFAULT_SURFACE)
      const img = jpeg.decode(out.jpeg, { useTArray: true, formatAsRGBA: true })
      expect(img.height).toBeGreaterThan(img.width) // portrait iPad
      expect(band(img, 0.22, 0.34)).toBeLessThan(band(img, 0.45, 0.6) - 5)
    })
  }
})

describe('parseRead + agree on recorded model answers', () => {
  // Catches: a parser that drops the unnumbered research-format answers, or
  // a normaliser that makes "x·eˣ", "x eˣ" and "x e^x" differ (all three are
  // real answers for the same integrand).
  it('reads every recorded non-UNREADABLE answer as one problem whose maths matches the truth when right', () => {
    const cropped = answers.answers.filter((a) => a.input === 'up' && !/UNREADABLE/.test(a.text))
    expect(cropped.length).toBeGreaterThanOrEqual(8) // pinned corpus: a shrinking fixture fails loudly
    for (const a of cropped) {
      const r = parseRead(a.text)
      expect(r.length).toBeGreaterThan(0)
      expect(r[0]!.n).toBe(1)
    }
    expect(mathKey('∫ x·eˣ dx')).toBe(mathKey('∫ x e^x dx'))
  })

  // Catches: trusting a read when the models disagree on an answer-changing character.
  it('does not agree when one digit differs, agrees across spelling', () => {
    expect(agree(parseRead('1: Lös ekvationen: 5(2x - 3) = 4x + 9'), parseRead('Lös ekvationen:\n5(2x - 3) = 4x + 9'))).toBe(true)
    expect(agree(parseRead('1: Lös ekvationen: 5(2x - 3) = 4x + 9'), parseRead('1: Lös ekvationen: 5(2x - 5) = 4x + 9'))).toBe(false)
    expect(agree(parseRead('UNREADABLE'), parseRead('UNREADABLE'))).toBe(false)
  })
})

describe('createTaskReader', () => {
  const base = {
    frame: async () => readFileSync(RECORDED_IPAD[0]!.file),
    calibration: standardCamera,
    region: () => recordedIpadBox(),
    surface: () => DEFAULT_SURFACE,
    llm: null,
  }
  // Catches: a disagreeing camera read reaching the brain instead of the iPad fallback.
  it('falls back to the worksheet when the models disagree, and adds nothing to the scene', async () => {
    const replies: Record<string, string> = { 'aixia-code': '1: 5(2x - 3) = 4x + 9', 'aixia-labs': '1: 5(2x - 5) = 4x + 9' }
    const r = createTaskReader({ ...base, worksheetTasks: () => [{ n: 1, text: 'Lös ekvationen: | 5(2x - 3) = 4x + 9' }], ask: async (m) => replies[m]! })
    const read = await r.read()
    expect(read.source).toBe('worksheet')
    expect(read.tasks[0]!.text).toContain('5(2x - 3)')
    const req = r.withPage({ intent: 'solve problem 1' })
    expect(req.scene).toBeUndefined()
  })

  // Catches: an agreed read not reaching the render's scene with its problem numbers.
  it('puts an agreed read into the scene with numbered problems', async () => {
    const reply = '1: Lös ekvationen: x + 1 = 3\n2: Beräkna: ∫ x² dx'
    const r = createTaskReader({ ...base, worksheetTasks: () => [], ask: async () => reply })
    const read = await r.read()
    expect(read.source).toBe('camera')
    const label = r.withPage({ intent: 'solve problem 2' }).scene!.objects.find((o) => o.id === 'page')!.label
    expect(label).toContain('problem 2: Beräkna: ∫ x² dx')
  })
})
