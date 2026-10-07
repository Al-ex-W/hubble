// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SURFACE, type TableSurface } from '@hubble/stage'

/**
 * Both hosts draw a web surface from the set (#31): /table read-only, the
 * bench forwarding clicks to the server. Label: schema-derived (the surface
 * as openWeb publishes it). Oracle: the stream <img> in the DOM and the
 * request the bench sends.
 */
const web: TableSurface = { id: 'web-1', instance: 1, kind: 'web', box: { x: 652.8, y: 348, w: 614.4, h: 384 }, z: 1, focused: true, pinned: false, state: { url: 'https://en.wikipedia.org/wiki/A', title: 'A', status: 'ready', stream: '/api/web/web-1/stream' } }
vi.mock('./surfaces.ts', async (original) => ({ ...(await original<Record<string, unknown>>()), useSurfaces: () => [web] }))
vi.mock('../lesson/OverlayLayer.tsx', () => ({ useOverlays: () => [], OverlayLayer: () => null }))
// The ripple layer subscribes to the stage stream itself; like the overlays, not under test here.
vi.mock('./TouchRipples.tsx', () => ({ TouchRipples: () => null }))

afterEach(() => vi.unstubAllGlobals())
const setup = () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; onopen = null; close() {} })
  const host = document.createElement('div')
  document.body.append(host)
  return { host, root: createRoot(host) }
}

it('/table draws the web surface the set names', async () => {
  // Break caught: a web surface in the set that the projector never shows.
  const { TableDisplay } = await import('./TableDisplay.tsx')
  const { host, root } = setup()
  try {
    await act(async () => root.render(createElement(TableDisplay)))
    expect(host.querySelector('img[data-web-surface="web-1"]')?.getAttribute('src')).toBe('/api/web/web-1/stream')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

it('the bench draws it and sends a click on it to the server', async () => {
  // Break caught: the bench showing the page but dropping input, so the
  // web surface can't be tried before the room exists.
  const fetch = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  const { TableSim } = await import('../preview/TableSim.tsx')
  const { host, root } = setup()
  try {
    const props = { scene: { surface: DEFAULT_SURFACE, objects: [] }, setScene: () => {}, visuals: {}, events: [], renderKey: 0, renderId: undefined, speed: 1, onAction: () => {}, showOutlines: false, surfaces: [web] }
    await act(async () => root.render(createElement(TableSim, props as never)))
    const img = host.querySelector<HTMLImageElement>('img[data-web-surface="web-1"]')!
    expect(img).toBeTruthy()
    await act(async () => img.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 0, clientY: 0 })))
    expect(fetch).toHaveBeenCalledWith('/api/web/web-1/click', expect.objectContaining({ method: 'POST' }))
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
