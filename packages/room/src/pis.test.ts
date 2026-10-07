import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createPiRoom } from './pis.ts'
import type { LidarScan } from './spec.ts'

/**
 * The real-room transport against local stand-ins for the Pis and the bridge.
 *
 * Fixtures:
 * - display /status bodies: recordings (fixtures/pis, 7 Oct, read-only GETs
 *   on the room network);
 * - lidar scans: hubble-room#2's recording (fixtures/lidar/2026-10-07-wire);
 * - the /show and Hue bodies: schema-derived from display/README.md and the
 *   Hue v1 API (writes were not recorded: they would have taken the shared
 *   projector from another team).
 */
const rec = (f: string) => readFileSync(new URL(`../fixtures/pis/${f}`, import.meta.url), 'utf8')
const SCANS = readFileSync(new URL('../fixtures/lidar/2026-10-07-wire/scans.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { raw: string }).raw)

const servers: { close(): void }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

/** One HTTP stand-in per device; it records every request it gets. */
async function device(answer: (req: IncomingMessage, body: string) => { status?: number; json?: unknown } = () => ({ json: {} })) {
  const got: { method: string; url: string; type?: string; body: string }[] = []
  const srv: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      got.push({ method: req.method!, url: req.url!, type: req.headers['content-type'], body })
      const a = answer(req, body)
      res.writeHead(a.status ?? 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(a.json ?? {}))
    })
  })
  srv.listen(0, '127.0.0.1')
  await new Promise((r) => srv.once('listening', r))
  servers.push(srv)
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, got }
}

const POSE = { x: 775, y: 0, rotation: 90 }
// A port nothing listens on: a dead Pi.
const DEAD = 'http://127.0.0.1:9'

describe('createPiRoom', () => {
  it('reads each display from its own /status, and a dead Pi only drops out', async () => {
    // Catches: a dead TV Pi failing info() (and with it the runtime's start),
    // or display sizes not coming from what the kiosk really draws.
    const projector = await device((req) => ({ json: req.url === '/status' ? JSON.parse(rec('pi-projector-status.json')) : {} }))
    const tv1 = await device((req) => ({ json: req.url === '/status' ? JSON.parse(rec('pi-tv-1-status.json')) : {} }))
    const room = createPiRoom({ hosts: { table: projector.base, 'tv-1': tv1.base, 'tv-2': DEAD }, lidarPose: POSE })
    const info = await room.info()
    expect(info.displays).toEqual([
      { id: 'table', width: 1920, height: 1200 },
      { id: 'tv-1', width: 1920, height: 1080 },
    ])
    expect(info.lights.map((l) => l.id)).toContain('spot-6')
    expect(info.lidar).toEqual(POSE)
  })

  it('puts a page on a display with POST /show {url}, on that display\'s own Pi', async () => {
    // Catches: the old gateway path (/api/displays/table) or the wrong Pi.
    const projector = await device()
    const tv2 = await device()
    const room = createPiRoom({ hosts: { table: projector.base, 'tv-2': tv2.base }, lidarPose: POSE })
    expect(await room.show('table', { type: 'url', url: 'http://192.168.42.18:5173/table' })).toEqual({ ok: true })
    expect(await room.show('tv-2', { type: 'idle' })).toEqual({ ok: true })
    expect(projector.got).toEqual([{ method: 'POST', url: '/show', type: 'application/json', body: '{"url":"http://192.168.42.18:5173/table"}' }])
    expect(tv2.got.map((g) => g.body)).toEqual(['{"idle":true}'])
  })

  it('says unavailable, within its deadline, when a Pi is down', async () => {
    const room = createPiRoom({ hosts: { table: DEAD }, lidarPose: POSE })
    const r = await room.show('table', { type: 'blank' })
    expect(r).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('sets a mood light on the bridge itself, as Hue v1 xy, and treats a Hue error body as a failure', async () => {
    // Catches: hex colour sent to v1 (it only takes xy/hue-sat), the wrong
    // light number, or a 200 with [{error}] counted as success.
    let refuse = false
    const hue = await device(() => ({ json: refuse ? [{ error: { description: 'unauthorized user' } }] : [{ success: {} }] }))
    const room = createPiRoom({ hosts: { hue: hue.base }, hueUser: 'u1', lidarPose: POSE })
    expect(await room.light('spot-3', { on: true, bri: 300, color: '#ff0000' })).toEqual({ ok: true })
    const g = hue.got[0]!
    expect(g.method).toBe('PUT')
    expect(g.url).toBe('/api/u1/lights/4/state')
    const body = JSON.parse(g.body) as { on: boolean; bri: number; xy: [number, number] }
    expect(body.on).toBe(true)
    expect(body.bri).toBe(254)
    // Red in the Hue gamut sits near x 0.70, y 0.30 (Philips' conversion).
    expect(body.xy[0]).toBeGreaterThan(0.6)
    refuse = true
    expect(await room.light('spot-3', { on: false })).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('refuses lights it has no name for, and needs the Hue user', async () => {
    const room = createPiRoom({ lidarPose: POSE })
    expect(await room.light('spot-9', { on: true })).toMatchObject({ reason: 'unsupported' })
    expect(await room.light('spot-1', { on: true })).toMatchObject({ reason: 'unavailable' })
  })

  it('streams the lidar from the Pi\'s own /scan, parsed', async () => {
    // Catches: the old /api/lidar/scan?token= path (#58: zero scans delivered).
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/scan' })
    servers.push(wss)
    await new Promise((r) => wss.once('listening', r))
    wss.on('connection', (ws) => {
      for (const raw of SCANS.slice(0, 5)) ws.send(raw)
    })
    const room = createPiRoom({ hosts: { lidar: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` }, lidarPose: POSE })
    const got: LidarScan[] = []
    await new Promise<void>((resolve) => {
      room.lidar((s) => {
        got.push(s)
        if (got.length === 5) resolve()
      })
    })
    room.close()
    expect(got[0]!.points.length).toBe((JSON.parse(SCANS[0]!) as LidarScan).points.length)
  })
})
