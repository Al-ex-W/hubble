// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SURFACE } from '@hubble/stage'

/*
 * The ripple on /table (#89). Fixture: schema-derived touch lines (the shape
 * stage's TouchLine defines; no lidar data reaches the browser), delivered
 * through a fake EventSource, as stageStream.test.ts does. Oracles: plain mm
 * arithmetic and the DOM's circles.
 */
class FakeSource {
  static all: FakeSource[] = []
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  constructor(readonly url: string) {
    FakeSource.all.push(this)
  }
  close() {}
  emit(line: unknown) {
    this.onmessage?.({ data: JSON.stringify(line) })
  }
}

beforeEach(() => {
  FakeSource.all = []
  vi.stubGlobal('EventSource', FakeSource)
  vi.resetModules()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mount(surface = DEFAULT_SURFACE) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const { TouchRipples } = await import('./TouchRipples.tsx')
  const el = document.createElement('div')
  const root = createRoot(el)
  await act(async () => root.render(createElement(TouchRipples, { surface })))
  const src = FakeSource.all[0]!
  const send = (line: unknown) => act(() => src.emit(line))
  // The cyan rings only; the white flash (data-flash) is checked on its own.
  const rings = () => [...el.querySelectorAll('circle[data-ripple]')]
  const flashes = () => [...el.querySelectorAll('circle[data-flash]')]
  return { el, src, send, rings, flashes, unmount: () => act(() => root.unmount()) }
}

const down = (id: number, x = 960, y = 600) => ({ kind: 'touch', id, phase: 'down', p: { x, y } })

describe('touch ripples', () => {
  // Break caught: a ripple invisible on the WHITE table. The flash must be
  // full white light (the brightest a projector adds), never black or dim.
  it('a touch also flashes a white ring', async () => {
    const { send, flashes, unmount } = await mount(DEFAULT_SURFACE)
    await send(down(1))
    expect(flashes()).toHaveLength(1)
    expect(flashes()[0]!.getAttribute('stroke')).toBe('#ffffff')
    await unmount()
  })
  // Break caught: sizes as pixel constants. Oracle: 70 mm / (mm per px),
  // computed here, not by the component's helper.
  it('sizes the rings in millimetres through the surface', async () => {
    const coarse = { ...DEFAULT_SURFACE, mmPerPx: 2 }
    const { send, rings, unmount } = await mount(coarse)
    await send(down(1, 100, 200))
    const [ring] = rings()
    expect(Number(ring.getAttribute('r'))).toBeCloseTo(70 / 2)
    expect(Number(ring.getAttribute('stroke-width'))).toBeCloseTo(4 / 2)
    expect([ring.getAttribute('cx'), ring.getAttribute('cy')]).toEqual(['100', '200'])
    await unmount()
  })

  // Break caught: rippling on every move line, which draws a trail of rings
  // (noise) instead of one answer to "I touched here".
  it('ripples on down only', async () => {
    const { send, rings, unmount } = await mount()
    await send(down(1))
    for (const phase of ['move', 'up', 'cancel']) await send({ kind: 'touch', id: 1, phase, p: { x: 1, y: 1 } })
    expect(new Set(rings().map((r) => r.getAttribute('data-ripple'))).size).toBe(1)
    await unmount()
  })

  // Break caught: no cap, so a palm or a burst of noisy scans floods the
  // projector page with animating rings.
  it('keeps at most 8 ripples alive, oldest first out', async () => {
    const { send, rings, unmount } = await mount()
    for (let i = 0; i < 12; i++) await send(down(i, 100 + i, 100))
    const alive = [...new Set(rings().map((r) => r.getAttribute('cx')))]
    expect(alive).toHaveLength(8)
    expect(alive[0]).toBe('104')
    await unmount()
  })

  // Break caught: relying on animationend, which never fires in a hidden tab,
  // so ripples would stay drawn forever.
  it('removes a ripple after its animation time, by timer', async () => {
    const { send, rings, unmount } = await mount()
    await send(down(1))
    expect(rings()).toHaveLength(2)
    await act(async () => vi.advanceTimersByTime(600 + 150 + 60))
    expect(rings()).toHaveLength(0)
    await unmount()
  })

  // Break caught: a reconnect keeping ripples whose touches the server will
  // never mention again on the new connection.
  it('clears on reconnect', async () => {
    const { src, send, rings, unmount } = await mount()
    await send(down(1))
    await act(() => src.onopen?.())
    expect(rings()).toHaveLength(0)
    await unmount()
  })
})
