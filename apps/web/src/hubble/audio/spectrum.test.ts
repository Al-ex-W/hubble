import { describe, expect, it } from 'vitest'
import { BAND_COUNT, createAutoGain, foldVoiceBands } from './spectrum.ts'
import fixture from './fixtures/speech-energy.json'

/** Bytes as the SDK returns them: 1024 values spanning 100–8000 Hz linearly. */
function sdkBytesWithEnergyBelow(hz: number): Uint8Array {
  const bytes = new Uint8Array(1024)
  const cutoff = Math.floor(((hz - 100) / 7900) * 1023)
  bytes.fill(200, 0, cutoff)
  return bytes
}

function normalise(series: number[]): number[] {
  const gain = createAutoGain()
  return series.map((x) => gain.update(x, fixture.frameMs))
}

describe('voice band folding', () => {
  it('spreads speech (energy below 3 kHz) across most of the rim', () => {
    // Regression: the linear fold put everything under 3 kHz into the first
    // few bands, so only a small arc of the orb ever moved.
    const bands = new Float32Array(BAND_COUNT)
    foldVoiceBands(sdkBytesWithEnergyBelow(3000), bands)
    const active = bands.filter((v) => v > 0.5).length
    expect(active / BAND_COUNT).toBeGreaterThan(0.7)
  })

  it('maps a tone to one place: low pitch to low bands, high pitch to high', () => {
    const bands = new Float32Array(BAND_COUNT)
    const tone = (hz: number) => {
      const bytes = new Uint8Array(1024)
      bytes[Math.round(((hz - 100) / 7900) * 1023)] = 255
      foldVoiceBands(bytes, bands)
      return bands.indexOf(Math.max(...bands))
    }
    expect(tone(200)).toBeLessThan(tone(1000))
    expect(tone(1000)).toBeLessThan(tone(6000))
  })

  it('returns silence for an empty frame (SDK not connected yet)', () => {
    const bands = new Float32Array(BAND_COUNT).fill(0.7)
    foldVoiceBands(new Uint8Array(0), bands)
    expect(Math.max(...bands)).toBe(0)
  })
})

describe('auto-gain on recorded speech', () => {
  it('lights up a quiet microphone as fully as a loud one', () => {
    // Same sentence, one copy 20 dB down. A fixed mapping would leave the
    // quiet one at half brightness; the orb should react to both.
    const loud = normalise(fixture.loud)
    const quiet = normalise(fixture.quiet)
    expect(Math.max(...loud)).toBeGreaterThan(0.9)
    expect(Math.max(...quiet)).toBeGreaterThan(0.9)
  })

  it('stays dark in the room noise before the first word', () => {
    // The fixture has 600ms of pink-noise room tone before speech.
    const leadIn = normalise(fixture.loud).slice(0, 30)
    expect(Math.max(...leadIn)).toBeLessThan(0.05)
  })

  it('dips in the mid-sentence pause instead of staying pinned', () => {
    const loud = normalise(fixture.loud)
    // Between "Hey Hubble." and the question there is a 500ms pause.
    const firstPeak = loud.findIndex((v) => v > 0.8)
    const pause = loud.slice(firstPeak + 20, firstPeak + 80)
    expect(Math.min(...pause)).toBeLessThan(0.3)
  })

  it('treats a constant hum as background, not as speech', () => {
    const gain = createAutoGain()
    let out = 1
    for (let i = 0; i < 200; i++) out = gain.update(0.3, 16)
    expect(out).toBeLessThan(0.05)
  })
})
