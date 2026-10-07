import { describe, expect, it } from 'vitest'
import { createGesturePoster } from './gesturePoster.ts'

/** Label: schema-derived gesture events; a stand-in fetch whose first reply is slow. */
describe('gesture poster', () => {
  it('a slow drag-end still reaches the server before the next drag-start', async () => {
    const order: string[] = []
    let release!: () => void
    const slow = new Promise<void>((r) => (release = r))
    let first = true
    const poster = createGesturePoster(async (_url, init) => {
      const g = JSON.parse(String(init!.body)) as { type: string }
      if (first) {
        first = false
        await slow
      }
      order.push(g.type)
      return new Response(null, { status: 202 })
    })
    void poster.post({ type: 'drag-end', t: 1, p: { x: 1, y: 1 }, flick: true, cancelled: false })
    void poster.post({ type: 'drag-start', t: 2, p: { x: 5, y: 5 } })
    const last = poster.post({ type: 'drag-move', t: 3, p: { x: 6, y: 5 } })
    await new Promise((r) => setTimeout(r, 20))
    release()
    await last
    // Break caught: the old drag's flick ending (and closing) the new grab.
    expect(order).toEqual(['drag-end', 'drag-start', 'drag-move'])
  })

  it('keeps going after a failed post, and sends no pen moves', async () => {
    const sent: string[] = []
    let n = 0
    const poster = createGesturePoster(async (_url, init) => {
      if (n++ === 0) throw new TypeError('Failed to fetch')
      sent.push((JSON.parse(String(init!.body)) as { type: string }).type)
      return new Response(null, { status: 202 })
    })
    void poster.post({ type: 'drag-start', t: 1, p: { x: 1, y: 1 } })
    void poster.post({ type: 'pen-move', t: 2, p: { x: 1, y: 1 } })
    await poster.post({ type: 'drag-end', t: 3, p: { x: 1, y: 1 }, flick: false, cancelled: false })
    expect(sent).toEqual(['drag-end'])
  })
})
