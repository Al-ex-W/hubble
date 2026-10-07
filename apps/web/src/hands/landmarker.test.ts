import { describe, expect, it } from 'vitest'
import { createFrameGate } from './frameGate.ts'
import { isAsset, pickAssets } from './landmarker.ts'

/** Label: schema-derived HTTP answers (the shapes a dev server and a static host give). */
const answer = (status: number, type: string) => (async () => new Response(null, { status, headers: { 'content-type': type } })) as typeof fetch

describe('where MediaPipe loads from', () => {
  it('takes the CDN when the "local file" is the dev server answering with its index.html', async () => {
    // Review #42: Vite answers a missing /mediapipe/... with 200 text/html,
    // which looked local and then failed to load instead of falling back.
    expect(await isAsset('/mediapipe/hand_landmarker.task', answer(200, 'text/html; charset=utf-8'))).toBe(false)
    expect(await pickAssets(answer(200, 'text/html'))).toBe('cdn')
  })
  it('takes the local files when they are really served', async () => {
    expect(await pickAssets(answer(200, 'application/octet-stream'))).toBe('local')
    expect(await pickAssets(answer(404, 'text/plain'))).toBe('cdn')
  })
})

describe('createFrameGate', () => {
  it('passes each camera frame once, however often the display asks', () => {
    // Review #42: two animation frames on one camera frame pushed the same
    // sample twice and confirmed a pinch from one noisy observation.
    const fresh = createFrameGate()
    expect([fresh(1.0), fresh(1.0), fresh(1.033), fresh(1.033), fresh(1.066)]).toEqual([true, false, true, false, true])
  })
})
