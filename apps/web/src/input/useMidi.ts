import { useEffect, useState } from 'react'

/**
 * The MiniLab 3 (or any class-compliant MIDI keyboard) plugged into the laptop,
 * via the Web MIDI API. Its key presses are the lesson's ground truth (#19):
 * exact, instant, no inference. Runs in the laptop's browser (localhost is a
 * secure context, so no HTTPS is needed) and forwards note events to the
 * runtime, which owns the lesson.
 *
 * Hot-plug: devices that appear or vanish update `inputs` without a reload.
 */
export interface MidiNote {
  type: 'note-on' | 'note-off'
  note: number
  velocity: number
  device: string
}

/**
 * Binds every MIDI input to `onNote` for as long as the component is mounted.
 *
 * The `cancelled` flag is the point of this shape. requestMIDIAccess is async,
 * and React's StrictMode mounts, cleans up and re-mounts every effect at once
 * in development. The old cleanup ran before the promise resolved, saw no
 * `access` yet, and removed nothing. Then the first mount's promise resolved
 * and bound anyway, next to the second mount's binding. Chrome hands each
 * requestMIDIAccess call its own MIDIInput objects, so both handlers fired,
 * and every key press reached the server twice (the audit of 7 Oct; on site
 * the lesson advanced on a correct press, then flashed the same key red).
 * Now a cleanup that comes first marks the effect cancelled, and the late
 * promise binds nothing.
 */
export function useMidi(onNote: (n: MidiNote) => void) {
  const [inputs, setInputs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<MIDIAccess> }
    if (!nav.requestMIDIAccess) {
      setError('this browser has no Web MIDI (use Chrome/Chromium)')
      return
    }
    let cancelled = false
    let access: MIDIAccess | null = null
    const bind = () => {
      if (!access || cancelled) return
      const names: string[] = []
      access.inputs.forEach((input) => {
        names.push(input.name ?? input.id)
        input.onmidimessage = (m) => {
          const [status, note, velocity] = m.data ?? []
          const cmd = status & 0xf0
          // 0x90 with velocity 0 is a release by MIDI convention ("running status").
          if (cmd === 0x90 && velocity > 0) onNote({ type: 'note-on', note, velocity, device: input.name ?? input.id })
          else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) onNote({ type: 'note-off', note, velocity: 0, device: input.name ?? input.id })
        }
      })
      setInputs(names)
    }
    nav
      .requestMIDIAccess()
      .then((a) => {
        if (cancelled) return
        access = a
        a.onstatechange = bind
        bind()
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(`MIDI access refused: ${e instanceof Error ? e.message : String(e)}`)
      })
    return () => {
      cancelled = true
      access?.inputs.forEach((i) => (i.onmidimessage = null))
      if (access) access.onstatechange = null
    }
  }, [onNote])

  return { inputs, error }
}

export async function sendMidi(n: Omit<MidiNote, 'device'>) {
  await fetch('/api/input/midi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(n) }).catch(() => undefined)
}
