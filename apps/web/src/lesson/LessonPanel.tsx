import { useCallback, useEffect, useState } from 'react'
import './lesson.css'
import { sendMidi } from '../input/useMidi.ts'
import { useMidiStatus } from '../input/MidiBridge.tsx'

/**
 * Bench controls for act 2: start a song, see the plugged-in MIDI devices,
 * and play a virtual MiniLab (25 keys from C3) when the real one isn't here.
 * Both the real and the virtual keyboard send the same MIDI-shaped events to
 * the runtime, so the lesson can't tell them apart.
 */
const LOWEST = 48
const KEYS = 25
const BLACK = new Set([1, 3, 6, 8, 10])
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

// upcoming is optional: an older server (or a test fixture) without it just shows no "after" key.
type Lesson = { song: string; index: number; total: number; expected: number | null; upcoming?: number | null } | null

interface LessonState {
  lesson: Lesson
}

/**
 * Hand the panel to an owner that already tracks the lesson (the operator
 * page, #34). Without it the panel fetches and starts lessons on its own,
 * as on the bench.
 *
 * Why the operator page needs this: embedded on its own, the panel had a
 * second copy of the lesson state that only refreshed on its own clicks, so
 * the operator's act buttons and reset left it showing the wrong song and
 * the wrong lit key (review #40, finding 3); and its song buttons went to
 * /api/lesson/start, skipping the operator's act switch that clears the math
 * answer off the table first (finding 2). One owner for both: the page.
 */
export interface LessonControl {
  lesson: Lesson
  start(song: string): void
  stop(): void
  /** A virtual key was sent; the owner refreshes its state. */
  played(): void
}

export function LessonPanel({ control }: { control?: LessonControl } = {}) {
  const [own, setOwn] = useState<LessonState>({ lesson: null })
  const refresh = useCallback(() => {
    if (control) return control.played()
    fetch('/api/runtime')
      .then((r) => r.json())
      .then(setOwn)
      .catch(() => undefined)
  }, [control])
  const onNote = useCallback(
    (n: { type: 'note-on' | 'note-off'; note: number; velocity: number }) => {
      void sendMidi(n).then(refresh)
    },
    [refresh],
  )
  // The real keyboard is forwarded by the page's MidiBridge, not here: this
  // panel can be closed (Show keeps it folded away), and the keyboard must
  // keep working. The panel shows the bridge's status and sends only its own
  // virtual keys.
  const midi = useMidiStatus() ?? { inputs: [], error: null }
  // Controlled: the owner already polls, so mounting fetches nothing.
  useEffect(() => {
    if (!control) refresh()
  }, [control, refresh])
  const state: LessonState = control ? { lesson: control.lesson } : own

  const start = (song: string) =>
    control ? control.start(song) : void fetch('/api/lesson/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ song }) }).then(refresh)
  const stop = () => (control ? control.stop() : void fetch('/api/lesson/stop', { method: 'POST' }).then(refresh))
  const expected = state.lesson?.expected ?? null
  const upcoming = state.lesson?.upcoming ?? null

  return (
    <div className="lesson-panel">
      <div className="lesson-row">
        <strong>piano lesson</strong>
        <button onClick={() => start('ode-to-joy')}>Ode to Joy</button>
        <button onClick={() => start('twinkle')}>Twinkle</button>
        <button onClick={() => stop()}>stop</button>
        <span className="lesson-status">
          {state.lesson ? `${state.lesson.song}: ${state.lesson.index}/${state.lesson.total}${upcoming !== null ? ` · then ${NAMES[upcoming % 12]}${Math.floor(upcoming / 12) - 1}` : ''}` : 'no lesson'} ·{' '}
          {midi.error ?? (midi.inputs.length ? `MIDI: ${midi.inputs.join(', ')}` : 'no MIDI device (virtual keys below)')}
        </span>
      </div>
      <div className="virtual-minilab" aria-label="virtual MiniLab 3">
        {Array.from({ length: KEYS }, (_, i) => LOWEST + i).map((note) => (
          <button
            key={note}
            className={`vkey ${BLACK.has(note % 12) ? 'black' : 'white'}${note === expected ? ' next' : ''}${note === upcoming && note !== expected ? ' after' : ''}`}
            title={`${NAMES[note % 12]}${Math.floor(note / 12) - 1}`}
            onPointerDown={() => onNote({ type: 'note-on', note, velocity: 96 })}
            onPointerUp={() => onNote({ type: 'note-off', note, velocity: 0 })}
          />
        ))}
      </div>
    </div>
  )
}
