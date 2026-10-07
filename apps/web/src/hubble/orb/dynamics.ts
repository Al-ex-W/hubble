/**
 * Orb dynamics: everything about how the orb *moves*, separated from how it is
 * drawn (the shader in ./shader.ts).
 *
 * The old orb was a pure function of (state, level, bands, time). That purity
 * was the reason it felt dead: with no memory there can be no envelope (fast
 * attack, slow release), no cross-fade between states, no ripple that lives
 * longer than the frame that spawned it, and every state change was a jump
 * cut. This module keeps the testability — it is deterministic, takes time as
 * an explicit dt, uses no clocks, DOM or randomness — but owns that state.
 *
 * Its output (OrbFrame) maps one-to-one to shader uniforms.
 */

export type OrbState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking'

/** Order matters: it is the order of the uW[] uniform in the shader. */
export const ORB_STATES: readonly OrbState[] = ['idle', 'connecting', 'listening', 'thinking', 'speaking']

/** Angular samples of the rim displacement (uProfile[] in the shader). */
export const PROFILE_SIZE = 96
/** Ripple slots (uRipples[] in the shader). */
export const MAX_RIPPLES = 6

export interface OrbInput {
  state: OrbState
  /** Loudness already normalised by auto-gain, 0..1. */
  level: number
  /** Log-spaced spectrum bands, 0..1 each. */
  bands: Float32Array
  dtMs: number
}

export interface OrbFrame {
  /** Seconds since the dynamics were created. */
  time: number
  /** Cross-faded state weights in ORB_STATES order; always sum to 1. */
  weights: Float32Array
  /** Enveloped loudness after per-state reactivity, 0..1. */
  energy: number
  /** Body radius multiplier around 1 (breathing + swell). */
  radius: number
  /** 0 on first frame, rising to the state's brightness: the entrance fade,
   * and the dimming when the assistant goes idle. */
  presence: number
  /** Accumulated swirl phase in radians. Integrated from a speed, never
   * computed as speed × time, so changing speed never makes it jump. */
  swirl: number
  /** Outward rim displacement per angle, in radius units, >= 0. */
  profile: Float32Array
  /** [age 0..1, strength 0..1] per slot; strength 0 means empty. */
  ripples: Float32Array
}

interface StateTuning {
  /** How strongly audio moves the orb. Idle and thinking stay composed. */
  reactivity: number
  /** Overall brightness; idle is "asleep", not off. */
  presence: number
  /** Swirl speed, rad/s. Thinking is the only state that visibly spins. */
  swirlSpeed: number
  /** Breathing frequency (Hz) and depth (radius units). */
  breathHz: number
  breathDepth: number
}

const TUNING: Record<OrbState, StateTuning> = {
  idle: { reactivity: 0.12, presence: 0.45, swirlSpeed: 0.15, breathHz: 0.16, breathDepth: 0.035 },
  connecting: { reactivity: 0.2, presence: 0.75, swirlSpeed: 1.4, breathHz: 0.9, breathDepth: 0.025 },
  listening: { reactivity: 1, presence: 1, swirlSpeed: 0.3, breathHz: 0.28, breathDepth: 0.014 },
  thinking: { reactivity: 0.2, presence: 1, swirlSpeed: 2.6, breathHz: 0.5, breathDepth: 0.022 },
  speaking: { reactivity: 0.9, presence: 1, swirlSpeed: 0.55, breathHz: 0.25, breathDepth: 0.01 },
}

/** Time constant of the state cross-fade. ~3 of these to fully settle. */
export const STATE_FADE_MS = 280
// Energy envelope: fast attack so the orb springs to life on the first
// syllable; slow release so it glides down between words instead of flickering.
export const ENERGY_ATTACK_MS = 30
export const ENERGY_RELEASE_MS = 380
// The rim is a little snappier than the glow so syllables read as texture.
const PROFILE_ATTACK_MS = 25
const PROFILE_RELEASE_MS = 240
/** How far the loudest band can push the rim out, in radius units. */
const PROFILE_GAIN = 0.2
/** How much the whole body swells at full energy. */
const SWELL = 0.14
const PRESENCE_MS = 650

// Ripples are spawned on onsets (a syllable starting), detected as a fast
// envelope pulling ahead of a slow one. A steady tone keeps both equal and so
// spawns nothing, which is what keeps sustained sound from strobing.
const ONSET_FAST_MS = 20
const ONSET_SLOW_MS = 220
const ONSET_JUMP = 0.08
const ONSET_MIN = 0.22
export const RIPPLE_REFRACTORY_MS = 180
export const RIPPLE_LIFE_MS = 1600
// While listening in silence the orb sends a faint sonar ping, so "I am
// listening" is visible before the user has said anything.
export const SONAR_INTERVAL_MS = 2600
const SONAR_STRENGTH = 0.28

/** One-pole smoothing coefficient for a time constant. */
function smoothing(dtMs: number, tauMs: number): number {
  return 1 - Math.exp(-Math.max(0, dtMs) / tauMs)
}

function envelope(current: number, target: number, dtMs: number, attackMs: number, releaseMs: number) {
  const tau = target > current ? attackMs : releaseMs
  return current + (target - current) * smoothing(dtMs, tau)
}

/** Circular [1 4 6 4 1]/16 blur: neighbouring angles share energy, which turns
 * a spiky per-band outline into a liquid membrane. */
function blurCircular(src: Float32Array, dst: Float32Array) {
  const n = src.length
  for (let i = 0; i < n; i++) {
    dst[i] =
      (src[(i - 2 + n) % n] + 4 * src[(i - 1 + n) % n] + 6 * src[i] + 4 * src[(i + 1) % n] + src[(i + 2) % n]) /
      16
  }
}

/**
 * Which band drives angle index k. The spectrum is mirrored left/right
 * around the vertical axis (low frequencies at the bottom, highs at the top),
 * so the orb deforms symmetrically like a voice visual rather than bulging on
 * one side as the old linear angle→band mapping did.
 */
export function bandPositionForAngle(k: number, size = PROFILE_SIZE): number {
  const u = k / size // 0 = +x, 0.25 = top (y up)
  const fromTop = (((u - 0.25) % 1) + 1) % 1
  const d = fromTop <= 0.5 ? fromTop * 2 : (1 - fromTop) * 2 // 0 top … 1 bottom
  return 1 - d // 0 bottom (lows) … 1 top (highs)
}

export interface OrbDynamics {
  step(input: OrbInput): OrbFrame
}

export function createOrbDynamics(initial: OrbState = 'idle'): OrbDynamics {
  const weights = new Float32Array(ORB_STATES.length)
  weights[ORB_STATES.indexOf(initial)] = 1
  const profile = new Float32Array(PROFILE_SIZE)
  const target = new Float32Array(PROFILE_SIZE)
  const scratch = new Float32Array(PROFILE_SIZE)
  const ripples = new Float32Array(MAX_RIPPLES * 2)

  let timeMs = 0
  let energy = 0
  let presence = 0
  let swirl = 0
  let breathPhase = 0
  let onsetFast = 0
  let onsetSlow = 0
  let sinceRipple = Infinity
  // Hysteresis: after an onset fires, the detector re-arms only once the
  // fast/slow gap has closed again, so one syllable gives exactly one ring
  // however long its rise takes.
  let onsetArmed = true
  let sonarMs = 0

  const frame: OrbFrame = { time: 0, weights, energy: 0, radius: 1, presence: 0, swirl: 0, profile, ripples }

  const blend = (key: keyof StateTuning) => {
    let acc = 0
    for (let i = 0; i < ORB_STATES.length; i++) acc += weights[i] * TUNING[ORB_STATES[i]][key]
    return acc
  }

  const spawnRipple = (strength: number) => {
    // Reuse an empty or finished slot, else replace the oldest.
    let slot = 0
    let oldest = -1
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const age = ripples[i * 2]
      if (ripples[i * 2 + 1] === 0 || age >= 1) {
        slot = i
        oldest = Infinity
        break
      }
      if (age > oldest) {
        oldest = age
        slot = i
      }
    }
    ripples[slot * 2] = 0
    ripples[slot * 2 + 1] = strength
    sinceRipple = 0
  }

  return {
    step({ state, level, bands, dtMs }) {
      const dt = Number.isFinite(dtMs) ? Math.min(Math.max(dtMs, 0), 100) : 0
      const lvl = Number.isFinite(level) ? Math.min(Math.max(level, 0), 1) : 0
      timeMs += dt

      // Cross-fade: every weight eases toward 1 (active) or 0 with the same
      // coefficient, which keeps the sum at exactly 1 throughout.
      const k = smoothing(dt, STATE_FADE_MS)
      for (let i = 0; i < ORB_STATES.length; i++) {
        const goal = ORB_STATES[i] === state ? 1 : 0
        weights[i] += (goal - weights[i]) * k
      }

      const reactivity = blend('reactivity')
      const drive = lvl * reactivity
      energy = envelope(energy, drive, dt, ENERGY_ATTACK_MS, ENERGY_RELEASE_MS)
      presence += (blend('presence') - presence) * smoothing(dt, PRESENCE_MS)
      swirl += blend('swirlSpeed') * (dt / 1000)
      breathPhase += blend('breathHz') * (dt / 1000) * Math.PI * 2

      // Rim: band shape (normalised to this frame's loudest band, so it is
      // independent of mic calibration) scaled by the enveloped energy. With
      // no sound, energy → 0 and the rim relaxes to a circle.
      let maxBand = 0
      for (let i = 0; i < bands.length; i++) if (bands[i] > maxBand) maxBand = bands[i]
      for (let i = 0; i < PROFILE_SIZE; i++) {
        let shape = 0
        if (bands.length > 0 && maxBand > 1e-4) {
          const pos = bandPositionForAngle(i) * (bands.length - 1)
          const lo = Math.floor(pos)
          const hi = Math.min(lo + 1, bands.length - 1)
          const t = pos - lo
          shape = (bands[lo] * (1 - t) + bands[hi] * t) / maxBand
        }
        // A floor of 0.35 swells the whole rim with the voice; the band shape
        // adds the texture on top.
        target[i] = (0.35 + 0.65 * shape) * energy * PROFILE_GAIN
      }
      // Three passes ≈ a Gaussian about a sixth of the circle wide; fewer
      // left visible kinks where a single strong band met its neighbours.
      blurCircular(target, scratch)
      blurCircular(scratch, target)
      blurCircular(target, scratch)
      target.set(scratch)
      for (let i = 0; i < PROFILE_SIZE; i++) {
        profile[i] = envelope(profile[i], target[i], dt, PROFILE_ATTACK_MS, PROFILE_RELEASE_MS)
      }

      // Age ripples.
      for (let i = 0; i < MAX_RIPPLES; i++) {
        if (ripples[i * 2 + 1] === 0) continue
        ripples[i * 2] += dt / RIPPLE_LIFE_MS
        if (ripples[i * 2] >= 1) {
          ripples[i * 2] = 0
          ripples[i * 2 + 1] = 0
        }
      }
      // Onsets → ripples.
      sinceRipple += dt
      onsetFast += (drive - onsetFast) * smoothing(dt, ONSET_FAST_MS)
      onsetSlow += (drive - onsetSlow) * smoothing(dt, ONSET_SLOW_MS)
      const jump = onsetFast - onsetSlow
      if (!onsetArmed && jump < ONSET_JUMP / 2) onsetArmed = true
      if (onsetArmed && jump > ONSET_JUMP && onsetFast > ONSET_MIN && sinceRipple >= RIPPLE_REFRACTORY_MS) {
        spawnRipple(Math.min(1, Math.max(0.35, jump * 2.5)))
        onsetArmed = false
      }
      // Sonar while listening to silence.
      const listening = weights[ORB_STATES.indexOf('listening')]
      if (listening > 0.6 && energy < 0.08) {
        sonarMs += dt
        if (sonarMs >= SONAR_INTERVAL_MS && sinceRipple >= SONAR_INTERVAL_MS / 2) {
          spawnRipple(SONAR_STRENGTH)
          sonarMs = 0
        }
      } else {
        sonarMs = 0
      }

      frame.time = timeMs / 1000
      frame.energy = energy
      frame.presence = presence
      frame.swirl = swirl
      frame.radius = 1 + Math.sin(breathPhase) * blend('breathDepth') + energy * SWELL
      return frame
    },
  }
}
