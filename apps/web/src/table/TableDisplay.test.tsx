// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { TableSurface } from '@hubble/stage'

/**
 * The projector page composing an answer over a separate asset (review #43).
 * Label: schema-derived (the surface set written as the server's openAsset
 * and answer surface write it). Oracle: the DOM's own paint, i.e. the asset's
 * <img> present and the answer's full-table frame not painting over it.
 */
const set: TableSurface[] = [
  { id: 'asset-right-triangle', kind: 'asset', box: { x: 832, y: 444, w: 256, h: 192 }, z: 1, focused: false, instance: 0, pinned: false, state: { assetId: 'right-triangle', kind: 'image', title: 'Right triangle', aspect: 0.75, url: '/api/assets/right-triangle/file' } },
  { id: 'answer', kind: 'answer', box: { x: 100, y: 100, w: 400, h: 100 }, z: 2, focused: true, instance: 0, pinned: false, state: {} },
]
vi.mock('./surfaces.ts', async (original) => ({ ...(await original<Record<string, unknown>>()), useSurfaces: () => set }))
vi.mock('../lesson/OverlayLayer.tsx', () => ({ useOverlays: () => [], OverlayLayer: () => null }))
// The ripple layer subscribes to the stage stream itself; like the overlays, not under test here.
vi.mock('./TouchRipples.tsx', () => ({ TouchRipples: () => null }))

afterEach(() => vi.unstubAllGlobals())

it('an answer raised over a separate asset leaves the asset visible; the black stays on the page', async () => {
  // Break caught (review #43): the answer's full-table frame painted the
  // projector's black over every lower surface, so opening any answer hid
  // an asset that it did not even overlap.
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; close() {} })
  const { TableDisplay } = await import('./TableDisplay.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(TableDisplay)))
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/api/assets/right-triangle/file')
    const frame = host.querySelector<HTMLElement>('.st-frame')!
    expect(frame).toBeTruthy()
    expect(frame.style.background).toBe('transparent')
    expect((host.firstElementChild as HTMLElement).style.background).toMatch(/^(#000|rgb\(0, 0, 0\)|black)$/)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
