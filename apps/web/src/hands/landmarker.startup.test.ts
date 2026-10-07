/**
 * The real loader start-up (review #42, round 2): the asset choice must reach
 * MediaPipe's initialisation, and a failed local start must retry from the
 * CDN. Label: schema-derived mocks of MediaPipe and of the HTTP answers a dev
 * server gives. Adapted from the reviewer's probe (temp/reviews/42/loader-probe-r2.ts).
 */
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createLandmarker } from './landmarker.ts'
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
vi.mock('@mediapipe/tasks-vision', () => ({ FilesetResolver: { forVisionTasks: vi.fn(async (url) => url) }, HandLandmarker: { createFromOptions: vi.fn() } }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(HandLandmarker.createFromOptions).mockResolvedValue({ close: vi.fn() } as any)
})
afterEach(() => vi.unstubAllGlobals())
it('uses the CDN in actual startup when local HEAD responses are SPA HTML', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200, headers: { 'content-type': 'text/html' } })))
  const lm = await createLandmarker()
  expect(lm.source).toBe('cdn')
  expect(FilesetResolver.forVisionTasks).toHaveBeenCalledTimes(1)
  expect(FilesetResolver.forVisionTasks).toHaveBeenCalledWith('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm')
})
it('retries the CDN after the local runtime fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200, headers: { 'content-type': 'application/octet-stream' } })))
  vi.mocked(HandLandmarker.createFromOptions).mockRejectedValueOnce(new Error('local runtime broken'))
  const lm = await createLandmarker()
  expect(lm.source).toBe('cdn')
  expect(FilesetResolver.forVisionTasks).toHaveBeenNthCalledWith(1, '/mediapipe/wasm')
  expect(FilesetResolver.forVisionTasks).toHaveBeenNthCalledWith(2, 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm')
})
