import { describe, expect, it } from 'vitest'
import { clientToPx, createPointerClient } from './overallMath.ts'

describe('overall view helpers', () => {
  // Break caught: the overlay → projector px mapping using a stale scale or
  // ignoring the frame's offset: every click then lands off the dot it was on.
  it('maps a click on the scaled overlay to native projector px, clamped at the edge', () => {
    const rect = { left: 100, top: 50, width: 960, height: 600 } // half scale
    expect(clientToPx({ x: 100 + 480, y: 50 + 300 }, rect)).toEqual({ x: 960, y: 600 })
    expect(clientToPx({ x: 100 + 96, y: 50 + 60 }, rect)).toEqual({ x: 192, y: 120 })
    expect(clientToPx({ x: 5000, y: -40 }, rect)).toEqual({ x: 1920, y: 0 })
    expect(clientToPx({ x: 1, y: 1 }, { ...rect, width: 0 })).toBeNull()
  })

  // Break caught: an `up` overtaking a `move` (a finger left on the table), a
  // flood of moves queueing hundreds of requests, and a motionless hold going
  // silent (the server releases a pointer it never hears from).
  it('sequences down, coalesced moves and up, and keeps a still hold alive', async () => {
    const sent: string[] = []
    let timer: (() => void) | null = null
    const c = createPointerClient(async (b) => (await new Promise((r) => setTimeout(r, 5)), sent.push(`${b.phase}${b.px ? `@${b.px.x}` : ''}`), { ok: true }), { setTimer: ((f: () => void) => ((timer = f), 1)) as never, clearTimer: (() => { timer = null }) as never })
    c.down({ x: 1, y: 1 })
    for (let x = 2; x <= 50; x++) c.move({ x, y: 1 })
    c.up()
    await c.idle()
    expect(sent[0]).toBe('down@1')
    expect(sent.at(-1)).toBe('up')
    expect(sent.length).toBeLessThan(6) // 49 moves coalesced
    // Hold: the keepalive timer re-sends the last position.
    sent.length = 0
    c.down({ x: 9, y: 9 })
    timer!()
    await c.idle()
    expect(sent).toEqual(['down@9', 'move@9'])
    c.up()
    expect(timer).toBeNull()
    await c.idle()
    expect(c.isDown()).toBe(false)
  })
})
