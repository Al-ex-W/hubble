import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createKeyboard, initialKeyboard } from '@hubble/stage/swipe'
import { fromPrintout } from './calibration.ts'
import { createHandPipeline } from './pipeline.ts'
import type { Trace } from './types.ts'

/**
 * The whole hand path on a real take. Label: recording. fixtures/
 * IMG_3537.trace.json is the hands lab's recording of experiments/hands/
 * videos/IMG_3537.mp4 (iPhone, top-down, a real hand pinch-swiping "my name
 * is julie" over the printed table-look keyboard, 22 mm keys): MediaPipe's
 * 21 landmarks per frame in image px, plus the 4 key corners tapped on it.
 * Oracle: the words the person said.
 */
const trace = JSON.parse(readFileSync(new URL('./fixtures/IMG_3537.trace.json', import.meta.url), 'utf8')) as Trace

describe('a recorded hand typing on the printed keyboard', () => {
  it('replays IMG_3537 into the text "my name is julie" through the product keyboard', () => {
    expect(trace.frames.length).toBe(330) // pinned: a changed recording must fail loudly
    const p = createHandPipeline({ camToKb: fromPrintout(trace.meta.calibration), scale: trace.meta.sheet.scale })
    const kb = createKeyboard()
    let state = initialKeyboard()
    let presses = 0
    for (const frame of trace.frames) {
      for (const press of p.push(frame).presses) {
        presses++
        ;[state] = kb.stroke(state, press)
      }
    }
    // Break caught: anything in landmarks → calibration → pinch → stroke →
    // decoder → text that bends a stroke, splits a word or adds one.
    expect(state.text).toBe('my name is julie')
    expect(presses).toBe(4)
  })
})
