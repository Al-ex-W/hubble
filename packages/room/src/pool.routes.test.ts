import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { createLegacyRoom } from './legacy.ts'
import { createLidarSource } from './lidarSource.ts'
import { createLiveRoom } from './live.ts'
import { createPiRoom } from './pis.ts'
import { createDevicePool, HardwareWindowClosed } from './pool.ts'

/**
 * Every transport in stage 0's table goes through the device pool, proved
 * by behaviour (the architecture test proves it by source). Each transport
 * gets a pool whose clock reads 09:45 Stockholm and which treats the
 * loopback stand-in as a device. Oracle: the stand-in's own counters of
 * HTTP hits and socket connections, which must stay at zero. Label:
 * schema-derived; the paths are the transports' own.
 */
const AT_0945 = Date.parse('2026-10-07T07:45:00.000Z')
const closed = () => createDevicePool({ now: () => AT_0945, isDevice: () => true })

let server: Server
let base = ''
let hits = 0
let sockets = 0
beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++
    res.end('{}')
  })
  new WebSocketServer({ server }).on('connection', () => sockets++)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))))
const settle = () => new Promise((r) => setTimeout(r, 100))

it('live.ts: reads, writes, subscriptions and draw sockets are all refused at :45', async () => {
  // Break caught: any of live.ts's four paths (GET, POST, keepAlive, draw)
  // reaching the room outside the window.
  hits = sockets = 0
  const room = createLiveRoom({ base, token: 't', pool: closed() })
  await expect(room.info()).rejects.toBeInstanceOf(HardwareWindowClosed)
  expect(await room.show('table', { type: 'blank' })).toMatchObject({ ok: false, reason: 'unavailable' })
  await expect(room.cameraFrame()).rejects.toBeInstanceOf(HardwareWindowClosed)
  const stop = room.events(() => {})
  expect(await room.draw('table', { shapes: [] } as never)).toMatchObject({ ok: false, reason: 'unavailable' })
  await settle()
  stop()
  room.close()
  expect([hits, sockets]).toEqual([0, 0])
})

it('legacy.ts: the NUC is refused at :45', async () => {
  // Break caught: the node:https path (legacy) skipping the pool.
  hits = 0
  const room = createLegacyRoom({ base, pool: closed() })
  await expect(room.info()).rejects.toBeInstanceOf(HardwareWindowClosed)
  expect(await room.show('table', { type: 'blank' })).toMatchObject({ ok: false })
  expect(hits).toBe(0)
})

it('pis.ts: Pis, the Hue bridge and the lidar socket are refused at :45', async () => {
  // Break caught: the per-Pi transport (added 7 Oct, room#3) calling fetch
  // or opening the lidar socket directly.
  hits = sockets = 0
  const room = createPiRoom({ hosts: { table: base, 'tv-1': base, 'tv-2': base, lidar: base.replace('http', 'ws'), hue: base }, hueUser: 'u', lidarPose: { x: 0, y: 0, rotation: 0 }, pool: closed() })
  expect((await room.info()).displays).toEqual([])
  expect(await room.show('table', { type: 'blank' })).toMatchObject({ ok: false })
  // A real light id, so the call reaches the pool instead of stopping at "no such light".
  expect(await room.light('spot-1', { on: true })).toMatchObject({ ok: false, reason: 'unavailable', error: expect.stringMatching(/HardwareWindowClosed/) })
  await expect(room.cameraFrame()).rejects.toBeInstanceOf(HardwareWindowClosed)
  const stop = room.lidar(() => {})
  await settle()
  stop?.()
  room.close()
  expect(room.cameraStreamUrl()).toBeNull()
  expect([hits, sockets]).toEqual([0, 0])
})

it('lidarSource.ts: the scan socket is refused at :45', async () => {
  // Break caught: the read-only lidar source opening its socket around the pool.
  sockets = 0
  const src = createLidarSource({ url: base.replace('http', 'ws'), onFrame: () => {}, pool: closed() })
  await settle()
  src.stop()
  expect(sockets).toBe(0)
})
