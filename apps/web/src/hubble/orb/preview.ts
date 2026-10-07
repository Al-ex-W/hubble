import type { AudioTap } from './Orb.tsx'
import { ORB_STATES, type OrbState } from './dynamics.ts'

/**
 * Dev-only orb preview: `/?preview=listening` (or thinking, speaking, idle,
 * connecting, cycle) drives the orb from a synthetic voice with no
 * microphone, no ElevenLabs session and no quota spent. It exists because the
 * orb's look can only be judged by eye, and tuning it by talking to a live
 * agent burns free-tier minutes and characters.
 */
export function readPreview(search: string): OrbState | 'cycle' | null {
  const value = new URLSearchParams(search).get('preview')
  if (value === 'cycle') return 'cycle'
  return ORB_STATES.includes(value as OrbState) ? (value as OrbState) : null
}

/** Cycle order for `?preview=cycle`, mirroring a real turn. */
export const PREVIEW_CYCLE: OrbState[] = ['idle', 'connecting', 'listening', 'thinking', 'speaking', 'listening']

/**
 * Syllable-like synthetic speech: ~4 Hz bursts with phrase-length gaps, a
 * formant-ish spectrum whose peak wanders, roughly the SDK's byte scale.
 */
export function createSyntheticVoiceTap(): AudioTap {
  const bytes = new Uint8Array(1024)
  const voice = (seed: number) => {
    const t = performance.now() / 1000 + seed
    const phrase = Math.sin(t * 0.7) > -0.3 ? 1 : 0 // talk ~70% of the time
    const syllable = Math.max(0, Math.sin(t * 2 * Math.PI * 3.7)) ** 0.6
    const amp = phrase * syllable
    const formant = 0.12 + 0.08 * Math.sin(t * 1.3)
    for (let i = 0; i < bytes.length; i++) {
      const x = i / bytes.length
      const shape = Math.exp(-((x - formant) ** 2) / 0.004) + 0.5 * Math.exp(-((x - formant * 2.6) ** 2) / 0.01)
      bytes[i] = Math.min(255, Math.round(amp * 170 * shape + 6 * Math.random()))
    }
    return bytes
  }
  return { input: () => voice(0), output: () => voice(3.1) }
}
