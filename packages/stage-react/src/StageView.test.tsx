// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStageParser, layoutReport, type Scene, type StageEvent } from '@hubble/stage'
import { loadRecording } from '@hubble/stage/testing'
import { StageView } from './StageView.tsx'

/**
 * StageView against the brain's own report, on recorded answers (label:
 * recording). The invariant: a panel is drawn exactly where layoutReport
 * verified it. happy-dom has no layout engine, so heights are injected through
 * a ResizeObserver stand-in that reports `panelHeight` for every panel.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let panelHeight = 0
const observed = new Set<Element>()
const callbacks = new Set<ResizeObserverCallback>()
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {
    callbacks.add(cb)
  }
  observe(el: Element) {
    observed.add(el)
  }
  unobserve() {}
  disconnect() {
    callbacks.delete(this.cb)
  }
}
/** Delivers one round of measurements, as the browser would after layout. */
function deliverMeasurements() {
  const entries = [...observed].filter((el) => el.isConnected && (el as HTMLElement).dataset.panel).map((target) => ({ target }) as ResizeObserverEntry)
  for (const cb of callbacks) cb(entries, {} as ResizeObserver)
}

const parse = (text: string): StageEvent[] => {
  const p = createStageParser()
  return [...p.push(text), ...p.end()]
}

/** Where each drawn panel is, by its data-panel id. */
function drawn(host: HTMLElement) {
  return Object.fromEntries(
    [...host.querySelectorAll<HTMLElement>('section[data-panel]')].map((el) => [el.dataset.panel!, { x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width) }]),
  )
}
const verified = (events: StageEvent[], scene: Scene) =>
  Object.fromEntries(layoutReport(events, scene).panels.map((p) => [p.node, { x: p.placed.x, y: p.placed.y, w: p.placed.w }]))

let host: HTMLElement
let root: Root
beforeEach(() => {
  ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => panelHeight })
  panelHeight = 0
  observed.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Renders and lets the director reveal everything (speed 20 = 1/20 of real pacing). */
async function show(events: StageEvent[], scene: Scene, renderKey: string) {
  await act(async () => root.render(createElement(StageView, { events, scene, renderKey, speed: 20 })))
  for (let i = 0; i < 40 && Object.keys(drawn(host)).length < layoutReport(events, scene).panels.length; i++)
    await act(() => new Promise((r) => setTimeout(r, 25)))
}

describe('StageView draws the verified geometry', () => {
  it.each(['scene-crowded', 'scene-optimize', 'scene-projectile', 'scene-empty-pythagoras'])('%s: every panel lands where layoutReport put it', async (name) => {
    const rec = loadRecording(name)
    const events = parse(rec.text)
    await show(events, rec.scene!, name)
    // Break caught (#17): the renderer placed with a fixed 320 px height while
    // the report used the estimate, so e.g. scene-crowded's verified panel at
    // y 90 was drawn at y 384, and scene-projectile's at x 1330 instead of 570.
    expect(drawn(host)).toEqual(verified(events, rec.scene!))
  })

  it('a new answer is not sized with the previous answer measurements', async () => {
    // The same recorded answer asked twice: parser ids repeat ("e3"), which is
    // exactly when heights kept across renderKey leaked into the next answer.
    const rec = loadRecording('scene-optimize')
    const events = parse(rec.text)
    panelHeight = 1000 // the first answer's panels grew past the table
    await show(events, rec.scene!, 'first')
    await act(async () => deliverMeasurements())
    expect(drawn(host)).not.toEqual(verified(events, rec.scene!)) // growth was honoured

    panelHeight = 0 // the second answer has not been measured yet
    await show([...events], rec.scene!, 'second')
    expect(drawn(host)).toEqual(verified(events, rec.scene!))
  })
})

describe('panelOffset (an answer surface moved on the table)', () => {
  /** Every drawn mark's geometry, as attribute strings, in document order. */
  const marks = (h: HTMLElement) => [...h.querySelectorAll('g.st-mark > *')].map((el) => [...el.attributes].filter((a) => a.name !== 'style').map((a) => `${a.name}=${a.value}`).join(' '))

  async function showWith(events: StageEvent[], scene: Scene, renderKey: string, panelOffset?: { x: number; y: number }) {
    await act(async () => root.render(createElement(StageView, { events, scene, renderKey, speed: 20, panelOffset })))
    for (let i = 0; i < 40 && Object.keys(drawn(host)).length < layoutReport(events, scene).panels.length; i++)
      await act(() => new Promise((r) => setTimeout(r, 25)))
    // Marks draw on after their panel; give the director the same time.
    for (let i = 0; i < 20; i++) await act(() => new Promise((r) => setTimeout(r, 25)))
  }

  it.each(['scene-linear-center', 'scene-quadratic-graph'])('%s: panels move by exactly the offset, marks on the notebook stay put', async (name) => {
    const rec = loadRecording(name)
    const events = parse(rec.text)
    await showWith(events, rec.scene!, `${name}-still`)
    const marksBefore = marks(host)
    expect(marksBefore.length).toBeGreaterThan(0) // the recording really has marks to keep still

    await showWith(events, rec.scene!, `${name}-moved`, { x: 120, y: -40 })
    const want = Object.fromEntries(Object.entries(verified(events, rec.scene!)).map(([k, b]) => [k, { x: b.x + 120, y: b.y - 40, w: b.w }]))
    // Break caught: the offset not reaching the panels (the answer can't be moved).
    expect(drawn(host)).toEqual(want)
    // Break caught: moving the answer dragging its marks off the real page.
    expect(marks(host)).toEqual(marksBefore)
  })
})
