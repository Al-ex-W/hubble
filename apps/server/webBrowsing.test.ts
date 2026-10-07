import { describe, expect, it } from 'vitest'
import type { RenderRequest } from '@hubble/stage'
import { createRuntime, type WebInput } from './runtime.ts'
import { WEB_SIZE } from './webRoutes.ts'

/**
 * Browsing on the table (docs/plans/2026-10-07-web-browsing.md): a tap on a
 * page clicks it and focuses it, a drag scrolls it, and the keyboard's SEND
 * types into the focused page. Through the runtime only, with a recording
 * stand-in for the browser: what reaches the page is the contract, and the
 * browser's own handling of a click is web.test.ts's.
 *
 * Fixtures: schema-derived gestures (the TableGesture shapes the hand
 * tracker and, later, the lidar post). Oracle: plain box arithmetic — a
 * point at box + (100, 200) is page point (100, 200) because the viewport
 * is the box (web.ts) — and the keyboard's layout written out in mm
 * (keys 44 mm, d = 3rd key of the 2nd row with its half-key stagger, SEND
 * centred at 385, 154 mm), the same constants swipeKeyboard.test.ts uses.
 */
const MM_PER_PX = 1550 / 1920
const KEYS_Y_MM = 80
const SEND_MM = { x: 385, y: 154 }
const D_MM = { x: 22 + 2 * 44, y: 22 + 44 }

function setup() {
  const calls: string[] = []
  const web: WebInput = {
    click: async (id, x, y) => void calls.push(`click ${id} ${x},${y}`),
    scroll: async (id, dy) => void calls.push(`scroll ${id} ${dy}`),
    type: async (id, text) => void calls.push(`type ${id} ${text}`),
    key: async (id, key) => void calls.push(`key ${id} ${key}`),
  }
  const asked: string[] = []
  const rt = createRuntime({ overlay: () => {}, webInput: web, ask: (r: RenderRequest) => (asked.push(r.intent), true) })
  const page = rt.surfaces.openWeb('web-1', 'https://www.amazon.se/', WEB_SIZE)
  rt.keyboard.open()
  const kb = rt.surfaces.list().find((s) => s.kind === 'keyboard')!.box
  const onKb = (p: { x: number; y: number }) => ({ x: kb.x + p.x / MM_PER_PX, y: kb.y + (p.y + KEYS_Y_MM) / MM_PER_PX })
  const typeDAndSend = () => {
    rt.keyboard.stroke([onKb(D_MM)])
    rt.keyboard.stroke([onKb(SEND_MM)])
  }
  // Promises from the fake settle on the next ticks (type, then Enter).
  const settle = () => new Promise((r) => setTimeout(r, 0))
  return { rt, calls, asked, page, typeDAndSend, settle, onKb }
}

describe('browsing on the table', () => {
  it('a tap on a page clicks it at the page point and focuses it', () => {
    const { rt, calls, page } = setup()
    expect(rt.gesture({ type: 'tap', p: { x: page.x + 100, y: page.y + 200 }, region: 'surface' })).toBe(true)
    // Break caught: the handler not registered (a tap only raised the page,
    // the state on main before 7 Oct), or table px passed as page px.
    expect(calls).toEqual(['click web-1 100,200'])
    expect(rt.focusedWeb()).toBe('web-1')
  })

  it('a drag below the title strip scrolls the page, opposite to the finger, and leaves it where it is', () => {
    const { rt, calls, page } = setup()
    const at = { x: page.x + 300, y: page.y + 200 } // 200 px ≈ 161 mm: well below the 30 mm strip
    rt.gesture({ type: 'drag-start', p: at })
    rt.gesture({ type: 'drag-move', p: { x: at.x, y: at.y + 50 } })
    rt.gesture({ type: 'drag-end', p: { x: at.x, y: at.y + 50 }, flick: false, cancelled: false })
    // Break caught: a drag on a page moving it (no scroll handler), or
    // scrolling with the finger like a mouse wheel instead of like a phone.
    expect(calls).toEqual(['scroll web-1 -50'])
    expect(rt.surfaces.list().find((s) => s.id === 'web-1')!.box).toMatchObject({ x: page.x, y: page.y })
  })

  it('SEND types the draft into the focused page and presses Enter, and asks nobody', async () => {
    const { rt, calls, asked, page, typeDAndSend, settle } = setup()
    rt.gesture({ type: 'tap', p: { x: page.x + 100, y: page.y + 100 }, region: 'surface' })
    typeDAndSend()
    await settle()
    await settle()
    // Break caught: SEND still going to the brain while a page is focused
    // (an Amazon search answered as a maths question), or Enter pressed
    // before the text (an empty search).
    expect(calls.slice(1)).toEqual(['type web-1 d', 'key web-1 Enter'])
    expect(asked).toEqual([])
    // The draft is gone, as after any send.
    expect(rt.keyboard.state()!.text).toBe('')
  })

  // Break caught (bench, 7 Oct): the bench posts strokes with ask:false and
  // sends any 'sent' text as its own chat turn, so SEND typed "lego" into
  // Amazon *and* asked the brain "lego". A SEND the page took must not come
  // back to the caller as 'sent'.
  it('a SEND the page took is not reported as sent, so the bench does not also ask', async () => {
    const { rt, calls, page, settle, onKb } = setup()
    rt.gesture({ type: 'tap', p: { x: page.x + 100, y: page.y + 100 }, region: 'surface' })
    rt.keyboard.stroke([onKb(D_MM)], { ask: false })
    const r = rt.keyboard.stroke([onKb(SEND_MM)], { ask: false })
    await settle()
    await settle()
    expect(r.output.kind).toBe('none')
    expect(calls.slice(1)).toEqual(['type web-1 d', 'key web-1 Enter'])
  })

  it('a page that opens is focused at once: "open Amazon", then type', async () => {
    const { rt, calls, typeDAndSend, settle } = setup()
    rt.focusWeb('web-1') // what webRoutes.onOpen does for every opened page
    typeDAndSend()
    await settle()
    await settle()
    // Break caught: a freshly opened page needing a tap before the keyboard reaches it.
    expect(calls).toEqual(['type web-1 d', 'key web-1 Enter'])
  })

  it('a tap on the bare table unfocuses the page: SEND asks again', () => {
    const { rt, calls, asked, page, typeDAndSend } = setup()
    rt.gesture({ type: 'tap', p: { x: page.x + 100, y: page.y + 100 }, region: 'surface' })
    rt.gesture({ type: 'tap', p: { x: 5, y: 5 }, region: 'surface' }) // a corner of the table, no surface
    expect(rt.focusedWeb()).toBeNull()
    typeDAndSend()
    // Break caught: the page holding the keyboard forever, so a question for
    // Hubble is typed into Amazon.
    expect(asked).toEqual(['d'])
    expect(calls).toEqual(['click web-1 100,100'])
  })

  it('typing on the keys does not unfocus the page', () => {
    const { rt, page } = setup()
    rt.gesture({ type: 'tap', p: { x: page.x + 100, y: page.y + 100 }, region: 'surface' })
    // A key press arrives as a tap in the keys region (the hand tracker's
    // and the lidar arbiter's shape for presses), at a point that may not be
    // on any surface box (a press near the keyboard's edge): the region, not
    // the point, says it was typing. (A first version tapped on the page,
    // where focus survives anyway, and the mutation dropping the region
    // check survived.)
    rt.gesture({ type: 'tap', p: { x: 5, y: 5 }, region: 'keys' })
    // Break caught: every keyboard press clearing the target being typed into.
    expect(rt.focusedWeb()).toBe('web-1')
  })

  it('a closed page is never typed into: SEND falls back to asking', () => {
    const { rt, calls, asked, page, typeDAndSend } = setup()
    rt.gesture({ type: 'tap', p: { x: page.x + 100, y: page.y + 100 }, region: 'surface' })
    rt.surfaces.close('web-1')
    typeDAndSend()
    // Break caught: SEND typing into a page whose surface (and browser page) is gone.
    expect(rt.focusedWeb()).toBeNull()
    expect(asked).toEqual(['d'])
    expect(calls).toEqual(['click web-1 100,100'])
  })

  it('without a browser, pages take no gestures and SEND asks (as before)', () => {
    const asked: string[] = []
    const rt = createRuntime({ overlay: () => {}, ask: (r) => (asked.push(r.intent), true) })
    const page = rt.surfaces.openWeb('web-1', 'https://x.example/', WEB_SIZE)
    rt.gesture({ type: 'tap', p: { x: page.x + 100, y: page.y + 100 }, region: 'surface' })
    // Break caught: a lesson-only or test runtime crashing on a page tap.
    expect(rt.focusedWeb()).toBeNull()
  })
})
