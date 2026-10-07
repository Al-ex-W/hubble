// @vitest-environment happy-dom
/**
 * HandPanel's ownership of the camera, the tracker and camera frames
 * (review #42). Label: schema-derived mocks of getUserMedia, video playback
 * and the landmarker (happy-dom has no camera). Adapted from the reviewer's
 * reproduction (temp/reviews/42/panel-repro.tsx).
 *
 * Breaks caught: a camera left running after the tracker failed to start or
 * after the panel went away; the landmarker never closed; one camera frame
 * pushed twice because the display refreshes faster than the camera, which
 * lets a single noisy sample satisfy the two-frame pinch confirmation.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HandPanel } from './HandPanel.tsx'
import { createLandmarker } from './landmarker.ts'
vi.mock('./landmarker.ts', () => ({ createLandmarker: vi.fn() }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null, host: HTMLElement
let stop: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn>, detect: ReturnType<typeof vi.fn>
let raf: FrameRequestCallback | undefined
beforeEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {configurable:true,writable:true,value:null})
  stop = vi.fn(); close = vi.fn(); detect = vi.fn((_v,t) => ({ t, hands: [] }))
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    enumerateDevices: async () => [], getUserMedia: async () => ({getTracks: () => [{stop}]})
  }})
  vi.mocked(createLandmarker).mockResolvedValue({source:'local',close,detect})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({clearRect(){},fillRect(){}} as any)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {raf=cb; return 1})
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  // The panel follows the surface set (a launcher owns presses on it, #33); happy-dom has no EventSource.
  vi.stubGlobal('EventSource', class { onmessage = null; onopen = null; onerror = null; close() {} })
  host=document.createElement('div');document.body.append(host);root=createRoot(host)
})
afterEach(async () => {if(root) await act(async()=>root!.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals()})
async function mountAndStart() {
  await act(async()=>root!.render(createElement(HandPanel,{onPress:()=>{},onTrail:()=>{},kbToTable:[1,0,0,0,1,0,0,0,1]})))
  await act(async()=>host.querySelector('button')!.click())
}
it('stops the acquired camera on unmount',async()=> {
  await mountAndStart()
  expect(host.textContent).toContain('stop')
  await act(async()=>root!.unmount()); root=null
  expect(stop).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})
it('stops the camera when tracker initialization fails',async()=> {
  vi.mocked(createLandmarker).mockRejectedValue(new Error('tracker failed'))
  await mountAndStart()
  expect(host.textContent).toContain('tracker failed')
  expect(stop).toHaveBeenCalledOnce()
})
it('only counts each camera frame once, regardless of animation refresh rate',async()=> {
  await mountAndStart()
  const video=host.querySelector('video')!, canvas=host.querySelector('canvas')!
  for(const [name,value] of Object.entries({videoWidth:640,videoHeight:480,readyState:2,currentTime:1}))Object.defineProperty(video,name,{value,configurable:true})
  canvas.getBoundingClientRect=()=>({left:0,top:0,width:640,height:480} as DOMRect)
  for(const [x,y] of [[10,10],[400,10],[400,200],[70,200]])await act(async()=>canvas.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:x,clientY:y})))
  await act(async()=>raf!(16))
  await act(async()=>raf!(32))
  expect(detect).toHaveBeenCalledTimes(1)
})

it('a start cannot overlap another: the button is "stop" while the camera and tracker load', async () => {
  // Review #42 round 2: two starts racing left an abandoned tracker unclosed.
  vi.mocked(createLandmarker).mockImplementationOnce(() => new Promise(() => {}))
  await mountAndStart()
  const buttons = [...host.querySelectorAll('button')].map((b) => b.textContent)
  expect(buttons).toContain('stop')
  expect(buttons).not.toContain('start camera')
  // A source change while loading would label the old stream as the newly
  // selected camera, applying the room map to a local webcam (or vice versa).
  expect(host.querySelector('select')!.disabled).toBe(true)
})

it('a tracker that finishes loading after stop is closed, not kept or leaked', async () => {
  const lateClose = vi.fn()
  let finish!: (value: Awaited<ReturnType<typeof createLandmarker>>) => void
  vi.mocked(createLandmarker).mockImplementationOnce(() => new Promise((r) => (finish = r)))
  await mountAndStart()
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'stop')!.click())
  await act(async () => finish({ source: 'local', close: lateClose, detect }))
  expect(lateClose).toHaveBeenCalledOnce()
})

it('a camera granted after stop is released at once', async () => {
  // The permission prompt can outlive the user's patience: a stream that
  // arrives after stop (or unmount) must not keep the camera on.
  const lateStop = vi.fn()
  let grant!: (s: unknown) => void
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { enumerateDevices: async () => [], getUserMedia: () => new Promise((r) => (grant = r)) } })
  await mountAndStart()
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'stop')!.click())
  await act(async () => grant({ getTracks: () => [{ stop: lateStop }] }))
  expect(lateStop).toHaveBeenCalledOnce()
})

// The room camera's wiring (raw joints under the grant, release on stop) moved
// with the tracker to RoomHands.tsx (#75): RoomHands.test.tsx.

it('a tracker from an abandoned start is closed even when a newer start already holds one', async () => {
  // Review #42 (manager verification): start, stop, start again; the second
  // tracker loads first and is kept, then the first finishes late. The old
  // guard only closed a late tracker when none was held, so the first one
  // leaked here. Label: schema-derived mocks, two independently resolved loads.
  const firstClose = vi.fn()
  const secondClose = vi.fn()
  let finishFirst!: (v: Awaited<ReturnType<typeof createLandmarker>>) => void
  let finishSecond!: (v: Awaited<ReturnType<typeof createLandmarker>>) => void
  vi.mocked(createLandmarker)
    .mockImplementationOnce(() => new Promise((r) => (finishFirst = r)))
    .mockImplementationOnce(() => new Promise((r) => (finishSecond = r)))
  await mountAndStart() // first start: tracker loading
  const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!
  await act(async () => button('stop').click())
  await act(async () => button('start camera').click()) // second start
  await act(async () => finishSecond({ source: 'local', close: secondClose, detect }))
  expect(host.textContent).toContain('stop') // the second tracker is running
  await act(async () => finishFirst({ source: 'local', close: firstClose, detect }))
  expect(firstClose).toHaveBeenCalledOnce()
  expect(secondClose).not.toHaveBeenCalled()
})
