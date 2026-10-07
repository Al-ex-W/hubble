import { createContext, useContext, type ReactNode } from 'react'
import { sendMidi, useMidi, type MidiNote } from './useMidi.ts'

/**
 * The page's one MIDI forwarder: the real MiniLab's key presses go to the
 * runtime (/api/input/midi) for as long as the operating surface is open,
 * whichever mode or panel is showing.
 *
 * Why it is its own component: until 7 Oct the forwarding lived inside
 * LessonPanel, the virtual MiniLab. Show mode (#76) mounts that panel only
 * when the operator opens the backup, so in the default view the real
 * keyboard reached nothing and Act 2 couldn't judge a single press (the
 * audit of 7 Oct). Forwarding is the job of the page, not of a panel. It is
 * mounted once, at the surface, and LessonPanel only reads its status.
 *
 * The rule "one forwarder per page" is what used to be "one LessonPanel per
 * page" (#66): two forwarders would send every press twice.
 */
export interface MidiStatus {
  inputs: string[]
  error: string | null
}

const Status = createContext<MidiStatus | null>(null)

/** The connected devices, for display. null outside a MidiBridge (e.g. a test that mounts a panel alone). */
export const useMidiStatus = () => useContext(Status)

// Stable across renders, so useMidi's effect binds once, not on every render.
const forward = (n: MidiNote) => void sendMidi(n)

export function MidiBridge({ children }: { children: ReactNode }) {
  const status = useMidi(forward)
  return <Status.Provider value={status}>{children}</Status.Provider>
}
