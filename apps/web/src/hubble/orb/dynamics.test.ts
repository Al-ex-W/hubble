import { describe, expect, it } from 'vitest'
import {
  bandPositionForAngle,
  createOrbDynamics,
  MAX_RIPPLES,
  ORB_STATES,
  PROFILE_SIZE,
  RIPPLE_REFRACTORY_MS,
  type OrbFrame,
  type OrbState,
} from './dynamics.ts'
import { createAutoGain } from '../audio/spectrum.ts'
import fixture from '../audio/fixtures/speech-energy.json'

const DT = 16
const flat = (v: number) => new Float32Array(32).fill(v)

/** Run a constant input for `ms`, returning the last frame (copied). */
function hold(
  dyn: ReturnType<typeof createOrbDynamics>,
  state: OrbState,
  level: number,
  ms: number,
  bands = flat(0.5),
): OrbFrame {
  let f!: OrbFrame
  for (let t = 0; t < ms; t += DT) f = dyn.step({ state, level, bands, dtMs: DT })
  return snapshot(f)
}

function snapshot(f: OrbFrame): OrbFrame {
  return { ...f, weights: f.weights.slice(), profile: f.profile.slice(), ripples: f.ripples.slice() }
}

const meanProfile = (f: OrbFrame) => f.profile.reduce((a, b) => a + b, 0) / f.profile.length

/** Counts ripple spawns over a run: a slot whose age went back to 0. */
function countRipples(levels: number[], state: OrbState = 'listening'): number {
  const dyn = createOrbDynamics(state)
  let prev = new Float32Array(MAX_RIPPLES * 2)
  let spawns = 0
  for (const level of levels) {
    const f = dyn.step({ state, level, bands: flat(0.5), dtMs: DT })
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const fresh = f.ripples[i * 2 + 1] > 0 && (prev[i * 2 + 1] === 0 || f.ripples[i * 2] < prev[i * 2])
      if (fresh) spawns++
    }
    prev = f.ripples.slice()
  }
  return spawns
}

describe('orb dynamics: reacting to audio', () => {
  it('swells with loudness while listening', () => {
    const quiet = hold(createOrbDynamics('listening'), 'listening', 0, 400)
    const loud = hold(createOrbDynamics('listening'), 'listening', 1, 400)
    expect(loud.radius - quiet.radius).toBeGreaterThan(0.08)
  })

  it('stays composed when idle, even in a loud room', () => {
    const quiet = hold(createOrbDynamics('idle'), 'idle', 0, 400)
    const loud = hold(createOrbDynamics('idle'), 'idle', 1, 400)
    expect(loud.radius / quiet.radius).toBeLessThan(1.03)
    expect(meanProfile(loud)).toBeLessThan(0.03)
  })

  it('springs to life fast and settles slowly (attack/release envelope)', () => {
    const dyn = createOrbDynamics('listening')
    hold(dyn, 'listening', 0, 200)
    const attacked = hold(dyn, 'listening', 1, 80)
    expect(attacked.energy).toBeGreaterThan(0.85)
    // After the voice stops, 100ms later the orb is still clearly lit: no
    // flicker between words …
    const released = hold(dyn, 'listening', 0, 100)
    expect(released.energy).toBeGreaterThan(0.6)
    // … but it does come to rest.
    expect(hold(dyn, 'listening', 0, 2500).energy).toBeLessThan(0.01)
  })

  it('pushes the rim further out for a louder voice, and relaxes to a circle in silence', () => {
    const soft = hold(createOrbDynamics('listening'), 'listening', 0.3, 400)
    const loud = hold(createOrbDynamics('listening'), 'listening', 1, 400)
    expect(meanProfile(loud)).toBeGreaterThan(meanProfile(soft) * 2)
    const silent = hold(createOrbDynamics('listening'), 'listening', 0, 400)
    expect(Math.max(...silent.profile)).toBe(0)
  })

  it('reacts to the agent voice while speaking but barely while thinking', () => {
    const speaking = hold(createOrbDynamics('speaking'), 'speaking', 1, 400)
    const thinking = hold(createOrbDynamics('thinking'), 'thinking', 1, 400)
    expect(meanProfile(speaking)).toBeGreaterThan(meanProfile(thinking) * 3)
  })
})

describe('orb dynamics: rim shape', () => {
  // One hot band in the middle of the spectrum.
  const spike = () => {
    const b = new Float32Array(32)
    b[16] = 1
    return b
  }

  it('is mirror-symmetric around the vertical axis', () => {
    const f = hold(createOrbDynamics('listening'), 'listening', 1, 300, spike())
    for (let k = 0; k < PROFILE_SIZE; k++) {
      // Angle θ and π−θ are mirror images across the vertical axis.
      const mirror = (PROFILE_SIZE / 2 - k + PROFILE_SIZE) % PROFILE_SIZE
      expect(f.profile[k]).toBeCloseTo(f.profile[mirror], 5)
    }
  })

  it('smooths a single hot band into a membrane, not a spike', () => {
    const f = hold(createOrbDynamics('listening'), 'listening', 1, 300, spike())
    const peak = Math.max(...f.profile)
    let maxStep = 0
    for (let k = 0; k < PROFILE_SIZE; k++) {
      maxStep = Math.max(maxStep, Math.abs(f.profile[k] - f.profile[(k + 1) % PROFILE_SIZE]))
    }
    expect(maxStep).toBeLessThan(peak * 0.15)
    // And the whole rim moves with the voice, not just one arc.
    expect(Math.min(...f.profile)).toBeGreaterThan(peak * 0.3)
  })

  it('puts low frequencies at the bottom and highs at the top', () => {
    expect(bandPositionForAngle(PROFILE_SIZE * 0.75)).toBeCloseTo(0) // bottom
    expect(bandPositionForAngle(PROFILE_SIZE * 0.25)).toBeCloseTo(1) // top
  })
})

describe('orb dynamics: states and transitions', () => {
  it('cross-fades between states instead of cutting', () => {
    const dyn = createOrbDynamics('listening')
    hold(dyn, 'listening', 0, 500)
    let prev = dyn.step({ state: 'listening', level: 0, bands: flat(0), dtMs: DT }).weights.slice()
    for (let t = 0; t < 1500; t += DT) {
      const w = dyn.step({ state: 'thinking', level: 0, bands: flat(0), dtMs: DT }).weights
      const sum = w.reduce((a, b) => a + b, 0)
      expect(sum).toBeCloseTo(1, 5)
      for (let i = 0; i < w.length; i++) expect(Math.abs(w[i] - prev[i])).toBeLessThan(0.1)
      prev = w.slice()
    }
    expect(prev[ORB_STATES.indexOf('thinking')]).toBeGreaterThan(0.95)
  })

  it('swirls fastest while thinking, without jumping when the state changes', () => {
    const dyn = createOrbDynamics('listening')
    const a = hold(dyn, 'listening', 0, 1000).swirl
    const b = hold(dyn, 'listening', 0, 1000).swirl
    let last = b
    let maxDelta = 0
    for (let t = 0; t < 2000; t += DT) {
      const s = dyn.step({ state: 'thinking', level: 0, bands: flat(0), dtMs: DT }).swirl
      maxDelta = Math.max(maxDelta, s - last)
      last = s
    }
    const thinkingRate = (last - b) / 2
    expect(thinkingRate).toBeGreaterThan((b - a) * 4)
    // Never more than the top swirl speed allows in one frame.
    expect(maxDelta).toBeLessThan(3 * (DT / 1000))
  })

  it('fades in on first render and dims when idle', () => {
    const dyn = createOrbDynamics('idle')
    const first = dyn.step({ state: 'idle', level: 0, bands: flat(0), dtMs: DT }).presence
    expect(first).toBeLessThan(0.05)
    const idle = hold(dyn, 'idle', 0, 3000).presence
    const awake = hold(dyn, 'listening', 0, 3000).presence
    expect(idle).toBeGreaterThan(0.3)
    expect(awake).toBeGreaterThan(idle * 1.8)
  })

  it('never emits NaN for bad input', () => {
    const dyn = createOrbDynamics('listening')
    const f = dyn.step({ state: 'listening', level: Number.NaN, bands: new Float32Array(0), dtMs: Number.NaN })
    for (const v of [f.energy, f.radius, f.presence, f.swirl, ...f.profile, ...f.ripples]) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })
})

describe('orb dynamics: ripples', () => {
  it('pulses on syllables of real speech, not on every frame', () => {
    const gain = createAutoGain()
    const levels = fixture.loud.map((x) => gain.update(x, fixture.frameMs))
    const spawns = countRipples(levels)
    // "Hey Hubble. What is the weather like in Stockholm today?" — a handful of
    // stressed onsets. A per-frame bug would give hundreds; a dead detector 0.
    expect(spawns).toBeGreaterThanOrEqual(2)
    expect(spawns).toBeLessThanOrEqual(Math.ceil((levels.length * DT) / RIPPLE_REFRACTORY_MS) / 2)
  })

  it('sends one ring for a sustained tone, not a strobe', () => {
    const levels = [...Array(10).fill(0), ...Array(190).fill(0.8)]
    expect(countRipples(levels)).toBe(1)
  })

  it('pings like sonar while listening to silence, but not when idle', () => {
    const silence = Array(Math.round(6000 / DT)).fill(0)
    expect(countRipples(silence, 'listening')).toBe(2)
    expect(countRipples(silence, 'idle')).toBe(0)
  })
})
