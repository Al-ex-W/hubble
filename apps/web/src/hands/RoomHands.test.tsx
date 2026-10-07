// @vitest-environment happy-dom
/**
 * The page's one room-camera tracker (#75): it must survive the Show/Setup
 * switch, and its teardown must give the keyboard back.
 *
 * Label: schema-derived mocks of the room camera, video playback and the
 * landmarker (happy-dom has no camera), fed one RECORDED frame (IMG_3537,
 * a closed hand) so the observation carries real joints.
 *
 * Breaks caught:
 * - the tracker living inside one mode again: swapping the provider's
 *   children (what OperatingSurface does on a mode switch) must not stop the
 *   camera, close the tracker or drop the grant;
 * - a teardown that leaves pinch mode on (#95's bug): unmounting the provider
 *   must post `mode: pointer` with OUR token exactly once, stop the room
 *   stream and close MediaPipe;
 * - pinch typing that posts without its grant, or through the legacy stroke
 *   path (the server owns room pinches; the page never commits strokes).
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RoomHandsProvider } from './RoomHands.tsx'
import { PinchToggle } from '../surface/PinchToggle.tsx'
import { createLandmarker } from './landmarker.ts'
import { openRoomCamera } from './roomCamera.ts'
import recorded from './fixtures/IMG_3537.trace.json'
import type { Trace } from './types.ts'
vi.mock('./landmarker.ts', () => ({ createLandmarker: vi.fn() }))
vi.mock('./roomCamera.ts', () => ({ openRoomCamera: vi.fn() }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null, host: HTMLElement
let raf: FrameRequestCallback | undefined
beforeEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, writable: true, value: null })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { raf = cb; return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('EventSource', class { onmessage = null; onopen = null; onerror = null; close() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { if (root) await act(async () => root!.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })

it('one tracker across both modes; unmount releases the grant, the room stream and MediaPipe', async () => {
  const take = recorded as Trace
  const close = vi.fn()
  const detect = vi.fn((_v: unknown, t: number) => ({ ...take.frames[50]!, t }))
  vi.mocked(createLandmarker).mockResolvedValue({ source: 'local', close, detect } as never)
  const camStop = vi.fn()
  vi.mocked(openRoomCamera).mockResolvedValue({ stream: {} as MediaStream, stop: camStop })
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) =>
    String(url) === '/api/keyboard/input'
      ? Response.json(init?.method === 'POST' ? { token: 'grant', revision: 7 } : { token: 'grant', reason: 'typing' })
      : new Response(null, { status: 202 }))
  vi.stubGlobal('fetch', fetcher)

  const page = (mode: ReactNode) => createElement(RoomHandsProvider, null, mode)
  await act(async () => root!.render(page(createElement('div', { key: 'show' }, createElement(PinchToggle)))))
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('pinch typing'))!.click())
  await flush()
  expect(openRoomCamera).toHaveBeenCalledOnce()
  const video = host.querySelector('video')!
  for (const [name, value] of Object.entries({ videoWidth: 1920, videoHeight: 1080, readyState: 2, currentTime: 1 })) Object.defineProperty(video, name, { value, configurable: true })
  await act(async () => raf!(16))
  const obs = fetcher.mock.calls.find(([url]) => url === '/api/spatial/observations')!
  const body = JSON.parse(obs[1]!.body as string)
  expect(body.input).toEqual({ token: 'grant', revision: 7 })
  expect(body.hands[0].pinch.thumb).toEqual({ x: take.frames[50]!.hands[0]!.lm[4]![0], y: take.frames[50]!.hands[0]!.lm[4]![1] })

  // The mode switch: Show's subtree goes, Setup's comes. The tracker stays.
  await act(async () => root!.render(page(createElement('div', { key: 'setup' }, 'setup'))))
  expect(camStop).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  const releases = () => fetcher.mock.calls.filter(([url, init]) => url === '/api/keyboard/input' && String(init?.body).includes('pointer'))
  expect(releases()).toHaveLength(0)
  Object.defineProperty(video, 'currentTime', { value: 2, configurable: true })
  await act(async () => raf!(32))
  expect(detect).toHaveBeenCalledTimes(2)

  await act(async () => root!.unmount()); root = null
  expect(releases()).toHaveLength(1)
  expect(JSON.parse(releases()[0]![1]!.body as string)).toEqual({ mode: 'pointer', token: 'grant' })
  expect(camStop).toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls.some(([url]) => url === '/api/keyboard/stroke' || url === '/api/input/gesture')).toBe(false)
})
