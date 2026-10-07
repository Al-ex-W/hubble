import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeSurface, createStageParser, DEFAULT_SURFACE, type AssetInfo, moveSurface, raiseSurface, type SurfaceSet, type SurfacesLine, type TableSurface } from '@hubble/stage'
import { createHandPipeline, regionAt } from '../web/src/hands/pipeline.ts'
import type { Frame, Hand, Pt } from '../web/src/hands/types.ts'
import { loadRecording } from '@hubble/stage/testing'
import type { ServerConfig } from './config.ts'
import { createApp } from './index.ts'
import { createRuntime } from './runtime.ts'
import { createSurfaceGestures, surfacesAsObjects, withSurfaces } from './surfaceGestures.ts'
import { createSurfaceManager } from './surfaces.ts'
import type { SurfaceManager } from './surfaces.ts'

/**
 * Gestures on surfaces (#32).
 *
 * End to end: synthetic landmark frames (label: synthetic, the same hand
 * builder as apps/web/src/hands/pipeline.test.ts: a pinch ratio and a pen
 * point exactly as each step says) go through #42's real hand pipeline, and
 * every table event it emits is POSTed to /api/input/gesture on the real
 * server, exactly as the bench's hand panel does. The answer on the table is
 * a recorded one (`scene-linear-left`, label: recording), put there by the
 * operator's fallback, so no model is involved.
 *
 * The camera map is the identity and the keyboard→table map too, so image
 * px = keyboard mm = table px: a pen moved 200 px moves 200 table px, which
 * is the oracle, written out. Speeds: with scale 1, px/s are mm/s, against
 * the tracker's measured flick rule (peak > 700 mm/s).
 */
const config: ServerConfig = { port: 0, llm: { baseUrl: 'https://llm.invalid/v1', apiKey: '', model: 'aixia-labs' }, jevApiKey: undefined }
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const DT = 33

function hand(pen: Pt, pinch: number): Hand {
  const lm: [number, number][] = Array.from({ length: 21 }, () => [pen.x, pen.y + 60] as [number, number])
  lm[0] = [pen.x, pen.y + 160] // wrist
  lm[9] = [pen.x, pen.y + 60] // middle knuckle: palm length 100
  const half = (pinch * 100) / 2
  lm[4] = [pen.x - half, pen.y] // thumb tip
  lm[8] = [pen.x + half, pen.y] // index tip
  return { handedness: 'Right', score: 0.95, lm }
}
const CLOSED = 0.08
const OPEN = 0.33

/** Pinch at `from`, move to `to` in `n` frames, then release (or lose the hand). */
function dragFrames(from: Pt, to: Pt, n: number, end: 'release' | 'lost' = 'release'): Frame[] {
  const steps: (Hand | null)[] = []
  for (let i = 0; i < 3; i++) steps.push(hand(from, CLOSED))
  for (let i = 1; i <= n; i++) steps.push(hand({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n }, CLOSED))
  for (let i = 0; i < 3; i++) steps.push(end === 'release' ? hand(to, OPEN) : hand(to, CLOSED))
  if (end === 'lost') for (let i = 0; i < 20; i++) steps.push(null)
  return steps.map((h, i) => ({ t: i * DT, hands: h ? [h] : [] }))
}

let app: ReturnType<typeof createApp>
let server: ReturnType<ReturnType<typeof createApp>['listen']>
let base: string
beforeAll(async () => {
  app = createApp(config, { runtime: (channels) => createRuntime({ ...channels, calibrationFile: '/nonexistent/sg.json' }) })
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  app.runtime.stop()
  server.close()
})
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const surfaces = async () => ((await (await fetch(`${base}/api/surfaces`)).json()) as SurfacesLine).surfaces
const answer = async () => (await surfaces()).find((s) => s.kind === 'answer')

/** Run frames through the real pipeline and post every table event, as the bench does. */
async function play(frames: Frame[]) {
  const p = createHandPipeline({ camToKb: I, scale: 1, kbToTable: I })
  const sent: string[] = []
  for (const f of frames)
    for (const e of p.push(f).table) {
      // The bench's postGesture: a tap's path is keyboard evidence, not part of the schema.
      const { t: _t, ...rest } = e as typeof e & { t: number }
      const g = rest.type === 'tap' ? { type: 'tap', p: rest.p, region: rest.region } : rest
      const res = await post('/api/input/gesture', g)
      expect(res.status, JSON.stringify(g)).toBe(202)
      sent.push(rest.type)
    }
  return sent
}

/** A recorded answer on the table, and a grab point on it that is open table to the tracker. */
async function answerOnTable() {
  await post('/api/operator/fallback', { answer: 'linear' })
  await vi.waitFor(async () => expect((await answer())?.box.w ?? 0).toBeGreaterThan(0), { timeout: 3000 })
  const a = (await answer())!
  const at = { x: a.box.x + a.box.w / 2, y: a.box.y + 20 }
  // Precondition: outside the keyboard's widget in the identity frame, so a
  // pinch here is a table drag, not a keyboard press.
  expect(regionAt(at)).toBe('surface')
  return { a, at }
}

describe('a hand on the answer (real pipeline → HTTP → runtime)', () => {
  it('a slow drag moves the answer by exactly the hand\'s travel, and its panels move with it', async () => {
    const { a, at } = await answerOnTable()
    // 150 px right, 60 px down, over 15 frames: ~330 mm/s, well under the 700 mm/s flick.
    const sent = await play(dragFrames(at, { x: at.x + 150, y: at.y + 60 }, 15))
    expect(sent).toContain('drag-start')
    expect(sent).toContain('drag-end')
    const moved = (await answer())!
    // Break caught: gestures reaching the stream but nobody acting on them,
    // or a delta applied twice / against the wrong frame.
    expect(moved.box.x - a.box.x).toBeCloseTo(150, 6)
    expect(moved.box.y - a.box.y).toBeCloseTo(60, 6)
    // The answer's panels follow its box (StageView's offset), so what is
    // drawn is what was moved.
    const off = (moved.state as { offset: { x: number; y: number } }).offset
    expect([off.x, off.y]).toEqual([150, 60])
  })

  it('a hand lost mid-drag puts the answer back where it was grabbed', async () => {
    const { a, at } = await answerOnTable()
    await play(dragFrames(at, { x: at.x + 200, y: at.y }, 10, 'lost'))
    // Break caught: the answer left wherever the camera last saw a hand.
    expect((await answer())!.box).toEqual(a.box)
  })

  it('a flick closes the answer, and the table is cleared on every display', async () => {
    const { at } = await answerOnTable()
    // 400 px in 4 frames: ~3000 mm/s at release.
    const sent = await play(dragFrames(at, { x: at.x + 400, y: at.y }, 4))
    expect(sent).toContain('drag-end')
    // Break caught: flick ignored (no way to dismiss by hand), or the surface
    // closed but the answer left drawn (closing the answer dismisses it).
    expect(await answer()).toBeUndefined()
  })

  it('a drag that starts on bare table moves nothing', async () => {
    const { a } = await answerOnTable()
    const bare = { x: 1800, y: 60 }
    expect(regionAt(bare)).toBe('surface')
    expect(a.box.x + a.box.w < bare.x || a.box.y > bare.y).toBe(true)
    await play(dragFrames(bare, { x: 1700, y: 160 }, 15))
    expect((await answer())!.box).toEqual(a.box)
  })
})

/**
 * Kind-specific routing, against a stand-in surface manager built on stage's
 * own pure ops (label: schema-derived surfaces): web surfaces (#31) and
 * pinned ones can't be opened on the real server yet, and these rules are
 * about which handler a gesture reaches, not about the set.
 */
function standIn(initial: TableSurface[], b = DEFAULT_SURFACE): SurfaceManager & { set(): SurfaceSet; replace(next: SurfaceSet): void } {
  let set: SurfaceSet = initial
  return {
    list: () => set,
    set: () => set,
    bounds: () => b,
    move: (id: string, d: { dx: number; dy: number }) => ((set = moveSurface(set, id, d, b)), true),
    raise: (id: string) => ((set = raiseSurface(set, id)), true),
    close: (id: string) => ((set = closeSurface(set, id)), true),
    replace: (next: SurfaceSet) => (set = next),
  } as unknown as SurfaceManager & { set(): SurfaceSet; replace(next: SurfaceSet): void }
}
const surf = (id: string, kind: TableSurface['kind'], box: TableSurface['box'], pinned = false): TableSurface => ({ id, kind, box, z: 1, focused: false, instance: 0, pinned, state: {} })
// Written out, not derived from the code's constant (review #49): 30 mm at
// the room's 1550/1920 mm/px is 37.16 px.
const strip = 30 / (1550 / 1920)

describe('routing by kind (stand-in manager)', () => {
  it('a drag inside a web page scrolls it; from its title strip it moves; a fling scrolls, never closes', () => {
    const m = standIn([surf('w', 'web', { x: 100, y: 100, w: 800, h: 600 })])
    const scrolls: { dx: number; dy: number }[] = []
    const g = createSurfaceGestures({ surfaces: m, handlers: { web: { scroll: (_s, d) => scrolls.push(d) } } })
    g.handle({ type: 'drag-start', p: { x: 300, y: 400 } })
    g.handle({ type: 'drag-move', p: { x: 300, y: 350 } })
    g.handle({ type: 'drag-end', p: { x: 300, y: 300 }, flick: true, cancelled: false })
    // Break caught: a page dragged around instead of scrolled, or a fast
    // scroll (a fling) closing the page under the reader.
    expect(scrolls).toEqual([{ dx: 0, dy: -50 }, { dx: 0, dy: -50 }])
    expect(m.set()[0]!.box).toMatchObject({ x: 100, y: 100 })
    // Title strip: 30 mm = 37.16 px below the top edge.
    g.handle({ type: 'drag-start', p: { x: 300, y: 100 + strip - 1 } })
    g.handle({ type: 'drag-end', p: { x: 350, y: 100 + strip - 1 }, flick: false, cancelled: false })
    expect(m.set()[0]!.box).toMatchObject({ x: 150, y: 100 })
    expect(scrolls).toHaveLength(2)
  })

  it('a tap raises the surface under it and activates it at the point inside it; keyboard taps are not surface taps', () => {
    const m = standIn([surf('a', 'web', { x: 100, y: 100, w: 400, h: 300 }), { ...surf('b', 'launcher', { x: 200, y: 150, w: 300, h: 300 }), z: 2 }])
    const hits: { id: string; local: { x: number; y: number } }[] = []
    const g = createSurfaceGestures({ surfaces: m, handlers: { launcher: { activate: (s, local) => hits.push({ id: s.id, local }) }, web: { activate: (s, local) => hits.push({ id: s.id, local }) } } })
    // (250, 200) is under both: the launcher is on top.
    g.handle({ type: 'tap', p: { x: 250, y: 200 }, region: 'surface' })
    // (120, 120) is only under the web page: it is raised above the launcher.
    g.handle({ type: 'tap', p: { x: 120, y: 120 }, region: 'surface' })
    g.handle({ type: 'tap', p: { x: 120, y: 120 }, region: 'keys' })
    // Break caught: clicks delivered in table px (a link 100 px off), to the
    // surface underneath, or keyboard taps clicking whatever lies below.
    expect(hits).toEqual([
      { id: 'b', local: { x: 50, y: 50 } },
      { id: 'a', local: { x: 20, y: 20 } },
    ])
    expect(m.set().find((s) => s.id === 'a')!.focused).toBe(true)
  })

  it('a pinned surface is raised but neither moved nor flicked away', () => {
    const m = standIn([surf('p', 'asset', { x: 100, y: 100, w: 400, h: 300 }, true)])
    const g = createSurfaceGestures({ surfaces: m })
    g.handle({ type: 'drag-start', p: { x: 200, y: 200 } })
    g.handle({ type: 'drag-move', p: { x: 400, y: 200 } })
    g.handle({ type: 'drag-end', p: { x: 600, y: 200 }, flick: true, cancelled: false })
    // Break caught: an operator-placed surface thrown off the table by a stray flick.
    expect(m.set()).toHaveLength(1)
    expect(m.set()[0]!.box).toMatchObject({ x: 100, y: 100 })
    expect(m.set()[0]!.focused).toBe(true)
  })
})

describe('the title strip is physical (review #49)', () => {
  it('on a projector at 0.5 mm/px the 30 mm strip is 60 px', () => {
    const scrolls: unknown[] = []
    const m = standIn([surf('w', 'web', { x: 0, y: 0, w: 800, h: 600 })], { widthPx: 1920, heightPx: 1080, mmPerPx: 0.5 })
    const g = createSurfaceGestures({ surfaces: m, handlers: { web: { scroll: (_s, d) => scrolls.push(d) } } })
    // 50 px down is inside 60 px: moves (on the default projector it would scroll).
    g.handle({ type: 'drag-start', p: { x: 100, y: 50 } })
    g.handle({ type: 'drag-end', p: { x: 150, y: 50 }, flick: false, cancelled: false })
    // Break caught: the strip in px for one projector only.
    expect(m.set()[0]!.box.x).toBe(50)
    expect(scrolls).toEqual([])
    g.handle({ type: 'drag-start', p: { x: 100, y: 61 } })
    g.handle({ type: 'drag-end', p: { x: 100, y: 41 }, flick: false, cancelled: false })
    expect(scrolls).toEqual([{ dx: 0, dy: -20 }])
  })
})

describe('a grab belongs to the surface it grabbed (review #49)', () => {
  // A replacement is a new opening of `answer` (stage gives it a new instance).
  const answer = (renderId: string, instance: number): TableSurface => ({ ...surf('answer', 'answer', { x: 100, y: 100, w: 400, h: 300 }), instance, state: { renderId, offset: { x: 0, y: 0 } } })

  for (const [name, end] of [
    ['a flick', { flick: true, cancelled: false }],
    ['a lost hand', { flick: false, cancelled: true }],
    ['a slow release', { flick: false, cancelled: false }],
  ] as const) {
    it(`${name} on the old answer leaves its replacement alone`, () => {
      const m = standIn([answer('r1', 1)])
      const g = createSurfaceGestures({ surfaces: m })
      g.handle({ type: 'drag-start', p: { x: 200, y: 200 } })
      g.handle({ type: 'drag-move', p: { x: 250, y: 200 } })
      // A new answer renders while the pinch is still closed: same id, new render.
      m.replace([answer('r2', 2)])
      g.handle({ type: 'drag-move', p: { x: 300, y: 200 } })
      g.handle({ type: 'drag-end', p: { x: 350, y: 200 }, ...end })
      // Break caught: the hand that grabbed answer r1 moving, putting back or
      // throwing away answer r2.
      expect(m.set()).toEqual([answer('r2', 2)])
      expect(g.grabbed()).toBeNull()
    })
  }

  // The same, released straight after the replacement with no move between
  // (review #49 round 2: the tests above always moved first, and the move's
  // check dropped the stale grab before the release's own check was
  // reached, so the release check had no test of its own). With the real
  // surface manager and the recorded answer (label: recording,
  // scene-linear-left; schema-derived gestures). The first answer is moved
  // before it is grabbed, so a wrong put-back can't pass by coincidence:
  // the replacement opens at the laid-out place, the old grab's origin
  // isn't. Adopted from the reviewer's probe.
  const LINEAR = loadRecording('scene-linear-left')
  for (const [name, end] of [
    ['a flick', { flick: true, cancelled: false }],
    ['a lost hand', { flick: false, cancelled: true }],
    ['a slow release', { flick: false, cancelled: false }],
  ] as const) {
    it(`${name} straight after the replacement leaves it alone`, () => {
      const m = createSurfaceManager({ publish: () => {} })
      const g = createSurfaceGestures({ surfaces: m })
      const render = (renderId: string) => {
        m.onRenderLine({ kind: 'start', renderId, intent: 'test', model: 'recording', t: 0, scene: LINEAR.scene! })
        const p = createStageParser()
        for (const event of [...p.push(LINEAR.text), ...p.end()]) m.onRenderLine({ kind: 'event', renderId, t: 0, event })
      }
      render('first')
      m.move('answer', { dx: 80, dy: 10 })
      const box = m.list()[0]!.box
      const at = { x: box.x + 10, y: box.y + 10 }
      g.handle({ type: 'drag-start', p: at })
      g.handle({ type: 'drag-move', p: { x: at.x + 50, y: at.y } })
      render('replacement')
      const expected = structuredClone(m.list())
      expect(expected[0]!.box.x).not.toBe(box.x) // precondition: distinct places
      g.handle({ type: 'drag-end', p: { x: at.x + 100, y: at.y }, ...end })
      // Break caught: the release's own instance check bypassed, so the old
      // grab throws away, moves, or puts the new answer at the old one's place.
      expect(m.list()).toEqual(expected)
      expect(g.grabbed()).toBeNull()
    })
  }

  it('a second drag-end (a duplicate) does nothing', () => {
    const m = standIn([surf('a', 'asset', { x: 100, y: 100, w: 400, h: 300 })])
    const g = createSurfaceGestures({ surfaces: m })
    g.handle({ type: 'drag-start', p: { x: 200, y: 200 } })
    g.handle({ type: 'drag-end', p: { x: 260, y: 200 }, flick: false, cancelled: false })
    g.handle({ type: 'drag-end', p: { x: 900, y: 200 }, flick: true, cancelled: false })
    // Break caught: the grab kept after release, so a duplicate end moved and closed it.
    expect(m.set()).toHaveLength(1)
    expect(m.set()[0]!.box).toMatchObject({ x: 160, y: 100 })
  })

  it('a surface closed by someone else mid-drag ends the drag quietly', () => {
    const m = standIn([surf('a', 'asset', { x: 100, y: 100, w: 400, h: 300 })])
    const g = createSurfaceGestures({ surfaces: m })
    g.handle({ type: 'drag-start', p: { x: 200, y: 200 } })
    m.close('a')
    // Break caught: a release on a surface that no longer exists throwing in
    // the input stream's listener (every later gesture would be lost with it).
    expect(() => g.handle({ type: 'drag-move', p: { x: 250, y: 200 } })).not.toThrow()
    expect(() => g.handle({ type: 'drag-end', p: { x: 300, y: 200 }, flick: true, cancelled: false })).not.toThrow()
    expect(g.grabbed()).toBeNull()
  })
})

describe('the scene a render runs with (review #49)', () => {
  const kb = surf('keyboard', 'keyboard', { x: 678, y: 701, w: 563, h: 328 })
  const assets: AssetInfo[] = [{ id: 'right-triangle', kind: 'image', title: 't', aspect: 0.75, url: '/u' }]
  it('keeps the asset library and the physical objects, and rebuilds surface objects from the live set', () => {
    const notebook = { id: 'notebook', kind: 'notebook' as const, box: { x: 0, y: 0, w: 10, h: 10 } }
    const stale = { id: 'surface-asset-gone', kind: 'other' as const, label: 'asset on the table', box: { x: 5, y: 5, w: 5, h: 5 } }
    const asked = { intent: 'x', scene: { surface: DEFAULT_SURFACE, objects: [notebook, stale], assets } }
    const r = withSurfaces(asked, [kb], DEFAULT_SURFACE)
    // Break caught: the library dropped whenever something is open (the model
    // can no longer show diagrams), a closed surface still in the way, or a
    // follow-up listing the same surface twice.
    expect(r.scene.assets).toBe(assets)
    expect(r.scene.objects.map((o) => o.id)).toEqual(['notebook', 'swipe-keyboard'])
    // Nothing open any more: the stale one still goes.
    expect(withSurfaces(asked, [], DEFAULT_SURFACE).scene.objects.map((o) => o.id)).toEqual(['notebook'])
    // No scene, nothing open: exactly as asked.
    const bare: { intent: string; scene?: undefined } = { intent: 'x' }
    expect(withSurfaces(bare, [], DEFAULT_SURFACE)).toBe(bare)
  })
})

describe('the scene over HTTP: a follow-up after closing an asset (review #49)', () => {
  it('keeps the library on every render and forgets a closed asset in the "next" follow-up', async () => {
    const scenes: { assets?: unknown[]; objects: { id: string }[] }[] = []
    const brain = {
      render: async (request: { scene?: (typeof scenes)[number] }, emit: (l: unknown) => void) => {
        scenes.push(request.scene!)
        const renderId = `r${scenes.length}`
        emit({ kind: 'start', renderId, intent: 'x', model: 'm', t: 0 })
        emit({ kind: 'done', renderId, t: 0, answer: 'an answer', firstContentMs: null })
      },
    }
    const a = createApp({ ...config, llm: { ...config.llm, apiKey: 'sk-test' } }, { brain: brain as never, runtime: (channels) => createRuntime({ ...channels, calibrationFile: '/nonexistent/sg3.json' }) })
    const s = a.listen(0)
    await new Promise((r) => s.once('listening', r))
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
    const p = (path: string, body: unknown) => fetch(`${b}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    try {
      await p('/api/surfaces/asset', { id: 'right-triangle' })
      await (await p('/api/render', { intent: 'show the circle too' })).text()
      await p('/api/surfaces/asset-right-triangle/close', {})
      expect((await p('/api/action', { action: 'next' })).status).toBe(202)
      await vi.waitFor(() => expect(scenes).toHaveLength(2), { timeout: 2000 })
      const ids = (i: number) => scenes[i]!.objects.map((o) => o.id)
      expect(ids(0)).toContain('surface-asset-right-triangle')
      // Break caught: the follow-up reusing the old request's obstacle for an
      // asset that is no longer on the table.
      expect(ids(1)).not.toContain('surface-asset-right-triangle')
      // Break caught: the asset library gone whenever a surface was open.
      expect(scenes.map((x) => (x.assets ?? []).length > 0)).toEqual([true, true])
    } finally {
      a.runtime.stop()
      s.close()
    }
  })
})

describe('a pinch held while its surface is closed and reopened (manager verification of #49)', () => {
  for (const [name, end] of [
    ['flicked', { flick: true, cancelled: false }],
    ['released after a move', { flick: false, cancelled: false }],
    ['lost', { flick: false, cancelled: true }],
  ] as const) {
    it(`${name}, leaves the reopened asset alone (real server over HTTP)`, async () => {
      const a = createApp(config, { runtime: (channels) => createRuntime({ ...channels, calibrationFile: '/nonexistent/sg4.json' }) })
      const s = a.listen(0)
      await new Promise((r) => s.once('listening', r))
      const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
      const p = (path: string, body: unknown = {}) => fetch(`${b}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const asset = async () => ((await (await fetch(`${b}/api/surfaces`)).json()) as SurfacesLine).surfaces.find((x) => x.kind === 'asset')
      try {
        await p('/api/surfaces/asset', { id: 'right-triangle' })
        const first = (await asset())!
        const at = { x: first.box.x + 20, y: first.box.y + 20 }
        expect((await p('/api/input/gesture', { type: 'drag-start', p: at })).status).toBe(202)
        // Closed and reopened while the pinch is still held (same id, a new opening).
        await p(`/api/surfaces/${first.id}/close`)
        await p('/api/surfaces/asset', { id: 'right-triangle' })
        const reopened = (await asset())!
        expect(reopened.id).toBe(first.id)
        expect(reopened.instance).not.toBe(first.instance)
        await p('/api/input/gesture', { type: 'drag-move', p: { x: at.x + 60, y: at.y } })
        await p('/api/input/gesture', { type: 'drag-end', p: { x: at.x + 300, y: at.y }, ...end })
        // Break caught: the old pinch, keyed on the reused id, flicking away
        // (or moving) the asset someone just opened.
        expect(await asset()).toEqual(reopened)
      } finally {
        a.runtime.stop()
        s.close()
      }
    })
  }
})

describe('a grab never outlives a new drag', () => {
  it('a drag that starts on bare table after an unfinished drag moves nothing', () => {
    // The tracker's drag-end can be lost (a dropped POST); the next drag must
    // not keep dragging the old surface.
    const m = standIn([surf('a', 'asset', { x: 100, y: 100, w: 400, h: 300 })])
    const g = createSurfaceGestures({ surfaces: m })
    g.handle({ type: 'drag-start', p: { x: 200, y: 200 } })
    g.handle({ type: 'drag-start', p: { x: 1500, y: 900 } })
    g.handle({ type: 'drag-move', p: { x: 1400, y: 800 } })
    g.handle({ type: 'drag-end', p: { x: 1300, y: 700 }, flick: true, cancelled: false })
    // Break caught: the first surface dragged (and flicked away) by a hand
    // that is nowhere near it.
    expect(m.set()).toHaveLength(1)
    expect(m.set()[0]!.box).toMatchObject({ x: 100, y: 100 })
  })
})

describe('the next answer is laid out around the surfaces on the table', () => {
  it('every surface but the answer becomes a scene object, where it is now', () => {
    const set = [surf('answer', 'answer', { x: 0, y: 0, w: 10, h: 10 }), surf('keyboard', 'keyboard', { x: 678, y: 701, w: 563, h: 328 })]
    // Break caught: the old answer listed as an obstacle for its own
    // replacement, or a moved surface reported where it used to be.
    expect(surfacesAsObjects(set)).toEqual([{ id: 'swipe-keyboard', kind: 'other', label: 'projected keyboard', box: { x: 678, y: 701, w: 563, h: 328 } }])
  })
})

describe('a hand moves an asset, and the next answer is laid out around where it is now', () => {
  it('drags a real asset surface, then a render\'s scene holds it at its new box', async () => {
    let asked: { objects: { id: string; box: unknown }[] } | null = null
    // A brain that only records the scene it was asked with (the seam is
    // the brain, as in the demo smoke; label: schema-derived lines).
    const brain = {
      render: async (request: { scene?: typeof asked }, emit: (l: unknown) => void) => {
        asked = request.scene ?? null
        emit({ kind: 'start', renderId: 'r1', intent: 'x', model: 'm', t: 0 })
        emit({ kind: 'done', renderId: 'r1', t: 0, answer: '', firstContentMs: null })
      },
    }
    const a = createApp({ ...config, llm: { ...config.llm, apiKey: 'sk-test' } }, { brain: brain as never, runtime: (channels) => createRuntime({ ...channels, calibrationFile: '/nonexistent/sg2.json' }) })
    const s = a.listen(0)
    await new Promise((r) => s.once('listening', r))
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
    try {
      expect((await fetch(`${b}/api/surfaces/asset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'right-triangle' }) })).status).toBe(200)
      const before = ((await (await fetch(`${b}/api/surfaces`)).json()) as SurfacesLine).surfaces.find((x) => x.kind === 'asset')!
      const at = { x: before.box.x + 30, y: before.box.y + 30 }
      expect(regionAt(at)).toBe('surface')
      const p = createHandPipeline({ camToKb: I, scale: 1, kbToTable: I })
      for (const f of dragFrames(at, { x: at.x + 200, y: at.y - 100 }, 20))
        for (const e of p.push(f).table) {
          const { t: _t, ...g } = e as typeof e & { t: number }
          await fetch(`${b}/api/input/gesture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(g.type === 'tap' ? { type: 'tap', p: g.p, region: g.region } : g) })
        }
      const after = ((await (await fetch(`${b}/api/surfaces`)).json()) as SurfacesLine).surfaces.find((x) => x.kind === 'asset')!
      expect([after.box.x - before.box.x, after.box.y - before.box.y].map(Math.round)).toEqual([200, -100])
      await (await fetch(`${b}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intent: 'x' }) })).text()
      // Break caught: the brain never told where the surfaces are, or told
      // where the asset was before the hand moved it, so the next answer
      // lands on top of it.
      expect(asked!.objects.find((o) => o.id === `surface-${after.id}`)?.box).toEqual(after.box)
    } finally {
      a.runtime.stop()
      s.close()
    }
  })
})
