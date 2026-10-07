// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SURFACE, type TableSurface } from '@hubble/stage'
import { drawingRenderer } from './drawingRenderer.tsx'

/**
 * Label: schema-derived (states written as the server's openDrawing writes
 * them). Oracle: the DOM the renderer produces, read back here.
 */
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
const STAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="743" height="743" preserveAspectRatio="xMidYMid meet"><polygon points="200,20 380,150 20,150" fill="none" stroke="#ffd23f" stroke-width="10"/></svg>'
const surf = (state: Record<string, unknown>): TableSurface => ({ id: 'drawing-1', kind: 'drawing', box: { x: 588, y: 228, w: 743, h: 743 }, z: 1, focused: true, instance: 0, pinned: false, state })
const mount = async (s: TableSurface) => {
  await act(async () => root.render(createElement('div', null, drawingRenderer(s, DEFAULT_SURFACE))))
}

describe('the drawing surface renderer', () => {
  it('draws the SVG as an image with a data: URL, at the box size', async () => {
    await mount(surf({ svg: STAR, title: 'Big star' }))
    const img = host.querySelector<HTMLImageElement>('img[data-drawing="drawing-1"]')!
    // Break caught: a drawing that isn't drawn, or drawn at the wrong size
    // (the agent sized it in real mm; the box is that size in px).
    expect(img.getAttribute('width')).toBe('743')
    expect(img.getAttribute('height')).toBe('743')
    expect(img.alt).toBe('Big star')
    // Break caught: the SVG inlined into the page. It must only ever be an
    // image (scripts in an image never run), so no <svg> element may appear
    // in the display's DOM.
    expect(img.getAttribute('src')!.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(img.getAttribute('src')!.split(',').slice(1).join(','))).toBe(STAR)
    expect(host.querySelector('svg polygon')).toBeNull()
  })

  it('draws nothing for a state openDrawing could not have written', async () => {
    // Break caught: a malformed or foreign state reaching the projector as an
    // empty frame, or as text.
    for (const state of [{}, { svg: 42 }, { svg: '<html><body>x</body></html>' }, { svg: 'hello' }]) {
      await mount(surf(state))
      expect(host.querySelector('img')).toBeNull()
    }
  })
})
