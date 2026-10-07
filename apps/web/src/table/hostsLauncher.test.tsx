// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SURFACE, type TableSurface } from '@hubble/stage'

/**
 * Both hosts draw a launcher from the set (#33). Label: schema-derived (a
 * launcher surface as the server publishes it). Oracle: its items in the DOM.
 */
const launcher: TableSurface = { id: 'launcher', kind: 'launcher', box: { x: 857.6, y: 584.2, w: 204.8, h: 112.6 }, z: 1, focused: true, instance: 0, pinned: false, state: { items: [{ id: 'keyboard', label: 'Keyboard', box: { x: 15.4, y: 15.4, w: 81.9, h: 81.9 } }] } }
vi.mock('./surfaces.ts', async (original) => ({ ...(await original<Record<string, unknown>>()), useSurfaces: () => [launcher] }))
vi.mock('../lesson/OverlayLayer.tsx', () => ({ useOverlays: () => [], OverlayLayer: () => null }))
// The ripple layer subscribes to the stage stream itself; like the overlays, not under test here.
vi.mock('./TouchRipples.tsx', () => ({ TouchRipples: () => null }))

afterEach(() => vi.unstubAllGlobals())
const mount = async (el: ReturnType<typeof createElement>) => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; onopen = null; close() {} })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(el))
  const found = host.querySelector('[data-launcher-item="keyboard"]')?.textContent
  act(() => root.unmount())
  host.remove()
  return found
}

it('/table draws the launcher the set names', async () => {
  // Break caught: an open palm opening a launcher the projector never shows.
  const { TableDisplay } = await import('./TableDisplay.tsx')
  expect(await mount(createElement(TableDisplay))).toBe('Keyboard')
})

it('the bench draws it too', async () => {
  const { TableSim } = await import('../preview/TableSim.tsx')
  const props = { scene: { surface: DEFAULT_SURFACE, objects: [] }, setScene: () => {}, visuals: {}, events: [], renderKey: 0, renderId: undefined, speed: 1, onAction: () => {}, showOutlines: false }
  expect(await mount(createElement(TableSim, props as never))).toBe('Keyboard')
})
