import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createInputs, type InputEvent } from './inputs.ts'
import { createRuntime } from './runtime.ts'
import { mountRuntime } from './runtimeRoutes.ts'

/**
 * Hand gestures from the camera reach the input stream, and nothing else
 * does. Label: schema-derived (gesture bodies written to the tracker's event
 * types). Over real HTTP: POST /api/input/gesture → SSE /api/input/events.
 */
let base = ''
let close = () => {}
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  const inputs = createInputs()
  mountRuntime(app, createRuntime({ overlay: () => {} }), inputs)
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => {
    server.closeAllConnections()
    server.close()
  }
})
afterAll(() => close())

const post = (body: unknown) => fetch(`${base}/api/input/gesture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function stream() {
  const ac = new AbortController()
  const res = await fetch(`${base}/api/input/events`, { signal: ac.signal })
  const events: InputEvent[] = []
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buf += dec.decode(value, { stream: true })
        let at = buf.indexOf('\n\n')
        while (at >= 0) {
          const frame = buf.slice(0, at)
          buf = buf.slice(at + 2)
          if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)))
          at = buf.indexOf('\n\n')
        }
      }
    } catch {
      /* closed */
    }
  })()
  return { events, close: () => ac.abort() }
}

describe('POST /api/input/gesture', () => {
  it('puts a valid gesture on the input stream, as the tracker sent it', async () => {
    const s = await stream()
    await new Promise((r) => setTimeout(r, 30))
    const drag = { type: 'drag-end', p: { x: 812.5, y: 240 }, flick: true, cancelled: false }
    expect((await post(drag)).status).toBe(202)
    expect((await post({ type: 'wake' })).status).toBe(202)
    expect((await post({ type: 'wake', p: { x: 960, y: 700 } })).status).toBe(202)
    await new Promise((r) => setTimeout(r, 50))
    expect(s.events.filter((e) => e.kind === 'gesture').map((e) => (e as Extract<InputEvent, { kind: 'gesture' }>).gesture)).toEqual([drag, { type: 'wake' }, { type: 'wake', p: { x: 960, y: 700 } }])
    s.close()
  })

  it.each([
    ['an unknown gesture type', { type: 'explode', p: { x: 1, y: 1 } }],
    ['a coordinate off in space', { type: 'tap', p: { x: 1e9, y: 0 }, region: 'keys' }],
    ['a non-number coordinate', { type: 'drag-move', p: { x: 'left', y: 0 } }],
    ['an unknown region', { type: 'pen-down', p: { x: 1, y: 1 }, region: 'everywhere' }],
    ['an oversize stroke', { type: 'stroke', region: 'keys', cancelled: false, points: Array.from({ length: 2001 }, () => ({ x: 1, y: 1 })) }],
    ['extra fields', { type: 'wake', script: 'x' }],
    ['a wake off in space', { type: 'wake', p: { x: -1e9, y: 0 } }],
  ])('refuses %s', async (_name, body) => {
    // Break caught: any page on the room network injecting arbitrary input
    // events the runtime will act on (#32).
    expect((await post(body)).status).toBe(400)
  })
})
