// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SURFACE, type TableSurface } from '@hubble/stage'
import { KeyboardFace, KeyboardSurface } from './KeyboardFace.tsx'
import { SurfaceLayer } from './SurfaceLayer.tsx'

/**
 * The keyboard's face from a state (label: schema-derived states, written to
 * KeyboardSurfaceState). What it must get right is what the runtime's state
 * means on the table: which word sits in which slot, the line, the keys.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

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

const slots = () => [...host.querySelectorAll('.swk-cand')].map((g) => g.querySelector('text')?.textContent ?? null)

describe('KeyboardFace', () => {
  it('puts the best candidate in the middle slot, the 2nd left and the 3rd right', async () => {
    await act(async () => root.render(createElement(KeyboardFace, { state: { text: 'my name', candidates: ['name', 'game', 'same'], sent: null } })))
    // Break caught: candidates drawn in decoder order, so the middle slot
    // (which the reducer's hit-test reads as "best") shows another word.
    expect(slots()).toEqual(['game', 'name', 'same'])
    expect(host.querySelector('.swk-text')!.textContent).toBe('my name▍')
    // 26 letters + space, delete, send: the whole board, at the widget's mm viewBox.
    expect(host.querySelectorAll('.swk-key')).toHaveLength(29)
    expect(host.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 440 256')
  })

  it('shows the placeholder when empty, and a sent line once per send', async () => {
    await act(async () => root.render(createElement(KeyboardFace, { state: { text: '', candidates: [], sent: { n: 2, text: 'hello' } } })))
    expect(host.querySelector('.swk-placeholder')).not.toBeNull()
    expect(host.querySelector('.swk-sent')!.textContent).toBe('hello')
    expect(slots()).toEqual([null, null, null])
  })
})

describe('KeyboardSurface in a SurfaceLayer', () => {
  it('draws the keyboard surface in its box, and survives a malformed state', async () => {
    const kb: TableSurface = { id: 'keyboard', kind: 'keyboard', z: 1, focused: true, instance: 0, pinned: false, box: { x: 678.4, y: 701.12, w: 563.2, h: 327.68 }, state: { text: 42, candidates: 'nope', sent: { n: 'x', text: { evil: true } } } }
    await act(async () =>
      root.render(createElement(SurfaceLayer, { surfaces: [kb], surface: DEFAULT_SURFACE, renderers: { keyboard: (s) => createElement(KeyboardSurface, { s, surface: DEFAULT_SURFACE }) } })),
    )
    // Break caught: a state from an older server throwing on the table (the
    // whole /table page would go blank mid-demo).
    expect(host.querySelector('[data-surface="keyboard"] [data-keyboard-face]')).not.toBeNull()
    expect(host.querySelector('.swk-placeholder')).not.toBeNull()
    const frame = host.querySelector('[data-surface="keyboard"] [data-keyboard-face]')!.parentElement as HTMLElement
    // The box is the surface's own (px from the widget's mm, made by the runtime).
    expect([frame.style.width, frame.style.height]).toEqual(['563.2px', '327.68px'])
  })
})
