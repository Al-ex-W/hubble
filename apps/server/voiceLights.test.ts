import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVoiceLevelBus } from './voiceLevel.ts'
import { WINDOW_MINUTES, WINDOW_START_MINUTE } from '@hubble/room'
import {
  ATTACK_MS, BRI_FLOOR, BRI_PEAK, COLOR_PEAK, COLOR_REST, IDLE_FALLBACK, RELEASE_MS,
  createVoiceLights, mountVoiceLights, parseStrips, roomHueWriter, startVoiceLights, stripCommandFor,
  type VoiceLightsDeps,
} from './voiceLights.ts'
import { createFakeHue } from './testing/fakeHue.ts'

/**
 * Everything here is SYNTHETIC: a fake bus publisher, a fake HueWriter and
 * vitest's fake clock. Nothing opens a socket. What these prove is the
 * driver's guards (rate, deadline, gates, restore); how the real bridge and
 * strips LOOK is unverified until the owner runs the on-site checklist
 * (docs/plans/2026-10-07-voice-lights.md).
 *
 * Oracles are independent of the implementation: the rate checks slide a
 * 1000 ms window over the recorded write timestamps themselves; the envelope
 * checks use the textbook one-pole formula written out here.
 */
// Window times come from the ONE owner (packages/room/src/window.ts, n:10–n:30 since 7 Oct
// 11:40), never typed in, so moving the window can't silently break these tests again
// (it did once: they assumed n:00–n:20). 07:MMZ is 09:MM in Stockholm (CEST).
const at = (minute: number, second = 0) => Date.parse(`2026-10-07T07:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`)
const OPEN = WINDOW_START_MINUTE, CLOSE = WINDOW_START_MINUTE + WINDOW_MINUTES
const T0 = at(OPEN + 5) // inside the window; fake clock starts here
let bus: ReturnType<typeof createVoiceLevelBus>
let fake: ReturnType<typeof createFakeHue>
let made: Array<{ stop(): void }> = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  bus = createVoiceLevelBus()
  fake = createFakeHue()
})
afterEach(() => {
  made.forEach((m) => m.stop())
  made = []
  vi.useRealTimers()
})
function make(over: Partial<VoiceLightsDeps> = {}) {
  const l = createVoiceLights({ bus, hue: fake.writer, enabled: true, isArmed: () => true, requiresWindow: false, log: () => {}, ...over })
  made.push(l)
  return l
}
const say = (level: number) => bus.publish({ level, at: Date.now(), speech: 'say-1' })
const hush = () => bus.publish({ level: 0, at: Date.now(), speech: null })
// Async advance: the driver's in-flight flag clears on a promise, which only settles when microtasks run between timers.
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms)
/** Most writes inside any 1000 ms window, over a list of timestamps. */
const maxInAnySecond = (ts: number[]) => Math.max(0, ...ts.map((t0) => ts.filter((t) => t >= t0 && t < t0 + 1000).length))

describe('rate limit (the core guard)', () => {
  it('never exceeds the per-strip and total rate under a 50 Hz burst, with no backlog', async () => {
    // Break caught: writing every frame (50/s x 2 strips = 100/s) at a shared
    // bridge that is documented for ~10 commands/s.
    make()
    for (let i = 0; i < 150; i++) { say(0.2 + 0.8 * Math.abs(Math.sin(i))); await run(20) } // 3 s at 50 Hz
    const all = fake.writes.map((w) => w.at)
    expect(all.length).toBeGreaterThan(10)
    expect(maxInAnySecond(all)).toBeLessThanOrEqual(8)
    for (const id of ['strip-tv-1', 'strip-tv-2']) {
      expect(maxInAnySecond(fake.writes.filter((w) => w.id === id).map((w) => w.at))).toBeLessThanOrEqual(4)
    }
  })
  it('drops intermediate frames: latest wins, nothing queued for later', async () => {
    // Break caught: a send queue. After the burst ends, a backlog would keep
    // writing stale levels for seconds.
    make()
    for (let i = 0; i < 100; i++) { say(i % 2 ? 1 : 0.3); await run(10) } // 1 s burst
    hush()
    await run(3000)
    const lastNonRestore = fake.writes.filter((w) => w.cmd.bri !== IDLE_FALLBACK.bri)
    const burstEnd = T0 + 1000 + 3 * 250 // one release-length of grace, not seconds
    expect(lastNonRestore.every((w) => w.at <= burstEnd + 1500)).toBe(true)
    expect(fake.writes.length).toBeLessThanOrEqual(8 * 4 + 4) // ~4 s of budget at most, burst + release + restore
  })
  it('caps a misconfigured rate at what the bridge documents', async () => {
    // Break caught: env HUBBLE_VOICE_LIGHTS_HZ=50 passed straight through.
    make({ hzPerStrip: 50, maxPerSecond: 500 })
    for (let i = 0; i < 100; i++) { say(i % 2 ? 1 : 0.1); await run(10) }
    expect(maxInAnySecond(fake.writes.map((w) => w.at))).toBeLessThanOrEqual(10)
    expect(maxInAnySecond(fake.writes.filter((w) => w.id === 'strip-tv-1').map((w) => w.at))).toBeLessThanOrEqual(5)
  })
  it('holds the TOTAL cap when there are more strips than the bridge budget allows', async () => {
    // Break caught: per-strip pacing alone (4 strips x 4/s = 16/s > the ~10/s the bridge tolerates).
    const strips = [1, 2, 3, 4].map((n) => ({ light: `strip-${n}`, tv: `tv-${n}` }))
    make({ strips })
    for (let i = 0; i < 150; i++) { say(0.5 + 0.5 * Math.sin(i / 2)); await run(20) }
    expect(fake.writes.length).toBeGreaterThan(20)
    expect(maxInAnySecond(fake.writes.map((w) => w.at))).toBeLessThanOrEqual(8)
  })
  it('caps a misconfigured TOTAL at the documented 10/s even with 3 strips at the per-strip cap', async () => {
    // Break caught: trusting maxPerSecond=500 (3 strips x 5/s = 15/s would pass the per-strip cap).
    const strips = [1, 2, 3].map((n) => ({ light: `strip-${n}`, tv: `tv-${n}` }))
    make({ strips, hzPerStrip: 50, maxPerSecond: 500 })
    for (let i = 0; i < 150; i++) { say(0.5 + 0.5 * Math.sin(i / 2)); await run(20) }
    expect(maxInAnySecond(fake.writes.map((w) => w.at))).toBeLessThanOrEqual(10)
    expect(fake.writes.length).toBeGreaterThan(20)
  })
  it('caps a misconfigured per-strip rate at 5/s', async () => {
    // Break caught: HUBBLE_VOICE_LIGHTS_HZ=50 passed through for a single strip.
    make({ strips: [{ light: 'strip-tv-1', tv: 'tv-1' }], hzPerStrip: 50 })
    for (let i = 0; i < 150; i++) { say(0.5 + 0.5 * Math.sin(i / 2)); await run(20) }
    expect(fake.writes.length).toBeGreaterThan(5)
    expect(maxInAnySecond(fake.writes.map((w) => w.at))).toBeLessThanOrEqual(5)
  })
  it('fades for as long as the send interval (transitiontime matched)', async () => {
    // Break caught: a fixed fade that overlaps the next update (mushy) or ends long before it (stepping).
    make({ hzPerStrip: 4 })
    say(0.8); await run(400)
    expect(fake.writes[0].transitionMs).toBe(300) // 250 ms interval -> 3 units of 100 ms
  })
})

describe('the envelope', () => {
  it('attacks fast and releases slower, like a one-pole follower with the documented constants', async () => {
    // Break caught: symmetric smoothing (the strip drops as jumpily as the
    // voice's syllables) or no smoothing at all.
    const l = make()
    for (let i = 0; i < 12; i++) { say(1); await run(50) } // drive to ~1
    expect(l.status().envelope).toBeGreaterThan(0.95)
    // release: speech continues (id set) but level 0
    bus.publish({ level: 0, at: Date.now(), speech: 'say-1' })
    await run(100) // two 50 ms ticks
    // The first tick after the frame still holds the peak (peak-hold by design), so 100 ms = one 50 ms release step.
    expect(l.status().envelope).toBeCloseTo(Math.exp(-50 / RELEASE_MS), 2)
    const afterRelease = l.status().envelope
    expect(afterRelease).toBeGreaterThan(0.6) // slow: still high after 100 ms
    expect(afterRelease).toBeLessThan(0.9)
  })
  it('rises faster than it falls from the same distance', async () => {
    const rise = make()
    say(1); await run(100)
    const up = rise.status().envelope // from 0 toward 1 in 100 ms
    rise.stop()
    // fresh driver driven to 1, then released for 100 ms
    const bus2 = createVoiceLevelBus()
    const fake2 = createFakeHue()
    const l2 = createVoiceLights({ bus: bus2, hue: fake2.writer, enabled: true, isArmed: () => true, requiresWindow: false, log: () => {} })
    made.push(l2)
    for (let i = 0; i < 14; i++) { bus2.publish({ level: 1, at: Date.now(), speech: 's' }); await run(50) }
    bus2.publish({ level: 0, at: Date.now(), speech: 's' })
    await run(100)
    const down = 1 - l2.status().envelope
    expect(up).toBeCloseTo(1 - Math.exp(-100 / ATTACK_MS), 1) // ~0.76
    expect(up).toBeGreaterThan(down + 0.2)
  })
  it('maps level to Hue brightness 1..254 within bounds and colours peaks lavender', async () => {
    // Break caught: bri outside 1..254 (the bridge rejects it) or a floor of 0.
    expect(stripCommandFor(0).bri).toBe(BRI_FLOOR)
    expect(stripCommandFor(1)).toEqual({ on: true, bri: BRI_PEAK, color: COLOR_PEAK })
    expect(stripCommandFor(0.5).color).toBe(COLOR_REST)
    let prev = 0
    for (let e = 0; e <= 1.0001; e += 0.05) {
      const c = stripCommandFor(e)
      expect(c.bri).toBeGreaterThanOrEqual(1)
      expect(c.bri).toBeLessThanOrEqual(254)
      expect(c.bri).toBeGreaterThanOrEqual(prev)
      prev = c.bri
    }
    expect(stripCommandFor(7).bri).toBe(254)
    expect(stripCommandFor(-3).bri).toBe(BRI_FLOOR)
  })
  it('does not light on the noise floor', async () => {
    // Break caught: mic hiss (level 0.02) holding the strips on forever.
    make()
    for (let i = 0; i < 40; i++) { bus.publish({ level: 0.02, at: Date.now(), speech: 'say-1' }); await run(50) }
    expect(Math.max(0, ...fake.writes.map((w) => w.cmd.bri))).toBeLessThanOrEqual(BRI_FLOOR)
  })
})

describe('silence', () => {
  it('returns every strip to idle, then stops its timer', async () => {
    // Break caught: strips left at the last bright value after the voice ends.
    const l = make()
    for (let i = 0; i < 30; i++) { say(0.9); await run(50) }
    hush()
    await run(3000)
    for (const id of ['strip-tv-1', 'strip-tv-2']) {
      const last = fake.writes.filter((w) => w.id === id).at(-1)!
      expect(last.cmd).toEqual(IDLE_FALLBACK)
    }
    expect(l.status().state).toBe('idle')
    expect(vi.getTimerCount()).toBe(0) // no polling left running while nothing speaks
  })
  it('treats a producer that stopped talking (tab closed mid-sentence) as silence', async () => {
    // Break caught: browser closed mid-say, so no silence frame ever arrives
    // and the strips stay lit until the server restarts.
    const l = make()
    for (let i = 0; i < 10; i++) { say(0.9); await run(50) }
    await run(4000)
    expect(fake.writes.at(-1)!.cmd).toEqual(IDLE_FALLBACK)
    expect(l.status().state).toBe('idle')
  })
  it('uses the restore hook instead of writing a guessed idle, when given', async () => {
    // Break caught: overriding the room's own mood with our constant when the runtime can restore it properly.
    const restore = vi.fn()
    make({ restore })
    for (let i = 0; i < 10; i++) { say(0.9); await run(50) }
    hush(); await run(3000)
    await vi.advanceTimersByTimeAsync(10)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(fake.writes.some((w) => w.cmd.bri === IDLE_FALLBACK.bri && w.cmd.color === IDLE_FALLBACK.color)).toBe(false)
  })
  it('a new utterance after silence lights the strips again', async () => {
    make()
    for (let i = 0; i < 10; i++) { say(0.9); await run(50) }
    hush(); await run(3000)
    const n = fake.writes.length
    for (let i = 0; i < 10; i++) { say(0.9); await run(50) }
    expect(fake.writes.length).toBeGreaterThan(n)
  })
})

describe('gates: zero writes unless enabled AND armed AND (on hardware) inside the window', () => {
  const burst = async () => { for (let i = 0; i < 40; i++) { say(0.9); await run(50) } }
  it('disabled', async () => {
    // Break caught: HUBBLE_VOICE_LIGHTS unset but the driver writing anyway.
    make({ enabled: false })
    await burst()
    expect(fake.writes).toEqual([])
  })
  it('unarmed', async () => {
    // Break caught: lights moving while the operator's "room output" switch is off.
    const l = make({ isArmed: () => false })
    await burst()
    expect(fake.writes).toEqual([])
    expect(l.status().gated).toBe('unarmed')
  })
  it('outside the hardware window on real hardware', async () => {
    // Break caught: voice pulses at :45 on another team's strips.
    vi.setSystemTime(at(CLOSE + 15))
    const l = make({ requiresWindow: true })
    await burst()
    expect(fake.writes).toEqual([])
    expect(l.status().gated).toBe('outside-window')
  })
  it('inside the window on real hardware writes', async () => {
    make({ requiresWindow: true })
    await burst()
    expect(fake.writes.length).toBeGreaterThan(0)
  })
  it('the emulator (no window required) rehearses at any time', async () => {
    // Break caught: applying the window to the emulator, which AGENTS.md allows at any time.
    vi.setSystemTime(at(CLOSE + 15))
    make({ requiresWindow: false })
    await burst()
    expect(fake.writes.length).toBeGreaterThan(0)
  })
  it('requires the window by default (fail safe)', async () => {
    vi.setSystemTime(at(CLOSE + 15))
    const l = createVoiceLights({ bus, hue: fake.writer, enabled: true, isArmed: () => true, log: () => {} })
    made.push(l)
    await burst()
    expect(fake.writes).toEqual([])
  })
  it('stops writing, and does not "restore", when the window closes mid-speech', async () => {
    // Break caught: a restore write at :20, i.e. a connection after the window.
    vi.setSystemTime(at(CLOSE - 1, 58))
    make({ requiresWindow: true })
    for (let i = 0; i < 20; i++) { say(0.9); await run(50) } // crosses the window's close
    const n = fake.writes.length
    const lastAt = fake.writes.at(-1)!.at
    expect(lastAt).toBeLessThan(at(CLOSE))
    for (let i = 0; i < 40; i++) { say(0.9); await run(50) }
    hush(); await run(3000)
    expect(fake.writes.length).toBe(n)
  })
  it('does not keep polling once a gate closes under it (operator disarms mid-speech)', async () => {
    // Break caught: a timer ticking forever behind a closed gate.
    let armed = true
    make({ isArmed: () => armed })
    for (let i = 0; i < 6; i++) { say(0.9); await run(50) }
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    armed = false
    await run(200)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('logs a closed gate once, not once per frame', async () => {
    const log = vi.fn()
    make({ isArmed: () => false, log })
    for (let i = 0; i < 300; i++) say(0.5)
    expect(log).toHaveBeenCalledTimes(1)
  })
})

describe('a slow or failing bridge never blocks anything', () => {
  it('publishing returns immediately even when the writer hangs', async () => {
    // Break caught: awaiting the write on the voice's path.
    fake.mode('hang')
    make()
    const t = performance.now()
    for (let i = 0; i < 100; i++) say(0.9)
    expect(performance.now() - t).toBeLessThan(200)
  })
  it('frees a strip at its deadline, aborts the call, and backs off before retrying', async () => {
    // Break caught: one hung request blocking that strip for good (or hammering immediately after).
    fake.mode('hang')
    make({ deadlineMs: 1000 })
    say(0.9); await run(300)
    const first = fake.writes.filter((w) => w.id === 'strip-tv-1')
    expect(first).toHaveLength(1) // inFlight: no second write while the first hangs
    for (let i = 0; i < 12; i++) { say(0.9); await run(50) } // still inside the deadline
    expect(fake.writes.filter((w) => w.id === 'strip-tv-1')).toHaveLength(1)
    await run(700) // deadline passes
    expect(first[0].aborted).toBe(true)
    fake.mode('ok')
    for (let i = 0; i < 80; i++) { say(0.9); await run(50) } // back-off (1 s) then retry
    expect(fake.writes.filter((w) => w.id === 'strip-tv-1').length).toBeGreaterThan(1)
  })
  it('backs off exponentially on errors instead of retrying at full rate', async () => {
    // Break caught: an error loop at 8 writes/s into a bridge that is already unhappy.
    // The signal swings the full range once a second so dedupe cannot hide a missing back-off:
    // the same signal against a healthy bridge must write a lot (the control run).
    const wave = async (n: number) => { for (let i = 0; i < n; i++) { say(0.5 + 0.5 * Math.sin(i / 3)); await run(50) } }
    make()
    await wave(200)
    const healthy = fake.writes.length
    expect(healthy).toBeGreaterThan(40)
    made.forEach((m) => m.stop()); made = []
    fake = createFakeHue()
    fake.mode('fail')
    const l = make()
    await wave(200) // 10 s
    expect(fake.writes.length).toBeLessThan(14) // 1+2+4 s of back-off for 2 strips, not ~80
    expect(l.status().errors).toBeGreaterThan(0)
    expect(l.status().lastError).toContain('fake bridge error')
  })
})

describe('adapter and wiring', () => {
  it('roomHueWriter sends the Room a light command with the fade in bridge units', async () => {
    const calls: Array<[string, unknown]> = []
    const w = roomHueWriter({ light: (id: string, c: never) => { calls.push([id, c]); return Promise.resolve() } })
    await w.light('strip-tv-2', { on: true, bri: 120, color: '#e0d4ff' }, { transitionMs: 300, signal: new AbortController().signal })
    expect(calls).toEqual([['strip-tv-2', { on: true, bri: 120, color: '#e0d4ff', transitiontime: 3 }]])
  })
  it('parseStrips reads env and falls back to the two TV strips', async () => {
    expect(parseStrips(undefined).map((s) => s.light)).toEqual(['strip-tv-1', 'strip-tv-2'])
    expect(parseStrips('strip-tv-1:tv-1')).toEqual([{ light: 'strip-tv-1', tv: 'tv-1' }])
  })
  it('startVoiceLights does nothing unless HUBBLE_VOICE_LIGHTS=on, and mounts /api/voice-lights when on', async () => {
    // Break caught: enabling on any truthy value ("0", "false") or without a room.
    const lightCalls: unknown[] = []
    const room = { light: (...a: unknown[]) => { lightCalls.push(a); return Promise.resolve() } } as never
    const routes: string[] = []
    const app = { get: (p: string) => { routes.push(p) } } as never
    for (const v of [undefined, '', '0', 'false', 'ON']) {
      expect(startVoiceLights({ app, bus, room, which: 'emulator', isArmed: () => true, env: { HUBBLE_VOICE_LIGHTS: v } })).toBeNull()
    }
    expect(startVoiceLights({ app, bus, room: undefined, which: 'none', isArmed: () => true, env: { HUBBLE_VOICE_LIGHTS: 'on' } })).toBeNull()
    for (let i = 0; i < 20; i++) { say(0.9); await run(50) }
    expect(lightCalls).toEqual([])
    const l = startVoiceLights({ app, bus, room, which: 'emulator', isArmed: () => true, env: { HUBBLE_VOICE_LIGHTS: 'on' } })!
    made.push(l)
    expect(routes).toEqual(['/api/voice-lights'])
    for (let i = 0; i < 20; i++) { say(0.9); await run(50) }
    expect(lightCalls.length).toBeGreaterThan(0)
  })
  it('on ROOM=live the window applies', async () => {
    vi.setSystemTime(at(CLOSE + 15))
    const room = { light: vi.fn(() => Promise.resolve()) } as never
    const l = startVoiceLights({ app: { get() {} } as never, bus, room, which: 'live', isArmed: () => true, env: { HUBBLE_VOICE_LIGHTS: 'on' } })!
    made.push(l)
    for (let i = 0; i < 20; i++) { say(0.9); await run(50) }
    expect((room as unknown as { light: { mock: { calls: unknown[] } } }).light.mock.calls).toHaveLength(0)
  })
  it('status reports the driver for the operator page', async () => {
    const l = make()
    for (let i = 0; i < 10; i++) { say(0.9); await run(50) }
    const s = l.status()
    expect(s).toMatchObject({ enabled: true, state: 'speaking', gated: null })
    expect(s.sent).toBeGreaterThan(0)
    expect(s.strips.map((x) => x.tv)).toEqual(['tv-1', 'tv-2'])
    const get: Array<(req: unknown, res: { json: (b: unknown) => void }) => void> = []
    mountVoiceLights({ get: ((_p: string, h: never) => { get.push(h) }) as never }, l)
    let body: unknown
    get[0]({}, { json: (b) => { body = b } })
    expect(body).toMatchObject({ enabled: true })
  })
})
