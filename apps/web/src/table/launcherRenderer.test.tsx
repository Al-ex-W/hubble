// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SURFACE, type TableSurface } from '@hubble/stage'
import { launcherRenderer } from './launcherRenderer.tsx'
// The server's own launcher publishes the state drawn here (a test-only
// reach across apps): if the two ever disagree about the state's shape,
// this goes red instead of the launcher silently vanishing from the table.
import { createLauncher } from '../../../server/launcher.ts'
import { createSurfaceManager } from '../../../server/surfaces.ts'

/**
 * The launcher renderer (#33). Label: schema-derived (the state the server's
 * launcher publishes, produced by running it). Oracle: the item boxes in that
 * state, compared with the drawn elements' positions.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
const published = (): TableSurface => {
  const m = createSurfaceManager({ publish: () => {} })
  createLauncher({ surfaces: m, actions: { keyboard: () => {}, lesson: () => {} } }).onGesture({ type: 'wake', p: { x: 960, y: 800 } })
  return m.list().find((s) => s.kind === 'launcher')!
}

describe('the launcher renderer', () => {
  it('draws every item the server published, exactly at its box, with the stage corners', async () => {
    // Break caught: what is lit and what is hit drifting apart, or the
    // launcher vanishing because the state shape changed on one side.
    const s = published()
    await act(async () => root.render(createElement('div', null, launcherRenderer(s, DEFAULT_SURFACE))))
    const items = (s.state as { items: { id: string; label: string; box: { x: number; y: number; w: number; h: number } }[] }).items
    const drawn = [...host.querySelectorAll<HTMLElement>('[data-launcher-item]')]
    expect(drawn.map((d) => d.textContent)).toEqual(['Keyboard', 'Lesson'])
    // To the DOM's own precision: a style keeps 6 decimals, and real-mm boxes
    // on the room's 1550/1920 mm/px are not exact binary fractions.
    const px = (v: string) => Number.parseFloat(v)
    drawn.forEach((d, i) => {
      expect(px(d.style.left)).toBeCloseTo(items[i]!.box.x, 5)
      expect(px(d.style.top)).toBeCloseTo(items[i]!.box.y, 5)
      expect(px(d.style.width)).toBeCloseTo(items[i]!.box.w, 5)
      expect(px(d.style.height)).toBeCloseTo(items[i]!.box.h, 5)
    })
    expect(host.querySelectorAll('.st-corner')).toHaveLength(4)
    // The stage's body size, 18.75 mm at the room's 1550/1920 mm/px = 23 px (it was 24 px on the old 1.5 m surface): physical, like everything on the table.
    expect(drawn[0]!.style.fontSize).toBe(`${Math.round(18.75 / (1550 / 1920))}px`)
  })

  it.each([
    ['no state', undefined],
    ['no items', { items: [] }],
    ['an item with a NaN box', { items: [{ id: 'a', label: 'A', box: { x: 0, y: 0, w: NaN, h: 10 } }] }],
    // NaN already fails "w > 0"; Infinity is what only the finite check stops.
    ['an item with an infinite box', { items: [{ id: 'a', label: 'A', box: { x: 0, y: 0, w: Infinity, h: 10 } }] }],
    ['an item with no label', { items: [{ id: 'a', box: { x: 0, y: 0, w: 10, h: 10 } }] }],
    ['an item with a zero-size box', { items: [{ id: 'a', label: 'A', box: { x: 0, y: 0, w: 0, h: 10 } }] }],
  ])('draws nothing for %s', (_n, state) => {
    expect(launcherRenderer({ ...published(), state: state as never }, DEFAULT_SURFACE)).toBeNull()
  })
})
