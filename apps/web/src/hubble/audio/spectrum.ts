/**
 * Turns the ElevenLabs SDK's raw frequency bytes into what the orb needs:
 * a handful of perceptually-spaced bands and a loudness level that means the
 * same thing for a quiet laptop mic and a loud headset.
 *
 * Pure functions only, so the calibration is unit-tested rather than tuned by
 * ear and then silently broken.
 */

/** Number of bands the orb's rim is shaped from. */
export const BAND_COUNT = 32

// The SDK resamples its analyser output to 100–8000 Hz spread linearly across
// the returned array (see resampleVoiceRange in @elevenlabs/client).
const SDK_MIN_HZ = 100
const SDK_MAX_HZ = 8000

/**
 * Folds linear-frequency bytes into log-spaced bands. The old orb folded
 * linearly, so all speech energy (mostly < 3 kHz) landed in the first few
 * bands and only one arc of the rim ever moved. Log spacing gives each octave
 * roughly equal room, which is how we hear pitch, so the whole rim reacts.
 */
export function foldVoiceBands(bytes: ArrayLike<number>, out: Float32Array): void {
  const n = bytes.length
  const bands = out.length
  if (n === 0) {
    out.fill(0)
    return
  }
  const ratio = SDK_MAX_HZ / SDK_MIN_HZ
  const indexOf = (hz: number) => ((hz - SDK_MIN_HZ) / (SDK_MAX_HZ - SDK_MIN_HZ)) * (n - 1)

  for (let b = 0; b < bands; b++) {
    const lo = indexOf(SDK_MIN_HZ * Math.pow(ratio, b / bands))
    const hi = indexOf(SDK_MIN_HZ * Math.pow(ratio, (b + 1) / bands))
    let value: number
    if (hi - lo < 1) {
      // Narrower than one bin (the low bands): interpolate at the centre
      // instead of averaging zero bins.
      const c = (lo + hi) / 2
      const i = Math.floor(c)
      const t = c - i
      value = (bytes[i] ?? 0) * (1 - t) + (bytes[Math.min(i + 1, n - 1)] ?? 0) * t
    } else {
      let acc = 0
      let count = 0
      for (let i = Math.floor(lo); i < Math.ceil(hi); i++) {
        acc += bytes[i] ?? 0
        count++
      }
      value = acc / count
    }
    out[b] = value / 255
  }
}

/** Mean of the bands: a cheap loudness proxy in the analyser's dB scale. */
export function bandEnergy(bands: Float32Array): number {
  let acc = 0
  for (let i = 0; i < bands.length; i++) acc += bands[i]
  return bands.length ? acc / bands.length : 0
}

export interface AutoGainOptions {
  /** How slowly the noise floor creeps up under constant sound. */
  floorRiseMs: number
  /** How slowly the remembered peak decays after loud speech. */
  peakDecayMs: number
  /** Smallest floor→peak span we normalise over, so pure noise is never
   * amplified into fake activity. */
  minRange: number
}

export const DEFAULT_AUTO_GAIN: AutoGainOptions = {
  floorRiseMs: 4000,
  peakDecayMs: 3000,
  minRange: 0.12,
}

export interface AutoGain {
  /** Feed a raw energy sample; returns loudness normalised to 0..1. */
  update(raw: number, dtMs: number): number
}

/**
 * Normalises raw energy against a tracked noise floor and recent peak.
 *
 * Absolute byte levels vary hugely between microphones, gain settings and the
 * agent's own output stream, so any fixed threshold (the old 0.35 multiplier)
 * makes the orb either dead for quiet voices or pinned for loud ones. Tracking
 * floor and peak means "as loud as you were speaking a moment ago" maps to ~1.
 */
export function createAutoGain(options: AutoGainOptions = DEFAULT_AUTO_GAIN): AutoGain {
  let floor = Number.NaN
  let peak = 0
  return {
    update(raw, dtMs) {
      const x = Number.isFinite(raw) ? Math.max(0, raw) : 0
      if (Number.isNaN(floor)) floor = x
      // The floor drops instantly (silence is unambiguous) but rises slowly,
      // so a long sentence is not mistaken for background noise.
      floor = x < floor ? x : floor + (x - floor) * (1 - Math.exp(-dtMs / options.floorRiseMs))
      // The peak jumps instantly so the first syllable already reads as loud,
      // then relaxes so the next quieter speaker is not dwarfed.
      peak = x > peak ? x : peak + (x - peak) * (1 - Math.exp(-dtMs / options.peakDecayMs))
      const range = Math.max(peak - floor, options.minRange)
      return Math.min(1, Math.max(0, (x - floor) / range))
    },
  }
}
