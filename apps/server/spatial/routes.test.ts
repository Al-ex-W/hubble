import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { expect, it, vi } from 'vitest'
import { createApp } from '../index.ts'
import type { SpatialFrame } from './frame.ts'

it('exposes shared localization without room outputs and validates observation ownership', async () => {
  // Schema-derived HTTP contract. A malformed/competing producer must never
  // displace the current finger; room is absent, so no output is possible.
  const app = createApp({ port: 0, llm: { baseUrl: 'http://unused', apiKey: undefined, model: 'unused' }, jevApiKey: undefined })
  app.spatial.calibration.setCamera({ h: [1, 0, 0, 0, 1, 0, 0, 0, 1], width: 1920, height: 1080, geometry: 'room:full-frame' })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (body: unknown) => fetch(`${base}/api/spatial/observations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const abort = new AbortController()
  const frames: SpatialFrame[] = []
  try {
    // Actual HTTP contract probe: GET and SSE serialize the very same frame,
    // rather than HTTP re-running a separate transform under a newer map.
    const response = await fetch(`${base}/api/spatial/events`, { signal: abort.signal })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    void (async () => {
      let pending = ''
      try {
        for (;;) {
          const r = await reader.read()
          if (r.done) break
          pending += decoder.decode(r.value, { stream: true })
          let end: number
          while ((end = pending.indexOf('\n\n')) !== -1) {
            const packet = pending.slice(0, end); pending = pending.slice(end + 2)
            const data = packet.split('\n').find(l => l.startsWith('data: '))
            if (data) frames.push(JSON.parse(data.slice(6)))
          }
        }
      } catch { /* aborted at teardown */ }
    })()
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    const body = { session: 'a', seq: 1, capturedAt: 1, geometry: 'room:full-frame', width: 1920, height: 1080, hands: [{ index: { x: 20, y: 30 } }] }
    expect((await post(body)).status).toBe(202)
    expect((await post({ ...body, session: 'b' })).status).toBe(409)
    expect((await post({ ...body, hands: [{ index: { x: null, y: 30 } }] })).status).toBe(400)
    const state = await (await fetch(`${base}/api/spatial`)).json()
    await vi.waitFor(() => expect(frames.at(-1)?.seq).toBe(state.seq))
    expect(frames.at(-1)).toEqual(state)
    expect(state.camera.fingers[0].projector).toEqual({ x: 20, y: 30 })
    expect(state.touchEnabled).toBe(false)
  } finally {
    abort.abort()
    app.runtime.stop()
    app.spatial.stop()
    server.close()
  }
})
