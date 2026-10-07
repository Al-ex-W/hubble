// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { PianoState } from '../../../shared/piano.ts'
import { PianoPanel } from './PianoPanel.tsx'

// Geometry is frozen fixture truth (mechanical mutation of a product shot),
// with schema-derived control states. DOM cannot establish visual alignment;
// the browser smoke and sidecar tests use the actual image too.
const manifest = JSON.parse(readFileSync('apps/keybed/fixtures/manifest.json', 'utf8'))
const f = manifest.frames.find((f: { file: string }) => f.file === 'static.jpg')
// Mechanical extraction of the outer corners of the two outside white
// keys in the frozen fixture. This is the playable boundary, independent
// of the browser painter and without inventing plausible camera points.
const boundary = [f.keys[0].corners[0], f.keys[24].corners[1], f.keys[24].corners[2], f.keys[0].corners[3]].map(([x, y]: number[]) => ({ x, y }))
const tracked: PianoState = { enabled: true, available: true, calibrated: false, status: 'tracking', ageMs: 100,
  snapshot: { id: 1, capturedAt: 1, image: 'data:image/jpeg;base64,' + readFileSync('apps/keybed/fixtures/static.jpg').toString('base64'), width: 960, height: 540,
    keys: f.keys.map((k: { note: number; black: boolean; corners: number[][] }) => ({ ...k, corners: k.corners.map(([x, y]) => ({ x, y })) })), keybed: boundary as NonNullable<PianoState['snapshot']>['keybed'], trackerStatus: 'locked' } }
let state: PianoState
let root: Root
let host: HTMLElement
let fail = false
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
  state = { ...tracked, enabled: false, status: 'off', snapshot: null }
  fail = false
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (fail) throw new Error('network unavailable')
    if (init?.method === 'POST' && url === '/api/operator/piano') {
      const { enabled } = JSON.parse(String(init.body))
      state = enabled ? tracked : { ...tracked, enabled: false, status: 'off', snapshot: null }
    }
    return new Response(JSON.stringify(state))
  })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))
const toggle = () => host.querySelector('input[type=checkbox]') as HTMLInputElement

it('the checkbox enables camera-space outlines for all keys, then removes them on disable', async () => {
  await act(async () => root.render(createElement(PianoPanel)))
  await flush()
  expect(toggle().checked).toBe(false)
  await act(async () => toggle().click())
  await flush()
  // Break: purely local checkbox, or drawing projector pixels on a camera image.
  expect(toggle().checked).toBe(true)
  expect(host.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 960 540')
  expect(host.querySelector('image')?.getAttribute('href')).toBe(tracked.snapshot!.image)
  // Review survivor: removing the outer outline left all key tests green.
  expect(host.querySelectorAll('.piano-boundary')).toHaveLength(1)
  expect(host.querySelector('.piano-boundary')?.getAttribute('points')).toBe(boundary.map((p) => `${p.x},${p.y}`).join(' '))
  const keys = host.querySelectorAll('polygon[data-note]')
  expect(keys).toHaveLength(25)
  for (const key of keys) {
    const truth = f.keys.find((k: { note: number }) => k.note === Number(key.getAttribute('data-note')))
    expect(key.getAttribute('points')).toBe(truth.corners.map(([x, y]: number[]) => `${x},${y}`).join(' '))
  }
  expect(host.textContent).toContain('Setup’s camera ↔ projector calibration')
  await act(async () => toggle().click())
  await flush()
  expect(host.querySelectorAll('polygon[data-note]')).toHaveLength(0)
})

it('retained key positions are labelled last known, and a failed toggle stays checked', async () => {
  state = { ...tracked, status: 'last-known', ageMs: 9000 }
  await act(async () => root.render(createElement(PianoPanel)))
  await flush()
  // Break: a lost response still has 25 quads, so count alone looks healthy.
  expect(host.textContent).toContain('Last known position')
  fail = true
  await act(async () => toggle().click())
  await flush()
  expect(toggle().checked).toBe(true)
  expect(host.textContent).toContain('Could not change piano playground')
})

it('a poll begun before disable cannot restore the old frame or checked state', async () => {
  // Fault injection: the first read loads a real fixture snapshot; the next
  // read is held across the operator's off command and answered afterwards.
  vi.useFakeTimers()
  let reads = 0
  let release!: (r: Response) => void
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response(JSON.stringify({ ...tracked, enabled: false, status: 'off', snapshot: null }))
    if (++reads === 1) return new Response(JSON.stringify(tracked))
    return new Promise<Response>((r) => { release = r })
  })
  try {
    await act(async () => root.render(createElement(PianoPanel)))
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    await act(async () => toggle().click())
    await act(async () => release(new Response(JSON.stringify(tracked))))
    expect(toggle().checked).toBe(false)
    expect(host.querySelector('svg')).toBeNull()
  } finally { vi.useRealTimers() }
})
