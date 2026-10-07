import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import jpeg from 'jpeg-js'
import type { OverlayLine } from '@hubble/stage'
import { apply, createLiveRoom, type H } from '@hubble/room'
import { startEmulator } from '../room-emulator/index.ts'
import { createKeybedClient, type KeybedClient } from './keybed.ts'
import { SONGS } from './lesson/lesson.ts'
import { createRuntime } from './runtime.ts'
import { centroid, hasKeybedPython, inside, loadKeybedFixtures, pts, startKeybedSidecar, type FixtureFrame } from './testing/keybed.ts'

/**
 * The lesson act end to end through the product path (#36): the emulator's
 * camera serves a frame → runtime.look() → the real keybed sidecar → the
 * camera→projector calibration → the lesson's green key on the overlay.
 *
 * Label: mechanical mutation of a product shot (apps/keybed/fixtures) for
 * the frames; the calibration H is a fixed synthetic homography. Oracle: the
 * fixture's true key quads mapped through that same H; a key is lit right
 * when the green quad's centroid lies inside the true one (ray casting).
 */
const H_C2P: H = [1.6, 0.04, 60, -0.03, 1.6, 40, 0.00001, 0.000005, 1]
const fx = loadKeybedFixtures()
const truthInProjector = (f: FixtureFrame, note: number) => pts(f.keys.find((k) => k.note === note)!.corners).map((p) => apply(H_C2P, p))
const green = (lines: OverlayLine[]) => lines.filter((l) => l.layer === 'lesson').at(-1)?.shapes.find((s) => s.color === '#36ff7a')

function calibrationFile(h: H = H_C2P) {
  const dir = mkdtempSync(join(tmpdir(), 'hubble-cal-'))
  const file = join(dir, 'calibration.json')
  writeFileSync(file, JSON.stringify({ cameraToProjector: h }))
  return file
}

let emu: Awaited<ReturnType<typeof startEmulator>>
beforeAll(async () => {
  emu = await startEmulator(0)
})
afterAll(() => emu?.close())
const showCamera = (bytes: Uint8Array) => fetch(`${emu.url}/emulator/camera`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array(bytes) })
// The runtime's clock, advanced by press() between notes. Since #80 the
// runtime drops the same note again within 150 ms as a duplicate (one press
// arriving twice, recorded on site), so a test that fires a song's notes in
// the same instant loses its repeated notes (Ode to Joy opens E-E). Real
// playing spaces them; this clock does too, the way #80 updated
// runtime.test.ts. It starts at the real time so ages stay realistic.
let clock = Date.now()
const runtimeWith = (keybed: KeybedClient | undefined, lines: OverlayLine[], h: H = H_C2P) => {
  const runtime = createRuntime({ overlay: (l) => lines.push(l), room: createLiveRoom({ base: emu.url, token: emu.token, kind: 'emulator' }), team: emu.team, autoTick: false, calibrationFile: calibrationFile(h), keybed, now: () => clock })
  runtime.setPianoEnabled(true)
  return runtime
}

describe.skipIf(!hasKeybedPython)('the lesson lights the right real key, from the camera (#36)', () => {
  let side: { url: string; stop: () => void }
  beforeAll(async () => {
    side = await startKeybedSidecar()
  }, 20_000)
  afterAll(() => side?.stop())

  it.each(['static.jpg', 'rotated-135.jpg', 'two-hands.jpg', 'lit-key.jpg'])('%s: every note of the song lights its own key on the projector', async (file) => {
    const f = fx.frames.find((x) => x.file === file)!
    await fetch(`${side.url}/reset`, { method: 'POST' })
    await showCamera(fx.jpeg(f))
    const lines: OverlayLine[] = []
    const rt = runtimeWith(createKeybedClient({ url: side.url, deadlineMs: 5000 }), lines)
    await rt.look()
    expect(rt.state().keySource).toBe('camera')
    rt.startLesson('ode-to-joy')
    const wrong: number[] = []
    for (const note of SONGS['ode-to-joy'].notes) {
      const g = green(lines)
      // Breaks caught: keys used in camera px (no calibration); notes shifted
      // by one, which lights the neighbouring key; corners reordered.
      if (!g || !inside(centroid(g.points), truthInProjector(f, note))) wrong.push(note)
      // Corner order (near-left, near-right, far-right, far-left): each drawn
      // corner must sit near the same true corner. A reordered quad keeps its
      // centroid but crosses itself on the projector (review #41 survivor).
      else {
        const t = truthInProjector(f, note)
        const keyW = Math.hypot(t[1].x - t[0].x, t[1].y - t[0].y)
        if (g.points.some((p, i) => Math.hypot(p.x - t[i].x, p.y - t[i].y) > 0.5 * keyW)) wrong.push(note)
      }
      clock += 300 // a separate press, well over #80's 150 ms duplicate window
      rt.midi({ type: 'note-on', note, velocity: 90 })
    }
    expect(wrong).toEqual([])
    // The keyboard is in the scene for the math act's layout to avoid.
    expect(rt.seen().find((o) => o.kind === 'keyboard')).toBeTruthy()
  }, 20_000)
})

describe('when the keybed sidecar is down or loses the keyboard', () => {
  it('falls back to perceive.ts and the lesson still lights a key', async () => {
    // Label: synthetic (a white MiniLab-sized body on dark cloth, sized
    // through H_C2P and the default projector scale), as in perceive.test.ts.
    const W = 960
    const Hh = 540
    const data = Buffer.alloc(W * Hh * 4)
    // 355 x 220 mm at 0.78125 mm/px = 454 x 282 projector px; / 1.6 → camera px.
    const r = { x: 300, y: 260, w: Math.round(454 / 1.6), h: Math.round(282 / 1.6) }
    for (let y = 0; y < Hh; y++)
      for (let x = 0; x < W; x++) {
        const v = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h ? 235 : 16
        const i = (y * W + x) * 4
        data[i] = data[i + 1] = data[i + 2] = v
        data[i + 3] = 255
      }
    await showCamera(new Uint8Array(jpeg.encode({ width: W, height: Hh, data }, 85).data))
    const lines: OverlayLine[] = []
    const rt = runtimeWith(createKeybedClient({ url: 'http://127.0.0.1:9', deadlineMs: 300 }), lines)
    await rt.look()
    // Break caught: a dead sidecar leaving the lesson with no keys at all.
    expect(rt.state().keySource).toBe('perceive')
    rt.startLesson('twinkle')
    expect(green(lines)).toBeTruthy()
  })

  it('prefers the measured keys over perceive.ts when both see the keyboard', async () => {
    // Break caught: the evenly spaced fallback winning, which lights black
    // keys beside the real ones (they sit off the white-key boundaries).
    const f = fx.frames.find((x) => x.file === 'static.jpg')!
    const W = 960
    const Hh = 540
    const data = Buffer.alloc(W * Hh * 4)
    const r = { x: 300, y: 260, w: Math.round(454 / 1.6), h: Math.round(282 / 1.6) }
    for (let y = 0; y < Hh; y++)
      for (let x = 0; x < W; x++) {
        const v = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h ? 235 : 16
        const i = (y * W + x) * 4
        data[i] = data[i + 1] = data[i + 2] = v
        data[i + 3] = 255
      }
    await showCamera(new Uint8Array(jpeg.encode({ width: W, height: Hh, data }, 85).data))
    const found = { status: 'locked', visibleBlack: 10, keys: f.keys.map((k) => ({ note: k.note, black: k.black, corners: pts(k.corners) as [never, never, never, never] })) }
    const client = { track: async () => found, detect: async () => null } as unknown as KeybedClient
    const lines: OverlayLine[] = []
    const rt = runtimeWith(client, lines)
    await rt.look()
    expect(rt.state().keybed).toBeTruthy() // perceive saw a keyboard too
    rt.startLesson('ode-to-joy')
    expect(inside(centroid(green(lines)!.points), truthInProjector(f, 64))).toBe(true)
    // Review #41: the keyboard obstacle stays the whole body perceive saw
    // (controls included), not just the keys' box. Body: 454 x 282 projector
    // px at x 60 + 1.6 * 300 (H_C2P), give or take its slight perspective.
    const kb = rt.seen().find((o) => o.kind === 'keyboard')!
    expect(kb.box.w).toBeGreaterThan(400)
    expect(kb.box.h).toBeGreaterThan(240)
  })

  it('keeps the keys it has while the tracker searches, and while the sidecar is gone', async () => {
    // A stand-in client in front of the real runtime: the sequence the
    // tracker produces when hands cover everything, then the process dies.
    const f = fx.frames.find((x) => x.file === 'static.jpg')!
    const found = { status: 'locked', visibleBlack: 10, keys: f.keys.map((k) => ({ note: k.note, black: k.black, corners: pts(k.corners) as [never, never, never, never] })) }
    const answers = [found, { status: 'searching', keys: null, visibleBlack: null }, null]
    const client = { track: async () => answers.shift() ?? null, detect: async () => null } as unknown as KeybedClient
    await showCamera(fx.jpeg(f))
    const lines: OverlayLine[] = []
    const rt = runtimeWith(client, lines)
    await rt.look()
    rt.startLesson('ode-to-joy')
    const before = green(lines)!.points
    await rt.look() // searching, no keys
    // Break caught: a hand over the keys blanking the light the player follows.
    expect(rt.state().keySource).toBe('camera-stale')
    expect(green(lines)!.points).toEqual(before)
    await rt.look() // sidecar gone: the measurement is kept, marked stale (manager ruling, #41)
    expect(rt.state().keySource).toBe('camera-stale')
    expect(green(lines)!.points).toEqual(before)
  })
})

describe('review #41: who owns the keys when looks and manual placement interleave', () => {
  // A stand-in client whose answers the test releases by hand, so two looks
  // (the 2 s interval and /api/scene/seen) or a look and a manual placement
  // can genuinely overlap. Label: fixture keys (mechanical mutation) as the
  // sidecar's answers; schema-derived manual corners.
  const f = fx.frames.find((x) => x.file === 'static.jpg')!
  const found = { status: 'locked', visibleBlack: 10, keys: f.keys.map((k) => ({ note: k.note, black: k.black, corners: pts(k.corners) as [never, never, never, never] })) }
  function deferredClient() {
    const pending: ((v: unknown) => void)[] = []
    const client = { track: () => new Promise((r) => pending.push(r)), detect: async () => null } as unknown as KeybedClient
    return { client, pending }
  }
  const manual = { corners: [{ x: 400, y: 1000 }, { x: 1300, y: 1000 }, { x: 1300, y: 880 }, { x: 400, y: 880 }] as never, lowestNote: 48 }

  it('a placement made while a look is in flight is not overwritten by that look', async () => {
    // Break caught: the old frame's keys replacing the operator's placement
    // with no later look having happened.
    await showCamera(fx.jpeg(f))
    const { client, pending } = deferredClient()
    const lines: OverlayLine[] = []
    const rt = runtimeWith(client, lines)
    const look = rt.look()
    await new Promise((r) => setTimeout(r, 50)) // the frame is fetched, the sidecar is "thinking"
    rt.setKeybed(manual)
    rt.startLesson('ode-to-joy')
    const before = green(lines)!.points
    pending.shift()!(found)
    await look
    expect(rt.state().keySource).toBe('manual')
    expect(green(lines)!.points).toEqual(before)
  })

  it('two looks in flight share one frame instead of cancelling each other', async () => {
    // Break caught (audit finding): the second look bumped `generation`, so the
    // first was invalidated mid-capture and returned without committing, and
    // the 2 s tick and /api/scene/seen kept cancelling each other at slow frame
    // rates — no look ever committed the keys. Now the second joins the first:
    // the sidecar is asked once and both callers get the measured keys.
    await showCamera(fx.jpeg(f))
    const { client, pending } = deferredClient()
    const rt = runtimeWith(client, [])
    const a = rt.look()
    await new Promise((r) => setTimeout(r, 50))
    const b = rt.look()
    expect(pending).toHaveLength(1) // one frame, one sidecar call: they joined
    pending[0](found)
    const [ra, rb] = await Promise.all([a, b])
    expect(rb).toEqual(ra)
    expect(rt.state().keySource).toBe('camera')
    expect(rt.state().keys).toBe(25)
  })

  it('a manual placement takes over from keys the camera already measured', async () => {
    // Review #41 survivor: removing setKeybed's "keys = null" left every test green.
    await showCamera(fx.jpeg(f))
    const client = { track: async () => found, detect: async () => null } as unknown as KeybedClient
    const lines: OverlayLine[] = []
    const rt = runtimeWith(client, lines)
    await rt.look()
    rt.setKeybed(manual)
    rt.startLesson('ode-to-joy')
    expect(rt.state().keySource).toBe('manual')
    // E4 is white key index 9 from C3 (C3 D3 E3 F3 G3 A3 B3 C4 D4 E4): x 400 +
    // 9 * 60 .. +60 on the manual keybed (900 px / 15 white keys).
    const c = centroid(green(lines)!.points)
    expect(c.x).toBeGreaterThan(940)
    expect(c.x).toBeLessThan(1000)
  })
})

describe.skipIf(!hasKeybedPython)('a sidecar outage after a measurement never replaces it (manager verification, #41)', () => {
  // The failure the manager's probes found: the sidecar has measured the
  // keys (every note lit right), then one outage on the SAME frame (a
  // disconnect, or slower than the deadline) made the runtime fall back to
  // perceive.ts: with this calibration perceive saw nothing and the light
  // vanished; with identity perceive's guessed geometry lit 4 of 15 notes
  // outside their key. Label: the committed fixture static.jpg (mechanical
  // mutation of a product shot) through the real sidecar, then an injected
  // transport fault. Oracle: the fixture's true quads mapped by the
  // calibration in use.
  let side: { url: string; stop: () => void }
  let faults: { disconnect: string; slow: string; close: () => void }
  beforeAll(async () => {
    side = await startKeybedSidecar()
    const { createServer } = await import('node:http')
    const drop = createServer((req) => req.socket.destroy())
    const slow = createServer((req, res) => {
      req.resume()
      setTimeout(() => res.end('{}'), 2000).unref()
    })
    await Promise.all([new Promise<void>((r) => drop.listen(0, '127.0.0.1', r)), new Promise<void>((r) => slow.listen(0, '127.0.0.1', r))])
    const port = (s: typeof drop) => (s.address() as { port: number }).port
    faults = { disconnect: `http://127.0.0.1:${port(drop)}`, slow: `http://127.0.0.1:${port(slow)}`, close: () => (drop.close(), slow.close()) }
  }, 20_000)
  afterAll(() => {
    side?.stop()
    faults?.close()
  })

  const IDENTITY: H = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  it.each([
    ['the PR calibration', 'disconnect'],
    ['the PR calibration', 'timeout'],
    ['identity calibration', 'disconnect'],
    ['identity calibration', 'timeout'],
  ] as const)('%s, %s: every note still lights its own key, from the last measurement', async (cal, fault) => {
    const h = cal === 'identity calibration' ? IDENTITY : H_C2P
    const f = fx.frames.find((x) => x.file === 'static.jpg')!
    await fetch(`${side.url}/reset`, { method: 'POST' })
    await showCamera(fx.jpeg(f))
    // One client in front of the runtime, switched from the healthy sidecar
    // to a faulty transport between two looks at the same frame.
    let current = createKeybedClient({ url: side.url, deadlineMs: 5000 })
    const client = { track: (j: Uint8Array) => current.track(j), detect: (j: Uint8Array) => current.detect(j) } as KeybedClient
    const lines: OverlayLine[] = []
    const rt = runtimeWith(client, lines, h)
    await rt.look()
    expect(rt.state().keySource).toBe('camera')
    current = createKeybedClient({ url: fault === 'disconnect' ? faults.disconnect : faults.slow, deadlineMs: 300 })
    await rt.look()
    expect(rt.state().keySource).toBe('camera-stale')
    expect(rt.state().keysAgeMs).toBeGreaterThanOrEqual(0)
    rt.startLesson('ode-to-joy')
    const wrong: number[] = []
    for (const note of SONGS['ode-to-joy'].notes) {
      const g = green(lines)
      const truth = pts(f.keys.find((k) => k.note === note)!.corners).map((p) => apply(h, p))
      if (!g || !inside(centroid(g.points), truth)) wrong.push(note)
      clock += 300 // a separate press, well over #80's 150 ms duplicate window
      rt.midi({ type: 'note-on', note, velocity: 90 })
    }
    expect(wrong).toEqual([])
  }, 20_000)
})
