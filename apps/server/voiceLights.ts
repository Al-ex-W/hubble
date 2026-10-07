import type { Express } from 'express'
import type { VoiceLevelBus, VoiceLevelFrame } from './voiceLevel.ts'
import { inHardwareWindow } from './hardwareWindow.ts'

/**
 * The TV light strips pulse with Hubble's voice (owner, 7 Oct 2026: "make the
 * light strips kinda pulse in the waveform of the agent's voice").
 *
 * Plan and evidence: docs/plans/2026-10-07-voice-lights.md. Read its Rulings
 * before changing a constant: every number below is either a manufacturer
 * limit or an UNMEASURED starting guess, and the plan says which.
 *
 * Shape: voiceLevel bus (browser-measured RMS, 0..1) -> envelope follower
 * (fast attack, slower release) -> at most N Hue writes per second, latest
 * value wins -> HueWriter -> the room's light path. This module never opens a
 * connection itself (the device pool is the only code allowed to; see
 * devices.architecture.test.ts): it is handed a HueWriter, which on site is
 * the room transport (createPiRoom, which goes through the pool).
 *
 * The one rule of this file: a lamp is the least important thing in the demo.
 * A slow, failing or hanging bridge must never delay the voice, the TV page
 * or the turn. So every write is fire-and-forget with a deadline, nothing is
 * ever queued, and errors only slow the lights down.
 */

/** What we ask of a strip. Room LightCommand is `{on, bri, color}` (room-pis plan: `light` -> `{on, bri, xy}`). */
export interface StripCommand { on: true; bri: number; color: string }
export interface HueWriteOptions {
  /** Fade length in ms; the bridge's transitiontime is this / 100 (1 unit = 100 ms). */
  transitionMs: number
  /** Aborted at the write's deadline; a transport that can cancel should. */
  signal: AbortSignal
}
/**
 * The adapter the server gives us. Deliberately narrower than the Room: one
 * method, no way to open anything. See roomHueWriter() for the real one.
 */
export interface HueWriter { light(id: string, cmd: StripCommand, opts: HueWriteOptions): Promise<unknown> }

export interface Strip {
  /** The Room's light id: `strip-tv-1` is bridge light 1, `strip-tv-2` is 8 (ROOM-SETUP.md, Hue table). */
  light: string
  /** Which TV it sits behind (informational: both strips pulse with the same voice). */
  tv: string
}
export const DEFAULT_STRIPS: Strip[] = [
  { light: 'strip-tv-1', tv: 'tv-1' },
  { light: 'strip-tv-2', tv: 'tv-2' },
]

/**
 * Envelope constants. UNMEASURED starting points (no rig here); tune on site
 * with the status endpoint open. Rationale:
 *  - attack 70 ms: a syllable onset must register inside one or two Hue
 *    updates (250 ms apart) or the strip feels late; the fade itself already
 *    lags by transitionMs, so the follower should not add much more.
 *  - release 320 ms: speech RMS drops between syllables within ~100 ms; if the
 *    strip followed that at 4 updates/s it would strobe. A slower release
 *    reads as a "breathing" pulse and hides the bridge's coarse rate.
 *  - gate 0.04: the producer's noise floor (mic hiss/codec) must not keep the
 *    strips lit when nobody is speaking.
 */
export const ATTACK_MS = 70
export const RELEASE_MS = 320
export const NOISE_GATE = 0.04
/** Hue bri is 1..254. Floor while speaking: bri 1 is near-off on Hue and flickers on Zigbee dimming; 30 reads as "dim but alive". */
export const BRI_FLOOR = 30
export const BRI_PEAK = 254
/** Brightness changes smaller than this are not worth one of the ~10 commands per second. */
export const MIN_BRI_STEP = 3
/** Hubble's palette, from apps/web/src/ui/demo-theme.css: periwinkle at rest, lavender on peaks. */
export const COLOR_REST = '#acbdf9'
export const COLOR_PEAK = '#e0d4ff'
/** Where a strip goes when speech ends, if no `restore` hook is given. A neutral dim periwinkle, NOT the runtime's mood. @hubble/room is readable since 7 Oct ~13:00: its idle mood is MOODS.idle in packages/room/src/lights.ts ({on, bri 60, #28465a}); wiring a `restore` that re-applies the runtime's current mood is still open (plan, gap 1). */
export const IDLE_FALLBACK: StripCommand = { on: true, bri: 60, color: COLOR_REST }

/**
 * Hard ceilings, from the manufacturer: Philips Hue developer docs recommend
 * at most ~10 light commands per second per bridge (and ~1/s for group
 * commands). The room's own demo runs at ~7/s (examples/motion-trails).
 * These cap whatever the caller configures, so a bad env value cannot push the
 * shared bridge past what the docs allow.
 */
export const MAX_TOTAL_PER_SECOND = 10
export const MAX_PER_STRIP_PER_SECOND = 5

export interface VoiceLightsDeps {
  bus: VoiceLevelBus
  hue: HueWriter
  /** HUBBLE_VOICE_LIGHTS=on. False: the driver subscribes to nothing and writes nothing. */
  enabled: boolean
  /** The operator's "room output" switch (runtime.roomOutput().active). Required: there is no safe default. */
  isArmed: () => boolean
  /** True for ROOM=live/legacy: real hardware, so the n:00-n:20 window applies. False only for the emulator. Default true (fail safe). */
  requiresWindow?: boolean
  inWindow?: (nowMs: number) => boolean
  strips?: Strip[]
  /** Updates per strip per second (default 4, capped at 5). The fade length equals this interval. */
  hzPerStrip?: number
  /** Total writes per second across strips (default 8, capped at 10). */
  maxPerSecond?: number
  /** A write not finished by now frees its strip (default 1500 ms). */
  deadlineMs?: number
  /** No frame for this long while lit = the producer died; treat as silence (default 1500 ms). */
  staleMs?: number
  tickMs?: number
  now?: () => number
  log?: (line: string) => void
  /** Called once speech has ended instead of writing IDLE_FALLBACK: the place to hand the strips back to the room's mood. */
  restore?: () => void | Promise<void>
}

export type VoiceLightsState = 'disabled' | 'idle' | 'speaking' | 'ending'
export interface VoiceLightsStatus {
  enabled: boolean
  state: VoiceLightsState
  /** Why nothing is being written right now, or null when the gates are open. */
  gated: 'disabled' | 'unarmed' | 'outside-window' | null
  envelope: number
  sent: number
  droppedFrames: number
  errors: number
  timeouts: number
  lastError: string | null
  lastSentAt: number | null
  writesLastSecond: number
  backoffUntil: number | null
  strips: Array<{ light: string; tv: string; lastBri: number | null; inFlight: boolean }>
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
const mix = (a: string, b: string, t: number) => {
  const [x, y] = [hex(a), hex(b)]
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')
}

/** Envelope (0..1) -> what to tell a strip. Exported for tests as an independent check of the mapping. */
export function stripCommandFor(env: number): StripCommand {
  const lift = Math.pow(clamp01(env), 0.8) // speech RMS sits low; a mild lift makes quiet words visible
  const bri = Math.round(BRI_FLOOR + (BRI_PEAK - BRI_FLOOR) * lift)
  // Colour moves only on the upper half of the envelope, in quarter steps, so
  // it adds accent on peaks without making every write differ in colour.
  const t = Math.round(clamp01((env - 0.5) / 0.5) * 4) / 4
  return { on: true, bri, color: mix(COLOR_REST, COLOR_PEAK, t) }
}

export function createVoiceLights(deps: VoiceLightsDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((l: string) => console.log(l))
  const strips = deps.strips ?? DEFAULT_STRIPS
  const hz = Math.min(MAX_PER_STRIP_PER_SECOND, Math.max(0.5, deps.hzPerStrip ?? 4))
  const intervalMs = Math.round(1000 / hz)
  const maxPerSecond = Math.min(MAX_TOTAL_PER_SECOND, Math.max(1, deps.maxPerSecond ?? 8))
  const deadlineMs = deps.deadlineMs ?? 1500
  const staleMs = deps.staleMs ?? 1500
  const tickMs = deps.tickMs ?? 50
  const requiresWindow = deps.requiresWindow ?? true
  const inWindow = deps.inWindow ?? inHardwareWindow
  // The bridge's transitiontime is in 100 ms units; matching the fade to the
  // send interval makes consecutive fades meet instead of stepping or overlapping.
  const transitionMs = Math.max(100, Math.round(intervalMs / 100) * 100)

  let state: VoiceLightsState = deps.enabled ? 'idle' : 'disabled'
  let env = 0
  let envAt = now()
  let lastLevel = 0
  let peak = 0
  let lastFrameAt = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let gated: VoiceLightsStatus['gated'] = deps.enabled ? null : 'disabled'
  let loggedGate: string | null = null
  const sentTimes: number[] = []
  let sent = 0, droppedFrames = 0, errors = 0, timeouts = 0
  let lastError: string | null = null
  let lastSentAt: number | null = null
  let consecutiveErrors = 0
  let backoffUntil = 0
  let restorePending = false
  let restoreTries = 0
  const per = strips.map((s) => ({ ...s, lastSent: 0, lastBri: null as number | null, lastColor: '', inFlight: false, needsRestore: false }))

  /** Which gate is closed, if any. Re-evaluated on every frame and tick: arming and the window can change under us. */
  function gate(): VoiceLightsStatus['gated'] {
    if (!deps.enabled) return 'disabled'
    if (!deps.isArmed()) return 'unarmed'
    if (requiresWindow && !inWindow(now())) return 'outside-window'
    return null
  }
  function checkGate(): boolean {
    gated = gate()
    // Log each change once, never per frame (50 Hz of "outside window" would drown the console).
    if ((gated ?? 'open') !== loggedGate) {
      loggedGate = gated ?? 'open'
      if (gated && gated !== 'disabled') log(`voice-lights: not writing (${gated})`)
      else if (!gated) log('voice-lights: gates open, strips follow the voice')
    }
    return gated === null
  }

  /** Forget the lit state without writing: used when a gate closes. A write now would be exactly what the gate forbids. */
  function dropLit() {
    state = deps.enabled ? 'idle' : 'disabled'
    env = 0; peak = 0; lastLevel = 0; restorePending = false
    for (const p of per) { p.lastBri = null; p.lastColor = ''; p.needsRestore = false }
    stopTimer()
  }
  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null }
  }
  function startTimer() {
    if (!timer) timer = setInterval(tick, tickMs)
  }

  function onFrame(f: VoiceLevelFrame) {
    if (!checkGate()) {
      if (state !== 'idle' && state !== 'disabled') dropLit()
      droppedFrames++
      return
    }
    const t = now()
    lastFrameAt = t
    const silent = f.speech === null && f.level === 0
    lastLevel = silent ? 0 : f.level
    // Peak-hold between ticks: frames arrive faster than we update, and a
    // syllable that peaks and falls between two ticks must still register.
    peak = Math.max(peak, lastLevel)
    if (silent) {
      if (state === 'speaking') state = 'ending'
      return
    }
    if (state === 'idle' || state === 'ending') {
      if (state === 'idle') { env = 0; envAt = t }
      state = 'speaking'
      restorePending = false
    }
    startTimer()
  }

  function advance(t: number) {
    const dt = Math.max(0, t - envAt)
    envAt = t
    const raw = peak > NOISE_GATE ? peak : 0
    peak = lastLevel // the next window starts from the current level, not from zero
    const tau = raw > env ? ATTACK_MS : RELEASE_MS
    env += (raw - env) * (1 - Math.exp(-dt / tau))
  }

  function budgetLeft(t: number): number {
    while (sentTimes.length && t - sentTimes[0] >= 1000) sentTimes.shift()
    return maxPerSecond - sentTimes.length
  }

  function send(p: (typeof per)[number], cmd: StripCommand, t: number, onDone?: (ok: boolean) => void) {
    p.inFlight = true
    p.lastSent = t
    sentTimes.push(t)
    sent++
    lastSentAt = t
    const ac = new AbortController()
    let settled = false
    const finish = (ok: boolean, err?: unknown, timedOut = false) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      p.inFlight = false
      if (ok) {
        consecutiveErrors = 0
      } else {
        errors++
        if (timedOut) timeouts++
        lastError = err instanceof Error ? err.message : String(err)
        consecutiveErrors++
        // Exponential back-off (1 s, 2 s, 4 s ... 10 s): a struggling bridge
        // gets quiet, which is the kindest thing we can do for the shared room.
        backoffUntil = now() + Math.min(10_000, 1000 * 2 ** Math.min(4, consecutiveErrors - 1))
      }
      onDone?.(ok)
    }
    const deadline = setTimeout(() => { ac.abort(); finish(false, new Error(`write deadline ${deadlineMs} ms`), true) }, deadlineMs)
    if (!onDone) p.needsRestore = true // a normal (non-restore) write: this strip is off its idle state now
    p.lastBri = cmd.bri
    p.lastColor = cmd.color
    try {
      // Fire and forget: nobody awaits this on the voice's path.
      Promise.resolve(deps.hue.light(p.light, cmd, { transitionMs, signal: ac.signal })).then(() => finish(true), (e) => finish(false, e))
    } catch (e) {
      finish(false, e)
    }
  }

  function tick() {
    const t = now()
    if (!checkGate()) { dropLit(); return }
    if (state === 'speaking' && t - lastFrameAt > staleMs) { lastLevel = 0; peak = 0; state = 'ending' }
    if (!restorePending) advance(t)
    if (state === 'ending' && !restorePending && env < 0.02) {
      restorePending = true
      restoreTries = 0
    }
    if (t < backoffUntil) return
    if (restorePending) return void flushRestore(t)
    if (state !== 'speaking' && state !== 'ending') return stopTimer()
    const cmd = stripCommandFor(env)
    for (const p of per) {
      if (p.inFlight || t - p.lastSent < intervalMs) continue // never queue: a busy or recently-written strip just skips this tick
      if (p.lastBri !== null && Math.abs(cmd.bri - p.lastBri) < MIN_BRI_STEP && cmd.color === p.lastColor) continue
      if (budgetLeft(t) <= 0) break // total cap; the next tick sends the LATEST value, not this one
      send(p, cmd, t)
    }
  }

  /** Hand the strips back. Goes through the same budget, interval and deadline as any write. */
  function flushRestore(t: number) {
    const finishIdle = () => {
      restorePending = false
      state = 'idle'
      env = 0
      for (const p of per) { p.lastBri = null; p.lastColor = ''; p.needsRestore = false }
      stopTimer()
    }
    if (deps.restore) {
      // The hook is the room's own mood path (e.g. the runtime re-applying the
      // current mood); it is guarded like any other call and never awaited.
      const wrote = per.some((p) => p.needsRestore)
      finishIdle()
      if (wrote) void Promise.resolve().then(() => deps.restore!()).catch((e) => { errors++; lastError = e instanceof Error ? e.message : String(e) })
      return
    }
    for (const p of per) {
      if (!p.needsRestore || p.inFlight || t - p.lastSent < intervalMs || budgetLeft(t) <= 0) continue
      // Three failed tries and we stop: do not hammer a failing bridge to tidy a lamp.
      send(p, IDLE_FALLBACK, t, (ok) => { if (ok || ++restoreTries >= 3) p.needsRestore = false })
    }
    if (per.every((p) => !p.needsRestore && !p.inFlight)) finishIdle()
  }

  const unsubscribe = deps.enabled ? deps.bus.subscribe(onFrame) : () => {}

  return {
    stop() {
      unsubscribe()
      stopTimer()
    },
    status(): VoiceLightsStatus {
      const t = now()
      return {
        enabled: deps.enabled,
        state,
        gated: deps.enabled ? gate() : 'disabled',
        envelope: Number(env.toFixed(3)),
        sent, droppedFrames, errors, timeouts, lastError, lastSentAt,
        writesLastSecond: sentTimes.filter((s) => t - s < 1000).length,
        backoffUntil: backoffUntil > t ? backoffUntil : null,
        strips: per.map((p) => ({ light: p.light, tv: p.tv, lastBri: p.lastBri, inFlight: p.inFlight })),
      }
    },
  }
}
export type VoiceLights = ReturnType<typeof createVoiceLights>

/**
 * The sanctioned writer: the Room's own `light(id, cmd)`. For ROOM=live that
 * is createPiRoom's bridge call, which goes through the device pool (the only
 * code allowed to open a device connection, and the one that refuses outside
 * the hardware window). We never bypass it: this adapter only shapes a command
 * and puts a deadline around the call.
 *
 * `transitiontime` is passed alongside the Room's `{on, bri, color}`, but
 * packages/room's `LightCommand` (spec.ts) is exactly `{on, bri, color}`
 * (checked 7 Oct ~13:00, once @hubble/room became readable), so the room
 * drops it and the bridge's default fade (400 ms) applies: at one update per
 * 250 ms, a softer pulse. Forwarding it needs a field in room's spec.ts.
 * Plan gap 2.
 */
export function roomHueWriter(room: { light(id: string, cmd: never): Promise<unknown> }): HueWriter {
  return {
    light(id, cmd, opts) {
      const command = { on: cmd.on, bri: cmd.bri, color: cmd.color, transitiontime: Math.round(opts.transitionMs / 100) }
      const call = (room.light as (id: string, cmd: unknown) => Promise<unknown>)(id, command)
      // room.light takes no AbortSignal; the driver's deadline frees the strip, and this makes a rejection after abort harmless.
      return call
    },
  }
}

/** HUBBLE_VOICE_LIGHTS_STRIPS="strip-tv-1:tv-1,strip-tv-2:tv-2": which light pulses for which TV. Both pulse with the same voice. */
export function parseStrips(v: string | undefined): Strip[] {
  const parsed = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const [light, tv] = s.split(':'); return { light, tv: tv || light } })
  return parsed.length ? parsed : DEFAULT_STRIPS
}

/** GET /api/voice-lights for the operator page: what the driver is doing and why it is (not) writing. */
export function mountVoiceLights(app: Pick<Express, 'get'>, lights: VoiceLights) {
  app.get('/api/voice-lights', (_req, res) => { res.json(lights.status()) })
}

/**
 * The one wiring call for apps/server/index.ts (boot block, after createApp).
 * Returns null when HUBBLE_VOICE_LIGHTS is not "on" or there is no room.
 */
export function startVoiceLights(o: {
  app: Pick<Express, 'get'>
  bus: VoiceLevelBus
  room: { light(id: string, cmd: never): Promise<unknown> } | undefined
  /** process.env.ROOM: 'live' | 'legacy' are real hardware (window applies); 'emulator' is not. */
  which: string
  isArmed: () => boolean
  env?: Record<string, string | undefined>
}): VoiceLights | null {
  const env = o.env ?? process.env
  if (env.HUBBLE_VOICE_LIGHTS !== 'on' || !o.room) return null
  const lights = createVoiceLights({
    bus: o.bus,
    hue: roomHueWriter(o.room),
    enabled: true,
    isArmed: o.isArmed,
    requiresWindow: o.which === 'live' || o.which === 'legacy',
    strips: parseStrips(env.HUBBLE_VOICE_LIGHTS_STRIPS),
    hzPerStrip: env.HUBBLE_VOICE_LIGHTS_HZ ? Number(env.HUBBLE_VOICE_LIGHTS_HZ) : undefined,
  })
  mountVoiceLights(o.app, lights)
  return lights
}
