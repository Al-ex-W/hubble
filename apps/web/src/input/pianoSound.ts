/**
 * A tiny Web Audio piano for the operator's browser (owner, 7 Oct: "play the
 * audio from my browser"). The room has no sound we may use, so the laptop on
 * :5173/ is the piano's speaker.
 *
 * Why synthesis and not samples: no new dependency and no asset to serve on
 * demo day; a triangle with a quick attack and a ~1 s exponential decay reads
 * as "a key" well enough. Two timbres, on purpose (owner's clarification):
 * - `press`: triangle, what a person actually played;
 * - `hint`: a softer, shorter pure sine meaning "this one is next",
 *   so the ear can tell "you pressed" from "press this" without looking.
 *
 * Pure parts (midiToHz, lessonCues) are exported for tests; the AudioContext
 * part can't run in jsdom and is kept thin.
 */

/** Equal temperament, A4 (MIDI 69) = 440 Hz. */
export const midiToHz = (note: number) => 440 * 2 ** ((note - 69) / 12)

export type Timbre = 'press' | 'hint'

export interface Piano {
  noteOn(note: number, velocity?: number, timbre?: Timbre): void
  noteOff(note: number): void
  /** A short low thud for a wrong lesson press. */
  bonk(): void
  /** A soft high blip for a finished song. */
  blip(): void
  setVolume(v: number): void
  /** Browsers start an AudioContext suspended until a user gesture; call from one. */
  resume(): Promise<void>
  running(): boolean
}

type Voice = { osc: OscillatorNode; gain: GainNode }

export function createPiano(): Piano {
  // Lazily built: constructing an AudioContext before a gesture logs a
  // warning in Chrome, and tests (jsdom) have none at all.
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let volume = 0.6
  const held = new Map<number, Voice>()

  const audio = () => {
    if (!ctx) {
      const AC = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return null
      ctx = new AC()
      master = ctx.createGain()
      master.gain.value = volume
      master.connect(ctx.destination)
    }
    return ctx.state === 'running' ? { ctx, master: master! } : null
  }

  // One envelope for every sound: a 5 ms attack (no click), then an
  // exponential fall to silence over `decay` seconds. Polyphony is free: each
  // tone is its own oscillator + gain, garbage-collected once it stops.
  const tone = (hz: number, type: OscillatorType, peak: number, decay: number, at = 0) => {
    const a = audio()
    if (!a) return null
    const t = a.ctx.currentTime + at
    const osc = a.ctx.createOscillator()
    const gain = a.ctx.createGain()
    osc.type = type
    osc.frequency.value = hz
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + decay)
    osc.connect(gain).connect(a.master)
    osc.start(t)
    osc.stop(t + decay + 0.05)
    return { osc, gain }
  }

  return {
    noteOn(note, velocity = 90, timbre = 'press') {
      const hz = midiToHz(note)
      const v = Math.max(0.05, Math.min(1, velocity / 127))
      const voice = timbre === 'hint' ? tone(hz, 'sine', 0.22, 0.7) : tone(hz, 'triangle', 0.35 * v, 1.1)
      if (!voice || timbre === 'hint') return
      // A re-struck key before its note-off: release the old voice first.
      held.get(note)?.osc.stop()
      held.set(note, voice)
    },
    noteOff(note) {
      const voice = held.get(note)
      held.delete(note)
      if (!voice || !ctx) return
      // Release: a quick 120 ms fade from wherever the decay has got to.
      const t = ctx.currentTime
      voice.gain.gain.cancelScheduledValues(t)
      voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), t)
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
      voice.osc.stop(t + 0.15)
    },
    bonk() {
      tone(110, 'square', 0.12, 0.18)
      tone(82, 'sine', 0.3, 0.22)
    },
    blip() {
      tone(1568, 'sine', 0.15, 0.25)
      tone(2093, 'sine', 0.12, 0.35, 0.09)
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v))
      if (master) master.gain.value = volume
    },
    async resume() {
      audio()
      if (ctx && ctx.state !== 'running') await ctx.resume()
    },
    running: () => ctx?.state === 'running',
  }
}

export type LessonView = { song: string; index: number; total: number; expected: number | null } | null

export type Cue = { kind: 'hint'; note: number } | { kind: 'bonk' } | { kind: 'blip' }

/**
 * What the speaker should say when the lesson changes from `prev` to `next`,
 * after `pressed` (or after a status poll, when `pressed` is null). Pure, so
 * the owner's three rules are testable without audio:
 * - a lesson starts → hint its first expected note;
 * - a correct press moves the index → hint the new expected note (or blip at the end);
 * - a wrong press (index unchanged, a note was pressed) → bonk, then replay the expected note.
 *
 * Why diff two snapshots and not read a "result" event: the server publishes
 * presses on /api/input/events but not their lesson result; the result only
 * comes back to whoever posted the press. Diffing the status works for real
 * and simulated presses alike, and one diff owner means a poll and a
 * post-press fetch that both see an advance can't hint twice (the second one
 * sees no change).
 */
export function lessonCues(prev: LessonView, next: LessonView, pressed: number | null): Cue[] {
  if (!next) return []
  const started = !prev || prev.song !== next.song || next.index < prev.index
  if (started) return next.expected !== null ? [{ kind: 'hint', note: next.expected }] : []
  if (next.index > prev.index) return next.expected === null ? [{ kind: 'blip' }] : [{ kind: 'hint', note: next.expected }]
  if (pressed !== null && next.expected !== null && pressed !== next.expected) return [{ kind: 'bonk' }, { kind: 'hint', note: next.expected }]
  return []
}
