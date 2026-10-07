// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { catalogFor, createStageParser, DEFAULT_SURFACE, type AssetInfo, type Scene } from '@hubble/stage'
import { AssetView } from './AssetView.tsx'
import { StageView } from './StageView.tsx'

/** Label: schema-derived (library entries and an answer written to the catalog's grammar). */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const diagram: AssetInfo = { id: 'right-triangle', kind: 'image', title: 'Right triangle', aspect: 0.75, url: '/api/assets/right-triangle/file' }
const clip: AssetInfo = { id: 'pendulum', kind: 'video', title: 'Pendulum', aspect: 0.5625, url: '/api/assets/pendulum/file' }

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

describe('AssetView', () => {
  it('draws images and pages as images and video as a muted looping video, at the library aspect', async () => {
    // Break caught: a video with sound or waiting for a press nobody can make
    // on a projection; a height that differs from what the guard reserved.
    await act(async () => root.render(createElement('div', null, createElement(AssetView, { asset: diagram }), createElement(AssetView, { asset: clip }))))
    const img = host.querySelector('img')!
    expect(img.getAttribute('src')).toBe(diagram.url)
    expect(img.style.aspectRatio).toBe('1 / 0.75')
    const video = host.querySelector('video')!
    expect(video.muted).toBe(true)
    expect(video.loop).toBe(true)
    // Review #43: without autoplay a silent looping video waits forever for a
    // play press nobody can make on a projection.
    expect(video.autoplay).toBe(true)
    expect(video.getAttribute('src')).toBe(clip.url)
  })
})

describe('StageView with a library asset', () => {
  it('draws the asset inside its panel from the scene library', async () => {
    const scene: Scene = { surface: DEFAULT_SURFACE, objects: [], assets: [diagram] }
    const p = createStageParser(catalogFor(scene))
    const events = [...p.push('<Canvas><Panel x={200} y={150} w={520}><Heading>Pythagoras</Heading><Asset id="right-triangle"/></Panel></Canvas>'), ...p.end()]
    await act(async () => root.render(createElement(StageView, { events, scene, renderKey: 'a', speed: 20 })))
    for (let i = 0; i < 40 && !host.querySelector('section img'); i++) await act(() => new Promise((r) => setTimeout(r, 25)))
    // Break caught: the Asset piece reaching the renderer and drawing nothing.
    expect(host.querySelector('section[data-panel] img')?.getAttribute('src')).toBe(diagram.url)
  })

  it('a transparent answer paints only its content, so surfaces below it stay visible', async () => {
    // Review #43: the answer's table-wide frame painted opaque black over an
    // asset surface it didn't even overlap. Composed answers are transparent.
    const scene: Scene = { surface: DEFAULT_SURFACE, objects: [] }
    await act(async () => root.render(createElement(StageView, { events: [], scene, renderKey: 'b', transparent: true })))
    expect((host.querySelector('.st-frame') as HTMLElement).style.background).toBe('transparent')
    await act(async () => root.render(createElement(StageView, { events: [], scene, renderKey: 'c' })))
    expect((host.querySelector('.st-frame') as HTMLElement).style.background).toBe('')
  })
})

