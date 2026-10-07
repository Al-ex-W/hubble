import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLiveRoom, type LidarScan, type Room, type RoomEvent } from '@hubble/room'
import { startEmulator } from './index.ts'

/**
 * Contract: the live client against the spec-exact emulator, over real HTTP
 * and WebSockets (label: schema-derived from the organisers' spec, Draft 0.1).
 * When the real room arrives, the same client points at room.local; any
 * difference is fixed in packages/room/src/spec.ts and logged.
 */
let emu: Awaited<ReturnType<typeof startEmulator>>
let room: Room
const post = (path: string, body: unknown) =>
  fetch(`${emu.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

beforeAll(async () => {
  emu = await startEmulator(0)
  room = createLiveRoom({ base: emu.url, token: emu.token, kind: 'emulator' })
})
afterAll(() => {
  room.close()
  emu.close()
})

describe('room contract (live client ↔ emulator)', () => {
  it('reads the room: displays, lights, lidar pose', async () => {
    const info = await room.info()
    expect(info.displays.map((d) => d.id)).toEqual(['table', 'tv-1', 'tv-2'])
    expect(info.lights.some((l) => l.id === 'strip-tv-1')).toBe(true)
    expect(Number.isFinite(info.lidar.x)).toBe(true)
  })

  it('refuses a wrong token', async () => {
    const bad = createLiveRoom({ base: emu.url, token: 'nope' })
    await expect(bad.info()).rejects.toThrow(/401/)
    bad.close()
  })

  it('shows a page in our slot, and gets 423 with next_slot outside it', async () => {
    expect(await room.show('table', { type: 'url', url: 'http://laptop:5173/table' })).toEqual({ ok: true })
    await post('/emulator/slot', { team: 'other-team', minutes: 10 })
    const r = await room.show('table', { type: 'url', url: 'http://laptop:5173/table' })
    expect(r).toMatchObject({ ok: false, reason: 'locked' })
    await post('/emulator/slot', { team: emu.team, minutes: 60 })
  })

  it('answers 429 past the Hue limit, as rate-limited with a retry hint', async () => {
    const results = await Promise.all(Array.from({ length: 14 }, (_, i) => room.light('spot-1', { bri: i })))
    const limited = results.filter((r) => !r.ok)
    expect(limited.length).toBeGreaterThan(0)
    expect(limited[0]).toMatchObject({ ok: false, reason: 'rate-limited' })
  })

  it('streams lidar rotations and button events over WebSockets', async () => {
    const scans: LidarScan[] = []
    const events: RoomEvent[] = []
    const stopL = room.lidar((s) => scans.push(s))!
    const stopE = room.events((e) => events.push(e))
    await new Promise((r) => setTimeout(r, 500))
    await post('/emulator/button', { id: 'hue-button-1' })
    await new Promise((r) => setTimeout(r, 300))
    stopL()
    stopE()
    expect(scans.length).toBeGreaterThanOrEqual(3)
    expect(scans[0].points.length).toBe(500) // 360 / 0.72
    expect(events).toContainEqual({ type: 'button', id: 'hue-button-1', action: 'press' })
  })

  it('serves a camera frame as JPEG', async () => {
    const f = await room.cameraFrame()
    expect([f[0], f[1]]).toEqual([0xff, 0xd8])
  })
})
