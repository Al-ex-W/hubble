import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { createProjectorModeStore, mountProjectorMode } from './projectorMode.ts'

/**
 * Provenance: synthetic. No recording exists for a mode switch; the oracles
 * are the HTTP status codes and the raw SSE bytes a browser's EventSource
 * would read, not the store's own getters.
 */
let server: Server | undefined
afterEach(() => new Promise<void>((done) => { server?.closeAllConnections(); server ? server.close(() => done()) : done(); server = undefined }))

async function boot() {
  const app = express()
  app.use(express.json())
  const store = mountProjectorMode(app, createProjectorModeStore(() => new Date('2026-10-07T10:00:00Z')))
  server = createServer(app)
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (body: unknown) => fetch(`${base}/api/projector/mode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { base, post, store }
}

/** Collects raw SSE `data:` payloads as they arrive. */
function listen(base: string) {
  const events: unknown[] = []
  const req = request(`${base}/api/projector/events`, (res) => {
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => { for (const m of chunk.matchAll(/^data: (.*)$/gm)) events.push(JSON.parse(m[1])) })
  })
  req.end()
  return { events, close: () => req.destroy() }
}
const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); expect(check()).toBe(true) }

describe('projector mode route', () => {
  it('starts on canvas: a restart must never leave the table showing the test pattern', async () => {
    const { base } = await boot()
    expect(await (await fetch(`${base}/api/projector/mode`)).json()).toEqual({ mode: 'canvas', since: '2026-10-07T10:00:00.000Z' })
  })

  it('rejects anything but canvas|calibrate with 400 and leaves the mode alone (catches: an unvalidated cast reaching the projector)', async () => {
    const { post, store } = await boot()
    for (const body of [{ mode: 'party' }, { mode: '' }, { mode: 1 }, {}, { Mode: 'calibrate' }, null]) expect((await post(body)).status).toBe(400)
    expect(store.get().mode).toBe('canvas')
  })

  it('accepts both modes and returns the new state', async () => {
    const { post, base } = await boot()
    const res = await post({ mode: 'calibrate' })
    expect(res.status).toBe(200)
    expect((await res.json()).mode).toBe('calibrate')
    expect((await (await fetch(`${base}/api/projector/mode`)).json()).mode).toBe('calibrate')
  })

  it('SSE: sends the current state on connect, then every change (catches: a projector that only learns the mode at load)', async () => {
    const { base, post } = await boot()
    const sse = listen(base)
    await until(() => sse.events.length === 1)
    expect(sse.events[0]).toMatchObject({ mode: 'canvas' })
    await post({ mode: 'calibrate' })
    await until(() => sse.events.length === 2)
    expect(sse.events[1]).toMatchObject({ mode: 'calibrate' })
    await post({ mode: 'canvas' })
    await until(() => sse.events.length === 3)
    expect(sse.events[2]).toMatchObject({ mode: 'canvas' })
    sse.close()
  })

  it('re-posting the current mode does not broadcast or re-stamp the legend time', async () => {
    let t = 0
    const app = express()
    app.use(express.json())
    const store = mountProjectorMode(app, createProjectorModeStore(() => new Date(Date.UTC(2026, 9, 7, 10, 0, t++))))
    server = createServer(app)
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const sse = listen(base)
    await until(() => sse.events.length === 1)
    const first = store.set('calibrate').since
    expect(store.set('calibrate').since).toBe(first)
    await until(() => sse.events.length === 2)
    await new Promise((r) => setTimeout(r, 50))
    expect(sse.events).toHaveLength(2)
    sse.close()
  })
})
