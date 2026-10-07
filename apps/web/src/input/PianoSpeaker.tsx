import { useEffect, useRef, useState } from 'react'
import { createPiano, lessonCues, type Cue, type LessonView, type Piano } from './pianoSound.ts'

/**
 * The operator's browser as the piano's speaker. Mounted once, next to
 * MidiBridge on the operating surface, so it plays whichever mode is showing.
 *
 * Why it plays only from the server's input stream (/api/input/events), never
 * from the local MIDI callback: every press, real (forwarded by MidiBridge)
 * or simulated (curl, the CLI), passes through /api/input/midi and is emitted
 * there exactly once. Playing the local callback too would sound a real press
 * twice.
 *
 * The lesson hint (owner: "play the audio … as a hint that this one is the
 * next one") is read from /api/operator/status: after each press, and on a
 * slow poll so a lesson started from anywhere is announced. lessonCues owns
 * what to say; this component only fetches and plays.
 */
const KEY = 'hubble.sound'
type Prefs = { on: boolean; volume: number }

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '') as Partial<Prefs>
    return { on: p.on !== false, volume: typeof p.volume === 'number' ? p.volume : 0.6 }
  } catch {
    return { on: true, volume: 0.6 }
  }
}

// Leave the struck note room before the hint, so the two don't blur.
const HINT_DELAY_MS = 380

export function PianoSpeaker() {
  const piano = useRef<Piano>(null as unknown as Piano)
  if (!piano.current) piano.current = createPiano()
  const [prefs, setPrefs] = useState(loadPrefs)
  const [unlocked, setUnlocked] = useState(false)
  const on = useRef(prefs.on)
  on.current = prefs.on

  useEffect(() => {
    piano.current.setVolume(prefs.volume)
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs))
    } catch {
      /* private mode: the setting just isn't remembered */
    }
  }, [prefs])

  // Browsers keep audio suspended until a user gesture: the first click
  // anywhere on the page unlocks it.
  useEffect(() => {
    const unlock = () => void piano.current.resume().then(() => setUnlocked(piano.current.running()))
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  useEffect(() => {
    // No EventSource (jsdom in the surface's tests): no speaker, nothing to fetch.
    if (typeof EventSource === 'undefined') return
    let last: LessonView = null
    let alive = true
    const play = (cues: Cue[]) => {
      if (!on.current) return
      let at = HINT_DELAY_MS
      for (const c of cues) {
        if (c.kind === 'bonk') piano.current.bonk()
        else if (c.kind === 'blip') setTimeout(() => piano.current.blip(), 150)
        else {
          const note = c.note
          setTimeout(() => on.current && piano.current.noteOn(note, 70, 'hint'), at)
          at += HINT_DELAY_MS
        }
      }
    }
    const check = (pressed: number | null) =>
      fetch('/api/operator/status')
        .then((r) => r.json())
        .then((s: { lesson?: LessonView }) => {
          if (!alive) return
          const next = s.lesson ?? null
          play(lessonCues(last, next, pressed))
          last = next
        })
        .catch(() => {})

    // The press's result is computed synchronously in the same request that
    // emitted it, so by the time this fetch lands the status already has it.
    const es = new EventSource('/api/input/events')
    es.onmessage = (m) => {
      let e: { kind?: string; type?: string; note?: number; velocity?: number }
      try {
        e = JSON.parse(m.data as string)
      } catch {
        return
      }
      if (e.kind !== 'midi' || typeof e.note !== 'number') return
      if (e.type === 'note-off') return piano.current.noteOff(e.note)
      if (on.current) piano.current.noteOn(e.note, e.velocity ?? 90, 'press')
      void check(e.note)
    }
    void check(null)
    const poll = setInterval(() => void check(null), 1500)
    return () => {
      alive = false
      es.close()
      clearInterval(poll)
    }
  }, [])

  return (
    <span className="piano-sound">
      <button
        type="button"
        aria-pressed={prefs.on}
        title={prefs.on ? 'piano sound on' : 'piano sound off'}
        onClick={() => setPrefs((p) => ({ ...p, on: !p.on }))}
      >
        {prefs.on ? '🔊' : '🔇'}
      </button>
      <input
        type="range"
        aria-label="piano volume"
        min={0}
        max={1}
        step={0.05}
        value={prefs.volume}
        disabled={!prefs.on}
        onChange={(e) => setPrefs((p) => ({ ...p, volume: Number(e.target.value) }))}
      />
      {prefs.on && !unlocked && <small>click to enable sound</small>}
    </span>
  )
}
