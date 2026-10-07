// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { catalogFor, createStageParser, type Scene } from '@hubble/stage'
import { loadRecording } from '@hubble/stage/testing'
import { ChatPreview } from './ChatPreview.tsx'
import type { RenderRun } from './renderClient.ts'

/**
 * The bench drawing a live answer that shows a library asset (review #43).
 * Label: mechanical mutation of the recording scene-linear-left (one panel
 * with a committed library asset inserted after <Canvas>), parsed by the
 * real stage parser; only the render hook and unrelated network panels are
 * stubbed. Oracle: the asset's <img> in the DOM. Adapted from the reviewer's
 * reproduction (temp/reviews/43), which asserted the bug.
 */
const data = vi.hoisted(() => ({ current: null as RenderRun | null }))
vi.mock('./useRender.ts', () => ({ useRender: () => ({ run: vi.fn(), cancel: vi.fn(), current: data.current, runs: data.current ? [data.current] : [] }) }))
vi.mock('../lesson/OverlayLayer.tsx', () => ({ useOverlays: () => [], OverlayLayer: () => null }))
// The ripple layer subscribes to the stage stream itself; like the overlays, not under test here.
vi.mock('../table/TouchRipples.tsx', () => ({ TouchRipples: () => null }))
// A marker, not null: the one-view tests count LessonPanels, and the real one
// needs Web MIDI, which happy-dom doesn't have. Its own attribute, not the
// .lesson-panel class: HandPanel borrows that class for its look.
vi.mock('../lesson/LessonPanel.tsx', () => ({ LessonPanel: () => createElement('div', { 'data-mock': 'lesson' }) }))
vi.mock('../room/RoomPanel.tsx', () => ({ RoomPanel: () => null }))
vi.mock('../table/surfaces.ts', async (original) => ({ ...(await original<Record<string, unknown>>()), useSurfaces: () => null }))

it('a live answer draws its library asset without being pinned', async () => {
  // Break caught (review #43): the live bench drew the answer on its local
  // editable scene, which has no library, so <Asset> drew nothing until
  // "show" pinned the run's server scene.
  const rec = loadRecording('scene-linear-left')
  const scene: Scene = { ...rec.scene!, assets: [{ id: 'right-triangle', kind: 'image', title: 'Right triangle', url: '/api/assets/right-triangle/file', aspect: 0.75 }] }
  const answer = rec.text.replace('<Canvas>', '<Canvas><Panel x={1400} y={120} w={400}><Asset id="right-triangle"/></Panel>')
  const parser = createStageParser(catalogFor(scene))
  const events = [...parser.push(answer), ...parser.end()]
  data.current = { renderId: 'r43', request: { intent: 'show diagram', scene: rec.scene! }, scene, events, raw: answer, status: 'done', firstContentMs: 0, totalMs: 1, answer, drops: [], eventTimeMs: [], trace: [] }
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
  HTMLElement.prototype.scrollIntoView = () => {}
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(ChatPreview)))
    // The director paces pieces in; poll until the asset is directed rather
    // than sleeping a fixed time.
    for (let i = 0; i < 200 && !host.querySelector('img.st-asset'); i++) await act(() => new Promise((r) => setTimeout(r, 25)))
    expect(host.querySelector('img.st-asset')?.getAttribute('src')).toBe('/api/assets/right-triangle/file')
    // Composed over other surfaces, the answer frame lets them show through.
    expect(host.querySelector<HTMLElement>('.st-frame')?.style.background).toBe('transparent')
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

/**
 * One operator view (#66): the bench at / carries the show controls that
 * used to be /operator. Label: schema-derived. The operator status body is
 * the shape apps/server/operator.ts returns (as in OperatorPage.test.tsx);
 * every other request answers `{}`. Oracles are the DOM: class names and the
 * header text, not the components' own helpers.
 */
async function renderBench(status: unknown) {
  data.current = null
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/operator/status' ? status : {}))))
  HTMLElement.prototype.scrollIntoView = () => {}
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(ChatPreview)))
  await act(() => new Promise((r) => setTimeout(r, 0)))
  return {
    host,
    done: () => {
      act(() => root.unmount())
      host.remove()
      vi.unstubAllGlobals()
    },
  }
}

const STATUS = {
  act: 'math',
  mode: 'idle',
  lesson: null,
  room: { kind: 'emulator', ok: true, displays: 3, lights: 2 },
  camera: { calibrated: false, seen: 0 },
  midi: { lastAt: null, agoMs: null },
  brain: { configured: false, lastRender: null },
}

it('the bench carries the show controls, with exactly one virtual MiniLab, in the show column', async () => {
  // Breaks caught: the merge dropping the show column (the operator's buttons
  // gone from the one screen); and a second LessonPanel coming back on the
  // bench. Each LessonPanel forwards every real MIDI key to the server, so two
  // on one page send each press twice, and the bench's own one started songs
  // by /api/lesson/start, skipping the operator's act switch.
  const { host, done } = await renderBench(STATUS)
  try {
    const ops = host.querySelector('.chat-ops')
    expect(ops?.querySelector('.op.op-embedded')).not.toBeNull()
    expect(ops?.textContent).toContain('math act · idle')
    expect(host.querySelectorAll('[data-mock="lesson"]')).toHaveLength(1)
    expect(ops?.querySelector('[data-mock="lesson"]')).not.toBeNull()
  } finally {
    done()
  }
})

it('a status body without the tile fields leaves the bench up and reads as unreachable', async () => {
  // Break caught: the show column trusting any JSON as a status. A throw while
  // rendering its tiles unmounts the whole tree, so one bad body (an older
  // server, a proxy error page) would blank the bench, chat and table too.
  const { host, done } = await renderBench({})
  try {
    expect(host.querySelector('.chat-left')).not.toBeNull()
    expect(host.querySelector('.chat-ops')?.textContent).toContain('server unreachable')
  } finally {
    done()
  }
})
