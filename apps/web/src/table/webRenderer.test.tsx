// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SURFACE, type TableSurface } from '@hubble/stage'
import { webRenderer, type WebInput } from './webRenderer.tsx'

/**
 * The web surface renderer (#31). Label: schema-derived (states written as
 * the server's openWeb/updateWeb write them). Oracle: plain arithmetic on
 * the box and the on-screen rectangle, written in the test.
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
const box = { x: 652.8, y: 348, w: 614.4, h: 384 }
const good = { url: 'https://en.wikipedia.org/wiki/A', title: 'A', status: 'ready', stream: '/api/web/web-1/stream' }
const surf = (state: Record<string, unknown> | undefined): TableSurface => ({ id: 'web-1', instance: 1, kind: 'web', box, z: 1, focused: true, pinned: false, state: state as never })
const mount = async (s: TableSurface, onInput?: (id: string, i: WebInput) => void) => {
  await act(async () => root.render(createElement('div', null, webRenderer(s, DEFAULT_SURFACE, onInput))))
  return host.querySelector<HTMLImageElement>('img[data-web-surface]')
}

describe('the web surface renderer', () => {
  // Break caught (bench, 7 Oct): an MJPEG <img> removed from the page kept
  // its request open in Chrome; a few Show/Setup switches held all six
  // connections to the host and every new picture stayed white. Removing
  // the picture must clear its src, which is what aborts the stream.
  it('clears the stream src when the picture is removed, so the connection closes', async () => {
    const img = (await mount(surf(good)))!
    expect(img.getAttribute('src')).toBe('/api/web/web-1/stream')
    await act(async () => root.render(createElement('div', null)))
    expect(img.getAttribute('src')).toBe('')
  })

  it('draws the stream at the box size, and takes no pointer on /table', async () => {
    const img = (await mount(surf(good)))!
    expect(img.getAttribute('src')).toBe('/api/web/web-1/stream')
    expect(img.style.width).toBe('614.4px')
    // Break caught: the projector page swallowing touches meant for the table.
    expect(img.style.pointerEvents).toBe('none')
    expect(host.querySelector('[data-web-status]')).toBeNull()
  })

  it('maps a bench click on the scaled picture to surface px', async () => {
    const got: WebInput[] = []
    const img = (await mount(surf(good), (_id, i) => got.push(i)))!
    // Drawn at half size on screen, at (100, 50).
    img.getBoundingClientRect = () => ({ left: 100, top: 50, width: 307.2, height: 192, right: 407.2, bottom: 242, x: 100, y: 50, toJSON() {} })
    await act(async () => img.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100 + 76.8, clientY: 50 + 144 })))
    // Break caught: a click sent in screen px, landing on the wrong link.
    // A quarter across and three quarters down, in surface px.
    expect(got).toHaveLength(1)
    const c = got[0] as Extract<WebInput, { op: 'click' }>
    expect(c.op).toBe('click')
    expect(c.x).toBeCloseTo(153.6, 6)
    expect(c.y).toBeCloseTo(288, 6)
    expect(img.style.pointerEvents).toBe('auto')
  })

  it('sends a wheel as a scroll, bounded like the route', async () => {
    const got: WebInput[] = []
    const img = (await mount(surf(good), (_id, i) => got.push(i)))!
    await act(async () => img.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 })))
    await act(async () => img.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1e6 })))
    expect(got).toEqual([{ op: 'scroll', dy: 120 }, { op: 'scroll', dy: 5000 }])
  })

  it.each([
    ['loading', { status: 'loading' }, 'Loading'],
    ['error', { status: 'error', error: 'host not allowed' }, 'host not allowed'],
  ])('says so on the table while %s', async (_n, over, text) => {
    // Break caught: a blank or frozen picture that looks like the page itself.
    await mount(surf({ ...good, ...over }))
    expect(host.querySelector('[data-web-status]')?.textContent).toContain(text)
  })

  it.each([
    ['a stream off our web route', { stream: 'https://evil.example/frames' }],
    ['no stream', { stream: undefined }],
    ['an unknown status', { status: 'crashed' }],
  ])('draws nothing for %s', (_n, over) => {
    // Break caught: a display fetching a URL from the internet because a
    // surface state said so.
    expect(webRenderer(surf({ ...good, ...over }), DEFAULT_SURFACE)).toBeNull()
  })
  it('asks for a failed stream again, as a new request', async () => {
    // Break caught (review #46): one failed stream (a display that connected
    // in a gap, a server restart) left a broken picture for good.
    vi.useFakeTimers()
    try {
      const img = (await mount(surf(good)))!
      await act(async () => img.dispatchEvent(new Event('error')))
      await act(async () => vi.advanceTimersByTime(1000))
      expect(host.querySelector('img[data-web-surface]')!.getAttribute('src')).toBe('/api/web/web-1/stream?retry=1')
    } finally {
      vi.useRealTimers()
    }
  })
  it('draws nothing, and does not throw, for a surface with no state', () => {
    expect(webRenderer(surf(undefined), DEFAULT_SURFACE)).toBeNull()
  })
})
