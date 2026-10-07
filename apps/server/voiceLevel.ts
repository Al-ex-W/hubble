/**
 * THE ONE OWNER of "how loud is Hubble's voice right now" on the server.
 *
 * Owner, 7 Oct 2026: make the TV light strips "pulse in the waveform of the
 * agent's voice". The only place the voice is actually heard is the browser
 * that plays the say audio (the landing page), so that browser measures the
 * level (WebAudio analyser, RMS) and posts it here; this bus fans it out in
 * process to whoever renders it: the TV page's orb (via the speech channel)
 * and the Hue strip driver (voiceLights.ts).
 *
 * Why a bus and not a direct call: two consumers with different rates (the TV
 * at ~20 Hz, Hue at what the bridge tolerates) must not know about each
 * other or about the browser. Producers publish, consumers subscribe.
 *
 * Contract (shared by the TV/word-timing work and the light work):
 *  - level is 0..1 (already normalised by the producer), at is ms since epoch;
 *  - `speech` is the say line's id, or null when nothing is speaking;
 *  - a frame with level 0 and speech null means "silence now": consumers
 *    return to their resting state (lights back to their idle mood).
 */
export interface VoiceLevelFrame { level: number; at: number; speech: string | null }

export function createVoiceLevelBus() {
  const subscribers = new Set<(frame: VoiceLevelFrame) => void>()
  let last: VoiceLevelFrame = { level: 0, at: 0, speech: null }
  return {
    publish(frame: VoiceLevelFrame) {
      // Clamp here once, so no consumer can be driven out of range by a bad producer.
      last = { ...frame, level: Math.min(1, Math.max(0, Number.isFinite(frame.level) ? frame.level : 0)) }
      for (const fn of subscribers) {
        try { fn(last) } catch { /* one broken consumer must not stop the others */ }
      }
    },
    subscribe(fn: (frame: VoiceLevelFrame) => void) {
      subscribers.add(fn)
      return () => { subscribers.delete(fn) }
    },
    last: () => last,
  }
}
export type VoiceLevelBus = ReturnType<typeof createVoiceLevelBus>
