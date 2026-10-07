import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import type { SurfacesLine } from '@hubble/stage'
import type { ServerConfig } from './config.ts'
import { createApp } from './index.ts'
import type { TableGesture } from './inputs.ts'
import { createLauncher, LAUNCHER_ID, type LauncherActions, type LauncherState } from './launcher.ts'
import { createSurfaceManager } from './surfaces.ts'
import { createSwipeKeyboard } from './swipeKeyboard.ts'
import { createRuntime } from './runtime.ts'
import { ownsPress } from '../web/src/table/surfaces.ts'
import { createKeyboard, initialKeyboard } from '@hubble/stage/swipe'
import type { Frame, Hand, Pt } from '../web/src/hands/types.ts'
// The product's own hand pipeline, so the recording runs exactly the code the
// bench and the room run. A test-only reach across apps; the server itself
// never imports the web app.
import { fromPrintout, keyboardToTable } from '../web/src/hands/calibration.ts'
import { createHandPipeline } from '../web/src/hands/pipeline.ts'
import type { Trace } from '../web/src/hands/types.ts'

/**
 * The launcher (#33). Labels: schema-derived gesture sequences (shaped as
 * POST /api/input/gesture carries them) on the real surface manager; and
 * the recording IMG_3537 (a real hand typing "my name is julie") through
 * the product pipeline. Oracles: the published surface set, item boxes
 * recomputed here from the plan's mm (64 mm items, 8 mm gaps, 12 mm padding)
 * with plain arithmetic, and the actions called.
 */
const MM = 1550 / 1920 // the default projector's mm per px: the room's 1.55 m band on 1920 px (7 Oct)
const px = (mm: number) => mm / MM

function setup(actions?: LauncherActions, bounds?: { widthPx: number; heightPx: number; mmPerPx: number }) {
  const calls: string[] = []
  const surfaces = createSurfaceManager({ publish: () => {}, bounds })
  // The real keyboard owner (#29), as the runtime wires it.
  const keyboard = createSwipeKeyboard({ surfaces, ask: () => false, seen: () => [] })
  const launcher = createLauncher({
    surfaces,
    actions: actions ?? { keyboard: () => (calls.push('keyboard'), keyboard.open()), lesson: () => calls.push('lesson') },
  })
  const box = () => surfaces.list().find((s) => s.id === LAUNCHER_ID)?.box
  const items = () => (surfaces.list().find((s) => s.id === LAUNCHER_ID)?.state as LauncherState | undefined)?.items ?? []
  /** Table-px centre of an item, from the published state. */
  const centre = (id: string) => {
    const it = items().find((i) => i.id === id)!
    return { x: box()!.x + it.box.x + it.box.w / 2, y: box()!.y + it.box.y + it.box.h / 2 }
  }
  const pinch = (a: { x: number; y: number }, b = a, flick = false, cancelled = false) => {
    const took = [launcher.onGesture({ type: 'drag-start', p: a }), launcher.onGesture({ type: 'drag-move', p: b }), launcher.onGesture({ type: 'drag-end', p: b, flick, cancelled })]
    return took
  }
  return { surfaces, launcher, calls, box, items, centre, pinch }
}

describe('opening', () => {
  it('a wake opens it above the palm, its items laid out in real mm', () => {
    const t = setup()
    expect(t.launcher.onGesture({ type: 'wake', p: { x: 960, y: 800 } })).toBe(true)
    // Two items: 12 + 64 + 8 + 64 + 12 = 160 mm wide, 12 + 64 + 12 = 88 mm high.
    const w = px(160)
    const h = px(88)
    // Centred on the palm in x; bottom edge 40 mm above it.
    expect(t.box()).toEqual({ x: 960 - w / 2, y: 800 - px(40) - h, w, h })
    expect(t.items().map((i) => i.id)).toEqual(['keyboard', 'lesson'])
    expect(t.items()[1]!.box).toEqual({ x: px(12 + 64 + 8), y: px(12), w: px(64), h: px(64) })
  })

  it('without a palm it opens centred, and near an edge it stays on the table', () => {
    // Break caught: an older tracker's wake opening nothing, or a palm near
    // the edge putting half the launcher off the projection.
    const a = setup()
    a.launcher.onGesture({ type: 'wake' })
    expect(a.box()).toMatchObject({ x: (1920 - px(160)) / 2, y: (1200 - px(88)) / 2 })
    const b = setup()
    b.launcher.onGesture({ type: 'wake', p: { x: 5, y: 30 } })
    expect(b.box()!.x).toBe(0)
    expect(b.box()!.y).toBe(0)
  })

  it('lists only what really opens', () => {
    // Break caught: a greyed-out promise on the table (Web before #31
    // lands), or a tap on an item that does nothing.
    const t = setup({ lesson: () => {} })
    t.launcher.onGesture({ type: 'wake' })
    expect(t.items().map((i) => i.label)).toEqual(['Lesson'])
    const none = setup({})
    expect(none.launcher.onGesture({ type: 'wake' })).toBe(true)
    expect(none.launcher.isOpen()).toBe(false)
  })
})

describe('picking', () => {
  it('a pinch-tap on Keyboard opens the keyboard surface and closes the launcher', () => {
    const t = setup()
    t.launcher.onGesture({ type: 'wake', p: { x: 960, y: 800 } })
    expect(t.pinch(t.centre('keyboard'))).toEqual([true, true, true])
    expect(t.calls).toEqual(['keyboard'])
    expect(t.surfaces.list().map((s) => s.kind)).toEqual(['keyboard'])
  })

  it('a pinch that drifts a little still picks; one that travels, ends elsewhere, is cancelled or flicked does not', () => {
    // Break caught: a short deliberate drag, or a hand lost mid-pinch,
    // opening something nobody chose.
    const drift = setup()
    drift.launcher.onGesture({ type: 'wake' })
    const c = drift.centre('lesson')
    drift.pinch(c, { x: c.x + px(10), y: c.y })
    expect(drift.calls).toEqual(['lesson'])

    for (const [name, run] of [
      ['travel', (t: ReturnType<typeof setup>, c: { x: number; y: number }) => t.pinch(c, { x: c.x + px(20), y: c.y })],
      ['ends on another item', (t: ReturnType<typeof setup>, c: { x: number; y: number }) => t.pinch(c, t.centre('keyboard'))],
      ['cancelled', (t: ReturnType<typeof setup>, c: { x: number; y: number }) => t.pinch(c, c, false, true)],
    ] as const) {
      const t = setup()
      t.launcher.onGesture({ type: 'wake' })
      run(t, t.centre('lesson'))
      expect([name, t.calls]).toEqual([name, []])
      expect([name, t.launcher.isOpen()]).toEqual([name, true])
    }
  })

  it('a short pinch that crosses the gap onto the next item picks nothing', () => {
    // Break caught: a pinch starting at Keyboard's right edge and released
    // 12 mm later just inside Lesson opening Keyboard (under the 15 mm
    // limit, so only the same-item check stops it).
    const t = setup()
    t.launcher.onGesture({ type: 'wake' })
    const b = t.box()!
    const kb = t.items()[0]!.box
    const y = b.y + kb.y + kb.h / 2
    t.pinch({ x: b.x + kb.x + kb.w - px(2), y }, { x: b.x + kb.x + kb.w + px(8 + 2), y })
    expect(t.calls).toEqual([])
  })

  it('judges travel in real mm, so a coarser projector does not loosen it', () => {
    // Break caught: travel compared in px. At 2 mm/px a 20 mm drag is only
    // 10 px, which a px limit of 15 would take as a pick.
    const t = setup(undefined, { widthPx: 1920, heightPx: 1080, mmPerPx: 2 })
    t.launcher.onGesture({ type: 'wake' })
    const c = t.centre('lesson')
    t.pinch(c, { x: c.x + 20 / 2, y: c.y })
    expect(t.calls).toEqual([])
  })

  it('opening the keyboard again raises the one keyboard where it was moved', () => {
    // Break caught: a second keyboard, or the moved keyboard jumping back.
    const t = setup()
    let first: { x: number; y: number; w: number; h: number } | undefined
    for (let i = 0; i < 2; i++) {
      t.launcher.onGesture({ type: 'wake' })
      t.pinch(t.centre('keyboard'))
      if (i === 0) {
        first = t.surfaces.list().find((s) => s.kind === 'keyboard')!.box
        t.surfaces.move('keyboard', { dx: -100, dy: -50 })
      }
    }
    const kbs = t.surfaces.list().filter((s) => s.kind === 'keyboard')
    expect(kbs).toHaveLength(1)
    // Where it was opened, plus the move.
    expect(kbs[0]!.box).toEqual({ ...first!, x: first!.x - 100, y: first!.y - 50 })
  })

  it('a pinch on the launcher but between items is taken and does nothing', () => {
    const t = setup()
    t.launcher.onGesture({ type: 'wake' })
    const b = t.box()!
    expect(t.pinch({ x: b.x + px(4), y: b.y + px(4) })).toEqual([true, true, true])
    expect(t.calls).toEqual([])
    expect(t.launcher.isOpen()).toBe(true)
  })

  it('a tap (a launcher over the projected keyboard) picks too', () => {
    const t = setup()
    t.launcher.onGesture({ type: 'wake' })
    expect(t.launcher.onGesture({ type: 'tap', p: t.centre('lesson'), region: 'keys' })).toBe(true)
    expect(t.calls).toEqual(['lesson'])
  })

  it('gestures off the launcher are not its own', () => {
    // Break caught: the launcher swallowing drags meant for other surfaces
    // (#32) or taps meant for the keyboard.
    const t = setup()
    expect(t.launcher.onGesture({ type: 'drag-start', p: { x: 10, y: 10 } })).toBe(false) // closed
    t.launcher.onGesture({ type: 'wake', p: { x: 960, y: 800 } })
    expect(t.launcher.onGesture({ type: 'drag-start', p: { x: 10, y: 1000 } })).toBe(false)
    expect(t.launcher.onGesture({ type: 'drag-end', p: { x: 10, y: 1000 }, flick: true, cancelled: false })).toBe(false)
    expect(t.launcher.onGesture({ type: 'tap', p: { x: 10, y: 1000 }, region: 'keys' })).toBe(false)
    expect(t.launcher.isOpen()).toBe(true)
  })
})

describe('review #48', () => {
  it('a press left by a launcher closed elsewhere does not reach the next launcher', () => {
    // Break caught: a drag started on the launcher, the launcher closed by
    // the surface route (or the operator), and that drag's release later
    // swallowing and closing a new launcher from a drag elsewhere.
    const t = setup()
    t.launcher.onGesture({ type: 'wake', p: { x: 960, y: 800 } })
    t.launcher.onGesture({ type: 'drag-start', p: t.centre('keyboard') })
    t.surfaces.close(LAUNCHER_ID)
    t.launcher.onGesture({ type: 'wake', p: { x: 960, y: 800 } })
    expect(t.launcher.onGesture({ type: 'drag-move', p: { x: 10, y: 10 } })).toBe(false)
    expect(t.launcher.onGesture({ type: 'drag-end', p: { x: 10, y: 10 }, flick: true, cancelled: false })).toBe(false)
    expect(t.launcher.isOpen()).toBe(true)
  })

  it('the pick limit is 15 mm: 14 picks, 16 does not', () => {
    // Break caught: the documented boundary drifting (tests at 10 and 20
    // let 18 pass).
    for (const [mm, picks] of [[14, true], [16, false]] as const) {
      const t = setup()
      t.launcher.onGesture({ type: 'wake' })
      const c = t.centre('lesson')
      t.pinch(c, { x: c.x, y: c.y + px(mm) })
      expect([mm, t.calls.length]).toEqual([mm, picks ? 1 : 0])
    }
  })

  it('opening the keyboard again raises it above a newer surface', () => {
    // Break caught: re-open returning without raising, so the keyboard stays
    // under the answer that opened after it.
    const t = setup()
    t.launcher.onGesture({ type: 'wake' })
    t.pinch(t.centre('keyboard'))
    t.surfaces.onRenderLine({ kind: 'start', renderId: 'r', intent: 'x', model: 'm', t: 0 })
    const top = () => [...t.surfaces.list()].sort((a, b) => b.z - a.z)[0]!.id
    expect(top()).toBe('answer')
    t.launcher.onGesture({ type: 'wake' })
    t.pinch(t.centre('keyboard'))
    expect(top()).toBe('keyboard')
  })

  it('the runtime\'s Lesson item starts the lesson', () => {
    // Break caught: the launcher wired to a no-op, so Lesson closed the
    // launcher and nothing happened (the smoke starts lessons by its route).
    const rt = createRuntime({ overlay: () => {}, autoTick: false })
    try {
      rt.gesture({ type: 'wake', p: { x: 960, y: 800 } })
      const l = rt.surfaces.list().find((s) => s.id === LAUNCHER_ID)!
      const it = (l.state as LauncherState).items.find((i) => i.id === 'lesson')!
      const c = { x: l.box.x + it.box.x + it.box.w / 2, y: l.box.y + it.box.y + it.box.h / 2 }
      rt.gesture({ type: 'drag-start', p: c })
      expect(rt.gesture({ type: 'drag-end', p: c, flick: false, cancelled: false })).toBe(true)
      expect(rt.state().act).toBe('lesson')
    } finally {
      rt.stop()
    }
  })

  it('end to end over the keyboard: a pinch on a launcher item picks it and types nothing; a key off it still types', () => {
    // The reviewer's reproduction: Lesson's centre placed over keyboard
    // point (65, 66), the bench mapping (530, 500) mm at 0.78125 mm/px.
    // Synthetic landmark frames through the product pipeline, the product
    // keyboard reducer and the real launcher, wired as HandPanel wires them
    // (covered = the set's launcher boxes). Break caught: two owners for one
    // press (the key typed AND the item picked).
    const kbToTable = keyboardToTable({ xMm: 530, yMm: 500 }, MM)
    const t = setup()
    t.launcher.onGesture({ type: 'wake', p: { x: 715.52, y: 934.4 } })
    const hand = (pen: Pt, pinch: number): Hand => {
      const lm: [number, number][] = Array.from({ length: 21 }, () => [pen.x, pen.y + 60] as [number, number])
      lm[0] = [pen.x, pen.y + 160]
      lm[9] = [pen.x, pen.y + 60]
      lm[4] = [pen.x - pinch * 50, pen.y]
      lm[8] = [pen.x + pinch * 50, pen.y]
      return { handedness: 'Right', score: 0.95, lm }
    }
    const tap = (pen: Pt): Frame[] => [...Array.from({ length: 4 }, () => 0.08), 0.33, 0.33].map((pinch, i) => ({ t: i * 33, hands: [hand(pen, pinch)] }))
    const run = (pen: Pt) => {
      const p = createHandPipeline({ camToKb: [1, 0, 0, 0, 1, 0, 0, 0, 1], scale: 1, kbToTable, covered: (q) => ownsPress(t.surfaces.list(), q) })
      const kb = createKeyboard()
      let state = initialKeyboard()
      for (const f of tap(pen)) {
        const step = p.push(f)
        for (const press of step.presses) [state] = kb.stroke(state, press)
        for (const e of step.table) {
          if (e.type === 'pen-move') continue
          const { t: _t, ...g } = e as typeof e & { t: number }
          t.launcher.onGesture((g.type === 'tap' ? { type: 'tap', p: g.p, region: g.region } : g) as TableGesture)
        }
      }
      return state.text
    }
    expect(run({ x: 65, y: 66 })).toBe('')
    expect(t.calls).toEqual(['lesson'])
    // The launcher closed on the pick: the same key now types.
    expect(run({ x: 65, y: 66 })).toBe('a')
  })
})

describe('closing', () => {
  it('a second open palm closes it', () => {
    const t = setup()
    t.launcher.onGesture({ type: 'wake' })
    t.launcher.onGesture({ type: 'wake' })
    expect(t.launcher.isOpen()).toBe(false)
  })
  it('a flick that starts on it closes it without picking', () => {
    const t = setup()
    t.launcher.onGesture({ type: 'wake' })
    const c = t.centre('keyboard')
    t.pinch(c, { x: c.x + 300, y: c.y }, true)
    expect(t.launcher.isOpen()).toBe(false)
    expect(t.calls).toEqual([])
  })
})

describe('the recorded typing take (IMG_3537)', () => {
  it('a real hand typing a sentence never wakes the launcher', () => {
    // Break caught: the launcher popping up mid-sentence. The take has 0
    // open-palm frames (counted, plan Evidence), so this pins the whole path
    // from landmarks to the launcher on real typing; the "never mid-press"
    // guard itself is covered by the gesture machine's synthetic tests.
    const trace = JSON.parse(readFileSync(new URL('../web/src/hands/fixtures/IMG_3537.trace.json', import.meta.url), 'utf8')) as Trace
    expect(trace.frames.length).toBe(330) // pinned: a changed recording must fail loudly
    const p = createHandPipeline({ camToKb: fromPrintout(trace.meta.calibration), scale: trace.meta.sheet.scale, kbToTable: keyboardToTable({ xMm: 530, yMm: 500 }, MM) })
    const t = setup()
    const sent: TableGesture[] = []
    for (const frame of trace.frames)
      for (const e of p.push(frame).table) {
        // What HandPanel posts: no pen-moves, no timestamps, taps without their path.
        if (e.type === 'pen-move') continue
        const { t: _t, ...g } = e as typeof e & { t: number }
        const gesture = (g.type === 'tap' ? { type: 'tap', p: g.p, region: g.region } : g) as TableGesture
        sent.push(gesture)
        expect(t.launcher.onGesture(gesture)).toBe(false)
      }
    expect(sent.filter((g) => g.type === 'stroke')).toHaveLength(4) // the four swiped words arrived
    expect(t.launcher.isOpen()).toBe(false)
  })
})

describe('the bench path, over HTTP', () => {
  const config: ServerConfig = { port: 0, llm: { baseUrl: 'https://llm.example/v1', apiKey: undefined, model: 'aixia-labs' }, jevApiKey: undefined }
  it('wake → launcher → pinch Keyboard → a keyboard surface, through the route the hand panel posts to', async () => {
    // The acceptance's bench simulation: the same POST /api/input/gesture
    // the bench's HandPanel sends, and the surface set the bench draws.
    const server = createApp(config).listen(0)
    await new Promise((r) => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const post = (g: unknown) => fetch(`${base}/api/input/gesture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(g) })
    const line = async () => (await (await fetch(`${base}/api/surfaces`)).json()) as SurfacesLine
    try {
      expect(await (await post({ type: 'wake', p: { x: 960, y: 900 } })).json()).toEqual({ ok: true, taken: true })
      const launcher = (await line()).surfaces.find((s) => s.kind === 'launcher')!
      const kb = (launcher.state as LauncherState).items.find((i) => i.id === 'keyboard')!
      const c = { x: launcher.box.x + kb.box.x + kb.box.w / 2, y: launcher.box.y + kb.box.y + kb.box.h / 2 }
      await post({ type: 'drag-start', p: c })
      expect(await (await post({ type: 'drag-end', p: c, flick: false, cancelled: false })).json()).toEqual({ ok: true, taken: true })
      expect((await line()).surfaces.map((s) => s.kind)).toEqual(['keyboard'])
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})
