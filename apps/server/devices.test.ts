import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createDevicePool } from '@hubble/room'
import { createApp } from './index.ts'

/**
 * The server's device paths through the device pool (#73), over HTTP.
 * The camera is a loopback stand-in that counts hits, routed through the
 * device check by injection; the pool's clock is fixed. Oracle: the
 * stand-in's hit counter, and the status code the page receives. Label:
 * schema-derived; the paths are the proxy's own (/api/camera/frame).
 */
// Minutes from 09:10 Stockholm, the window's opening (n:10–n:30 since 7 Oct 11:40).
const AT = (min: number) => Date.parse('2026-10-07T07:10:00.000Z') + min * 60_000

let camera: Server
let cameraUrl = ''
let hits = 0
beforeAll(async () => {
  camera = createServer((_req, res) => {
    hits++
    res.setHeader('content-type', 'image/jpeg')
    res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  })
  camera.listen(0, '127.0.0.1')
  await once(camera, 'listening')
  cameraUrl = `http://127.0.0.1:${(camera.address() as AddressInfo).port}`
})
afterAll(() => camera.close())

async function serve(minute: number) {
  const devices = createDevicePool({ now: () => AT(minute), isDevice: () => true })
  const app = createApp({ port: 0, llm: { baseUrl: 'http://unused', apiKey: undefined, model: 'unused' }, jevApiKey: undefined, roomCameraUrl: cameraUrl }, { devices })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => (server.closeAllConnections(), server.close()) }
}

it('the camera proxy is refused at :45 without touching the camera, and says when it opens', async () => {
  // Break caught: the /api/camera/* proxy (the page's only way to the room
  // camera) reaching the Pi outside n:10–n:30, polled 4x a second by the
  // operating surface all hour.
  hits = 0
  const s = await serve(45)
  try {
    const r = await fetch(`${s.base}/api/camera/frame`)
    expect(r.status).toBe(503)
    const body = (await r.json()) as { error: string; opensAt: number }
    expect(body.error).toMatch(/n:10–n:30/)
    expect(body.opensAt).toBe(AT(60))
    expect(hits).toBe(0)
  } finally {
    s.close()
  }
})

it('inside the window the proxy reaches the camera', async () => {
  // Break caught: a pool that refuses everything, which would pass the test above for the wrong reason.
  hits = 0
  const s = await serve(5)
  try {
    const r = await fetch(`${s.base}/api/camera/frame`)
    expect(r.status).toBe(200)
    expect(hits).toBe(1)
  } finally {
    s.close()
  }
})

it('/api/devices serves the pool snapshot: the window and what is open', async () => {
  // Break caught: the operating surface unable to show whether the window is
  // open and what we hold on the room, or a route serving a different pool
  // from the one the proxies use.
  const s = await serve(45)
  try {
    const snap = (await (await fetch(`${s.base}/api/devices`)).json()) as { window: { open: boolean; opensAt: number }; connections: unknown[] }
    expect(snap.window).toMatchObject({ open: false, opensAt: AT(60) })
    expect(snap.connections).toEqual([])
  } finally {
    s.close()
  }
})
