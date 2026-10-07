// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SURFACE, type TableSurface } from '@hubble/stage'
import { assetRenderer } from './assetRenderer.tsx'

/** Label: schema-derived (surface states written as the server's openAsset writes them). */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLElement
let root: Root
beforeEach(() => {
  ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const surf = (state: Record<string, unknown>): TableSurface => ({ id: 'asset-x', kind: 'asset', box: { x: 832, y: 444, w: 256, h: 192 }, z: 1, focused: true, instance: 0, pinned: false, state })

describe('the asset surface renderer', () => {
  it('draws the asset the surface names, from its state alone', async () => {
    const s = surf({ assetId: 'right-triangle', kind: 'image', title: 'Right triangle', aspect: 0.75, url: '/api/assets/right-triangle/file' })
    await act(async () => root.render(createElement('div', null, assetRenderer(s, DEFAULT_SURFACE))))
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/api/assets/right-triangle/file')
  })
  const good = { assetId: 'right-triangle', kind: 'image', title: 'Right triangle', aspect: 0.75, url: '/api/assets/right-triangle/file' }
  it.each([
    ['a url that is not a string', { url: 42 }],
    ['a url outside the asset route', { url: 'https://evil.example/x.png' }],
    ['a negative aspect', { aspect: -1 }],
    ['an infinite aspect', { aspect: Infinity }],
    ['an unknown kind', { kind: 'iframe' }],
  ])('draws nothing for %s', (_name, over) => {
    // Break caught: a malformed surface projecting a broken or foreign
    // picture on the table, or a box of NaN size.
    expect(assetRenderer(surf({ ...good, ...over }), DEFAULT_SURFACE)).toBeNull()
  })
  it('draws nothing, and does not throw, for a surface with no state', () => {
    expect(assetRenderer({ ...surf({}), state: undefined as never }, DEFAULT_SURFACE)).toBeNull()
  })
})
