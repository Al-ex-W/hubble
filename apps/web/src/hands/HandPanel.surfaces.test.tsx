// @vitest-environment happy-dom
/**
 * HandPanel hands its pipeline the surface set, so a press that starts on
 * the launcher is the launcher's, not the keyboard's (#33, review #48).
 * Label: schema-derived (a launcher surface as the server publishes it; the
 * camera, video and tracker mocked as in HandPanel.test.tsx). Oracle: the
 * `covered` the panel gives the pipeline, asked at points inside and outside
 * the launcher's box (plain rectangle maths in the test).
 *
 * Break caught: the pipeline built without `covered`, or with a stale
 * surface set, so the keyboard typed the key under a launcher item.
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { TableSurface } from '@hubble/stage'
import { HandPanel } from './HandPanel.tsx'
import { createLandmarker } from './landmarker.ts'
import type { Pt } from './types.ts'

const seen = vi.hoisted(() => ({ covered: undefined as undefined | ((p: Pt) => boolean), surfaces: [] as TableSurface[] }))
vi.mock('./landmarker.ts', () => ({ createLandmarker: vi.fn() }))
vi.mock('./pipeline.ts', async (original) => {
  const real = await original<typeof import('./pipeline.ts')>()
  return { ...real, createHandPipeline: (o: Parameters<typeof real.createHandPipeline>[0]) => ((seen.covered = o.covered), real.createHandPipeline(o)) }
})
vi.mock('../table/surfaces.ts', async (original) => ({ ...(await original<Record<string, unknown>>()), useSurfaces: () => seen.surfaces }))

it('the pipeline is asked about the launcher the set holds now', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, writable: true, value: null })
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { enumerateDevices: async () => [], getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } })
  vi.mocked(createLandmarker).mockResolvedValue({ source: 'local', close() {}, detect: (_v: unknown, t: number) => ({ t, hands: [] }) } as never)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {}, fillRect() {} } as never)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(HandPanel, { onPress: () => {}, onTrail: () => {}, kbToTable: [1, 0, 0, 0, 1, 0, 0, 0, 1] })))
    await act(async () => host.querySelector('button')!.click())
    const video = host.querySelector('video')!
    const canvas = host.querySelector('canvas')!
    for (const [name, value] of Object.entries({ videoWidth: 640, videoHeight: 480, readyState: 2, currentTime: 1 })) Object.defineProperty(video, name, { value, configurable: true })
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480 }) as DOMRect
    for (const [x, y] of [[10, 10], [400, 10], [400, 200], [70, 200]]) await act(async () => canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y })))
    expect(seen.covered).toBeTypeOf('function')
    // No launcher yet: nothing is covered.
    expect(seen.covered!({ x: 900, y: 600 })).toBe(false)
    // A launcher opens after the pipeline was built: the same pipeline sees it.
    seen.surfaces = [{ id: 'launcher', kind: 'launcher', box: { x: 800, y: 500, w: 200, h: 110 }, z: 1, focused: true, instance: 0, pinned: false, state: { items: [] } }]
    await act(async () => root.render(createElement(HandPanel, { onPress: () => {}, onTrail: () => {}, kbToTable: [1, 0, 0, 0, 1, 0, 0, 0, 1] })))
    expect(seen.covered!({ x: 900, y: 600 })).toBe(true)
    expect(seen.covered!({ x: 1001, y: 600 })).toBe(false)
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
