// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { OverlayLayer, useOverlays } from './OverlayLayer.tsx'
import { REFERENCE_TTL_MS } from '../../../shared/markers/layout.ts'

it('drops a trail cleared while disconnected before applying the new overlay snapshot', async () => {
  // Schema-derived polygon on the real hook/stream boundary. The hub omits
  // cleared layers from replay, so retaining local layers on reconnect makes
  // a finished keyboard stroke glow forever (and similarly resurrects lessons).
  let source!: { onopen?: () => void; onmessage?: (e: { data: string }) => void }
  vi.stubGlobal('EventSource', class {
    constructor() { source = this }
    onopen = () => {}
    onmessage = (_e: { data: string }) => {}
    close() {}
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  function Display() { return createElement(OverlayLayer, { lines: useOverlays(), surface: { widthPx: 1920, heightPx: 1200 } }) }
  const host = document.createElement('div')
  const root = createRoot(host)
  const emit = (layer: string) => source.onmessage?.({ data: JSON.stringify({ kind: 'overlay', layer, shapes: [{ points: [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 12, y: 12 }], color: '#36ff7a' }] }) })
  try {
    await act(async () => root.render(createElement(Display)))
    await act(async () => { source.onopen?.(); emit('keyboard-input') })
    expect(host.querySelectorAll('polygon')).toHaveLength(1)
    await act(async () => source.onopen?.()) // empty server overlay snapshot
    expect(host.querySelectorAll('polygon')).toHaveLength(0)
    await act(async () => emit('lesson'))
    expect(host.querySelectorAll('polygon')).toHaveLength(1)
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals() }
})

it('draws reference markers crisp, opaque and above every other light', async () => {
  // Schema-derived lines (the hub's overlay shape). Break caught: markers
  // drawn like lit keys, through the glow filter at 85 % opacity. The blur
  // moves the cell edges the detector refines to a fraction of a camera
  // pixel, and light leaks into the black cells; and drawn under a lesson
  // key, a marker cell would be lit over.
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const square = (color: string) => ({ points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }], color })
  const lines = [
    { kind: 'overlay' as const, layer: 'reference', shapes: [square('#000000')] },
    { kind: 'overlay' as const, layer: 'lesson', shapes: [square('#36ff7a')] },
  ]
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(OverlayLayer, { lines, surface: { widthPx: 1920, heightPx: 1200 } })))
    const polys = [...host.querySelectorAll('polygon')]
    expect(polys.map((p) => p.getAttribute('fill'))).toEqual(['#36ff7a', '#000000'])
    const marker = polys[1]!
    expect(marker.getAttribute('filter')).toBeNull()
    expect(marker.getAttribute('fill-opacity')).toBeNull()
    expect(polys[0]!.getAttribute('filter')).toBe('url(#key-glow)')
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals() }
})

it('drops the reference grid on its own when the server stops refreshing it', async () => {
  // Schema-derived lines on the real hook/stream boundary; fake timers are
  // the clock. Break caught (review of #95, finding 3): the display keeping
  // the marker grid forever when the server died or the Wi-Fi dropped
  // mid-run, so no clear ever arrived. The lesson layer must NOT expire:
  // a lit key is re-sent on change, not on a timer.
  vi.useFakeTimers()
  let source!: { onopen?: () => void; onmessage?: (e: { data: string }) => void }
  vi.stubGlobal('EventSource', class {
    constructor() { source = this }
    onopen = () => {}
    onmessage = (_e: { data: string }) => {}
    close() {}
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  function Display() { return createElement(OverlayLayer, { lines: useOverlays(), surface: { widthPx: 1920, heightPx: 1200 } }) }
  const host = document.createElement('div')
  const root = createRoot(host)
  const emit = (layer: string) => source.onmessage?.({ data: JSON.stringify({ kind: 'overlay', layer, shapes: [{ points: [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 12, y: 12 }], color: '#000000' }] }) })
  const count = () => host.querySelectorAll('polygon').length
  try {
    await act(async () => root.render(createElement(Display)))
    await act(async () => { source.onopen?.(); emit('lesson'); emit('reference') })
    expect(count()).toBe(2)
    // Refreshed in time (the server's 2 s cadence): still up after 8 s total.
    for (let i = 0; i < 4; i++) await act(async () => { vi.advanceTimersByTime(2000); emit('reference') })
    expect(count()).toBe(2)
    // The server goes silent: gone within the TTL, the lesson key stays.
    await act(async () => { vi.advanceTimersByTime(REFERENCE_TTL_MS + 1) })
    expect(count()).toBe(1)
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(count()).toBe(1)
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); vi.useRealTimers() }
})
