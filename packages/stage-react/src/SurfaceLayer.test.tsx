// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SURFACE, type TableSurface } from '@hubble/stage'
import { SurfaceLayer } from './SurfaceLayer.tsx'

/**
 * Label: schema-derived (TableSurface values written to the type). The layer
 * decides only order and which renderer draws what; the kinds' content is
 * their own items' business.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const surf = (id: string, kind: TableSurface['kind'], z: number): TableSurface => ({ id, kind, z, box: { x: 10 * z, y: 10 * z, w: 100, h: 80 }, focused: false, instance: 0, pinned: false, state: {} })

let host: HTMLElement
let root: Root
beforeEach(() => {
  ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = NoopResizeObserver
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('SurfaceLayer', () => {
  it('draws surfaces bottom to top by z, whatever order the set lists them in', async () => {
    // Break caught: a raised surface drawn underneath because the set's array
    // order (which the ops don't promise) was used instead of z.
    const surfaces = [surf('top', 'asset', 3), surf('bottom', 'answer', 1), surf('mid', 'web', 2)]
    const tag = (s: TableSurface) => createElement('i', { 'data-id': s.id })
    await act(async () => root.render(createElement(SurfaceLayer, { surfaces, surface: DEFAULT_SURFACE, renderers: { asset: tag, answer: tag, web: tag } })))
    expect([...host.querySelectorAll('i[data-id]')].map((e) => e.getAttribute('data-id'))).toEqual(['bottom', 'mid', 'top'])
  })

  it('draws a kind with no renderer as an outline only in debug, and as nothing otherwise', async () => {
    // Break caught: a half-built kind (no renderer yet) showing up on the real table.
    const surfaces = [surf('k', 'keyboard', 1)]
    await act(async () => root.render(createElement(SurfaceLayer, { surfaces, surface: DEFAULT_SURFACE, renderers: {} })))
    expect(host.querySelector('[data-surface-outline]')).toBeNull()
    await act(async () => root.render(createElement(SurfaceLayer, { surfaces, surface: DEFAULT_SURFACE, renderers: {}, debug: true })))
    expect(host.querySelector('[data-surface-outline]')?.textContent).toContain('keyboard')
  })
  it('keeps its stacking to itself and leaves pointer events to the host', async () => {
    // Breaks caught (no layout engine here, so asserted on style): slot
    // z-indexes escaping and covering the lesson's key light drawn after the
    // layer; a slot taking the pointer and swallowing the bench's object drags.
    const tag = (s: TableSurface) => createElement('i', { 'data-id': s.id })
    await act(async () => root.render(createElement(SurfaceLayer, { surfaces: [surf('a', 'answer', 1)], surface: DEFAULT_SURFACE, renderers: { answer: tag } })))
    const layer = host.firstElementChild as HTMLElement
    expect(layer.style.isolation).toBe('isolate')
    const slot = host.querySelector<HTMLElement>('[data-surface="a"]')!
    expect(slot.style.pointerEvents).toBe('')
  })
})
