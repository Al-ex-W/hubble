import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLiveRoom, type Room } from '@hubble/room'
import type { OverlayLine } from '@hubble/stage'
import { createApp } from './index.ts'
import { createRuntime } from './runtime.ts'
import * as calibration from './standardCalibration.ts'
import { createKeybedClient, type KeybedClient, type KeybedTrack } from './keybed.ts'
import { startEmulator } from '../room-emulator/index.ts'
import { hasKeybedPython, loadKeybedFixtures, startKeybedSidecar, inside, centroid, pts } from './testing/keybed.ts'
import type { PianoState } from '../shared/piano.ts'

// Existing mechanical mutations of product photos, through the real sidecar.
// Faults below deliberately delay/drop that response; no invented detections.
const fx = loadKeybedFixtures()
const frame = fx.frames.find((f) => f.file === 'static.jpg')!
const bytes = fx.jpeg(frame)
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach((f) => f()); vi.restoreAllMocks() })

describe.skipIf(!hasKeybedPython)('operator piano playground', () => {
  let side: Awaited<ReturnType<typeof startKeybedSidecar>>
  let found: KeybedTrack
  beforeAll(async () => {
    side = await startKeybedSidecar()
    found = (await createKeybedClient({ url: side.url }).detect(bytes))!
  }, 20_000)
  afterAll(() => side?.stop())

  async function setup(opts: { client?: KeybedClient; calibrated?: boolean; noRoom?: boolean; now?: () => number } = {}) {
    const emu = await startEmulator(0)
    cleanups.push(() => emu.close())
    await fetch(`${emu.url}/emulator/camera`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array(bytes) })
    const room = createLiveRoom({ base: emu.url, token: emu.token, kind: 'emulator' })
    cleanups.push(() => room.close())
    const cal = join(mkdtempSync(join(tmpdir(), 'piano-test-')), 'cal.json')
    if (opts.calibrated) writeFileSync(cal, JSON.stringify({ cameraToProjector: [1, 0, 0, 0, 1, 0, 0, 0, 1] }))
    const lines: OverlayLine[] = []
    const app = createApp({ port: 0, jevApiKey: undefined, llm: { apiKey: '', baseUrl: 'https://invalid.test', model: 'aixia-labs' } }, {
      runtime: (channels) => createRuntime({ ...channels, overlay: (l) => { lines.push(l); channels.overlay(l) }, room: opts.noRoom ? undefined : room, keybed: opts.client ?? createKeybedClient({ url: side.url }), calibrationFile: cal, autoTick: false, now: opts.now }),
    })
    const server = app.listen(0)
    await new Promise<void>((r) => server.once('listening', r))
    cleanups.push(() => { app.runtime.stop(); server.close() })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const get = async (): Promise<PianoState> => (await fetch(`${base}/api/operator/piano`)).json()
    const toggle = (enabled: unknown) => fetch(`${base}/api/operator/piano`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
    return { app, room, lines, get, toggle }
  }

  it('enables before calibration and returns the exact camera frame with every detected key', async () => {
    // Fault injection: neither measured nor committed calibration is usable.
    // A missing measured file alone now correctly selects main's standard.
    vi.spyOn(calibration, 'resolveCalibration').mockReturnValueOnce(null)
    const { app, lines, get, toggle } = await setup()
    // Break: checkbox only cosmetic, or look() exits before capture without H.
    expect(await get()).toMatchObject({ enabled: false, status: 'off', snapshot: null })
    expect((await toggle('true')).status).toBe(400)
    expect((await toggle(true)).status).toBe(200)
    await vi.waitFor(async () => expect((await get()).snapshot?.keys).toHaveLength(25))
    const s = await get()
    expect(s.calibrated).toBe(false)
    // Review: a camera-space preview must never be mistaken for calibrated
    // projector geometry. An identity-H fallback survived without this.
    app.runtime.startLesson('ode-to-joy')
    expect(app.runtime.state().keys).toBe(0)
    expect(lines.filter((l) => l.layer === 'lesson').at(-1)?.shapes).toEqual([])
    expect(s.status).toBe('tracking')
    const snap = s.snapshot!
    // Break: unrelated live image fetched beside older detection geometry.
    expect(Buffer.from(snap.image.split(',')[1], 'base64')).toEqual(Buffer.from(bytes))
    expect([snap.width, snap.height]).toEqual([960, 540])
    expect(snap.keybed).toHaveLength(4)
    for (const k of snap.keys) expect(inside(centroid(k.corners), pts(frame.keys.find((x) => x.note === k.note)!.corners))).toBe(true)
    await toggle(false)
    expect(await get()).toMatchObject({ enabled: false, status: 'off', snapshot: null })
  })

  it('disable clears projected keys and refuses a response already in flight', async () => {
    let release: ((r: KeybedTrack) => void) | undefined
    let delay = false
    const client = { detect: async () => found, track: async () => delay ? new Promise<KeybedTrack>((r) => { release = r }) : found }
    const { app, get, toggle, lines } = await setup({ client, calibrated: true })
    await toggle(true)
    await vi.waitFor(async () => expect((await get()).snapshot?.keys).toHaveLength(25))
    app.runtime.startLesson('ode-to-joy')
    expect(lines.at(-1)?.shapes).toHaveLength(1)
    delay = true
    const pending = app.runtime.look()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await toggle(false)
    release!(found)
    await pending
    // Break: the old look relights keys or restores the camera after unchecking.
    expect(app.runtime.state().keys).toBe(0)
    expect(lines.at(-1)?.shapes).toHaveLength(0)
    expect(await get()).toMatchObject({ enabled: false, calibrated: true, snapshot: null })
    await app.runtime.look()
    expect(lines.at(-1)?.shapes).toHaveLength(0)
  })

  it('a rapid runtime off/on cannot adopt a detection from the previous session', async () => {
    let release!: (r: KeybedTrack) => void
    const client = { detect: async () => found, track: () => new Promise<KeybedTrack>((r) => { release = r }) }
    const { app, get, toggle } = await setup({ client, calibrated: true })
    await toggle(true)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    // Runtime controls are synchronous; the automatic loop has not captured
    // a frame in the new session yet. The old request must remain invalid.
    app.runtime.setPianoEnabled(false)
    app.runtime.setPianoEnabled(true)
    release(found)
    await new Promise((r) => setTimeout(r, 30))
    expect((await get()).snapshot).toBeNull()
    expect(app.runtime.state().keys).toBe(0)
  })

  it('lost poses and detector failures do not refresh the last measured age', async () => {
    let time = 1000
    let answer: KeybedTrack | null = found
    const { app, get, toggle } = await setup({ client: { detect: async () => answer, track: async () => answer }, calibrated: true, now: () => time })
    await toggle(true)
    await vi.waitFor(async () => expect((await get()).status).toBe('tracking'))
    time = 10000
    // A stalled loop cannot leave its last successful frame labelled live.
    expect((await get()).status).toBe('last-known')
    time = 11000
    answer = { ...found, status: 'lost' }
    await app.runtime.look()
    // Break: retained keys count as a new measurement merely because keys exist.
    expect(await get()).toMatchObject({ status: 'last-known', ageMs: 10000 })
    expect(app.runtime.state()).toMatchObject({ keySource: 'camera-stale', keysAgeMs: 10000 })
    time = 14000
    answer = null
    await app.runtime.look()
    expect(await get()).toMatchObject({ status: 'detector-unavailable', ageMs: 13000 })
    expect(app.runtime.state().keysAgeMs).toBe(13000)
  })

  it('camera failure marks the frozen preview, and recovery replaces it', async () => {
    const { app, room, get, toggle } = await setup()
    await toggle(true)
    await vi.waitFor(async () => expect((await get()).status).toBe('tracking'))
    const capture = room.cameraFrame
    room.cameraFrame = async () => { throw new Error('camera disconnected') }
    await app.runtime.look()
    // Break: periodic caller swallows a capture failure and UI stays green forever.
    expect((await get()).status).toBe('camera-unavailable')
    room.cameraFrame = capture
    await app.runtime.look()
    expect((await get()).status).toBe('tracking')
  })

  it.each(['room', 'camera-only'] as const)('%s: periodic capture makes progress when the camera is slower than the polling interval', async (source) => {
    // Review reproduction: actual 2 s scheduler, 2.2 s delayed camera edge,
    // and the real sidecar's response to static.jpg. Timers are virtual so
    // machine load cannot decide whether an old capture gets superseded.
    vi.useFakeTimers()
    let fail = true
    const room = {
      kind: 'emulator', info: async () => ({ lights: [] }), slots: async () => [],
      show: async () => ({ ok: true }), events: () => () => {},
      cameraFrame: async () => {
        await new Promise((r) => setTimeout(r, 2200))
        if (fail) throw new Error('injected camera outage')
        return bytes
      },
    } as unknown as Room
    // The camera-only case guards main's independent pi-camera source: no
    // display transport is required to inspect keys or keep capturing.
    const rt = createRuntime({ room: source === 'room' ? room : undefined,
      cameraFrame: source === 'camera-only' ? room.cameraFrame : undefined,
      overlay: () => {}, calibrationFile: '/nonexistent/slow-camera.json',
      keybed: { detect: async () => found, track: async () => found } })
    try {
      await rt.start({ table: 'table' })
      rt.setPianoEnabled(true)
      expect(rt.pianoState().available).toBe(true)
      void rt.look()
      await vi.advanceTimersByTimeAsync(2300)
      // Break: the 2 s tick invalidates even a failure, leaving Searching.
      expect(rt.pianoState().status).toBe('camera-unavailable')
      fail = false
      await vi.advanceTimersByTimeAsync(8400)
      // Break: every slow successful frame is discarded by the next tick.
      // More than one snapshot proves sustained progress, not a lucky first.
      expect(rt.pianoState().snapshot!.id).toBeGreaterThan(1)
      expect(rt.pianoState().snapshot!.keys).toHaveLength(25)
      expect(rt.pianoState().status).toBe('tracking')
    } finally { rt.stop(); vi.useRealTimers() }
  })

  it('no room is explicit rather than an indefinitely searching camera', async () => {
    const { get, toggle } = await setup({ noRoom: true })
    await toggle(true)
    expect(await get()).toMatchObject({ enabled: true, available: false, status: 'no-camera', snapshot: null })
  })
})
