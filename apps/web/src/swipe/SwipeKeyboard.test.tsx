// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createKeyboard, initialKeyboard, type KeyboardState, type Pt } from '@hubble/stage/swipe'
import { SwipeKeyboard, SWIPE_KEYBOARD_MM } from './SwipeKeyboard.tsx'

/**
 * The component's wiring, end to end with real pointer events: pointer path
 * → mm → onStroke → the keyboard reducer → the state drawn back. Since #29
 * the reducer runs in the runtime; here a stand-in owner runs the same
 * reducer (@hubble/stage/swipe's createKeyboard) and re-renders with its
 * state, exactly what the runtime and the surface set do over HTTP and SSE
 * (that path is apps/server/swipeKeyboard.test.ts). The rules themselves are
 * tested in keyboard.test.ts; this proves the component feeds them the right
 * strokes and draws what comes back.
 *
 * Fixture, label: MECHANICAL MUTATION OF LAYOUT TEMPLATES: the polyline
 * through each word's key centres, computed here by grid arithmetic, sampled
 * every 4 mm. happy-dom has no layout, so the SVG's box is stubbed: offset
 * (100, 50) px and 2 px per mm, so a pointer→mm conversion that forgets
 * either the offset or the scale lands on the wrong keys.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const K = 44
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']
const STAGGER = [0, 0.5, 1]
const KEYS_Y = 80 // the keys start 80 mm below the widget's top
const centre = (c: string) => {
  const r = ROWS.findIndex((row) => row.includes(c))
  return { x: (STAGGER[r]! + ROWS[r]!.indexOf(c)) * K + K / 2, y: KEYS_Y + r * K + K / 2 }
}
const SEND = { x: 8.75 * K, y: KEYS_Y + 3.5 * K }
// Candidate slots: 42..72 mm below the widget top, the widget's width in thirds.
const SLOT = (i: number) => ({ x: (i + 0.5) * ((10 * K) / 3), y: 57 })

function template(word: string) {
  const corners = [...word].filter((c, i) => c !== word[i - 1]).map(centre)
  const pts = [corners[0]!]
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1]!
    const b = corners[i]!
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4))
    for (let j = 1; j <= n; j++) pts.push({ x: a.x + ((b.x - a.x) * j) / n, y: a.y + ((b.y - a.y) * j) / n })
  }
  return pts
}

let host: HTMLElement
let root: Root
beforeEach(() => {
  ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  // Pointer capture is a browser nicety; happy-dom's SVG elements lack it.
  ;(Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {}
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const reducer = createKeyboard()
/** The stand-in owner: the real reducer, the state drawn back, sends recorded. */
function mount(onSend: (t: string) => void) {
  let kb: KeyboardState = initialKeyboard()
  const draw = () =>
    act(() =>
      root.render(
        createElement(SwipeKeyboard, {
          state: { text: kb.text, candidates: kb.candidates.map((c) => c.word), sent: null },
          onStroke: (points: Pt[]) => {
            const [next, out] = reducer.stroke(kb, points)
            kb = next
            if (out.kind === 'sent') onSend(out.text)
            draw()
          },
        }),
      ),
    )
  draw()
  const svg = host.querySelector('svg')!
  svg.getBoundingClientRect = () => ({ left: 100, top: 50, width: 2 * SWIPE_KEYBOARD_MM.w, height: 2 * SWIPE_KEYBOARD_MM.h, right: 0, bottom: 0, x: 100, y: 50, toJSON() {} }) as DOMRect
  const hit = host.querySelector('.swk-hit')!
  const fire = (type: string, p: { x: number; y: number }) =>
    act(() => {
      hit.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: 100 + 2 * p.x, clientY: 50 + 2 * p.y, pointerId: 1 }))
    })
  const stroke = (pts: { x: number; y: number }[]) => {
    fire('pointerdown', pts[0]!)
    for (const p of pts.slice(1)) fire('pointermove', p)
    fire('pointerup', pts.at(-1)!)
  }
  const line = () => host.querySelector('.swk-text:not(.swk-sent)')?.textContent?.replace('▍', '') ?? ''
  // Candidate words as drawn, left to right.
  const slots = () => [...host.querySelectorAll('.swk-cand')].map((g) => g.querySelector('text')?.textContent ?? '')
  return { stroke, line, slots, fire }
}

describe('SwipeKeyboard', () => {
  it('swipe "hello", swipe "hubble", tap send: one chat turn with "hello hubble"', () => {
    const sent: string[] = []
    const kb = mount((t) => sent.push(t))
    kb.stroke(template('hello'))
    // Break caught: pointer coordinates not converted to keyboard mm (the
    // decoder would see a path shifted by the 80 mm of rows above the keys).
    expect(kb.line()).toBe('hello')
    kb.stroke(template('hubble'))
    expect(kb.line()).toBe('hello hubble')
    kb.stroke([SEND])
    // Break caught: send not reaching onSend, i.e. no chat turn.
    expect(sent).toEqual(['hello hubble'])
    // And the line is clear for the next message.
    expect(kb.line()).toBe('')
  })

  it('a cancelled press on SEND sends nothing and keeps the draft', () => {
    const sent: string[] = []
    const kb = mount((t) => sent.push(t))
    kb.stroke(template('hello'))
    kb.fire('pointerdown', SEND)
    kb.fire('pointercancel', SEND)
    // Break caught (review #39): cancel committed like a release, sending a
    // draft the user never let go of on SEND.
    expect(sent).toEqual([])
    expect(kb.line()).toBe('hello')
  })

  it('candidate taps go through the same stroke rules: left = second, right = third', () => {
    const kb = mount(() => {})
    // happy-dom doesn't hit-test, so the events above reach the hit area
    // wherever it is; its extent is checked by geometry instead. It must
    // span the candidate row (42 mm below the widget top) down to the
    // bottom of the keys.
    const hit = host.querySelector('.swk-hit')!
    const top = Number(hit.getAttribute('y'))
    // Break caught: a hit area over the keys only (candidates unreachable).
    expect(top).toBeLessThanOrEqual(42)
    expect(top + Number(hit.getAttribute('height'))).toBeGreaterThanOrEqual(SWIPE_KEYBOARD_MM.h)
    kb.stroke(template('hello'))
    const [second, best] = kb.slots()
    expect(best).toBe('hello')
    kb.stroke([SLOT(0)])
    // Break caught: candidate presses not reaching the model at all.
    expect(kb.line()).toBe(second)
    // After a choice the chosen word is best; the old best is now second.
    kb.stroke(template('hello'))
    const third2 = kb.slots()[2]
    kb.stroke([SLOT(2)])
    // Break caught: the right slot choosing the best word (slot order).
    expect(kb.line()).toBe(`${second} ${third2}`)
  })

  it('a press on a candidate that drags onto the keys changes nothing', () => {
    const kb = mount(() => {})
    kb.stroke(template('hello'))
    // From the left slot down onto A: a hand passing over, not a choice.
    kb.stroke([SLOT(0), { x: 73, y: 90 }, { x: 60, y: 120 }, centre('a')])
    // Break caught (review #39): the candidate chosen on pen-down, before
    // the stroke was known, so mouse and hand disagreed.
    expect(kb.line()).toBe('hello')
  })

  it('decodes the release point even when no move reported it', () => {
    const kb = mount(() => {})
    kb.fire('pointerdown', centre('a'))
    kb.fire('pointerup', centre('s'))
    // Break caught (review #39): the stroke ending at the last move, so A→S wrote "a".
    expect(kb.line()).toBe('as')
  })
})
