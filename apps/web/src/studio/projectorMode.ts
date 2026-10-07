import { useCallback, useEffect, useState } from 'react'

/**
 * What the projector shows: the studio canvas, or the calibration pattern.
 *
 * Why the SERVER owns this and not the page: the projector runs as a kiosk on
 * the Pi, nobody can click it, and a reload would throw away the running
 * components. So any other browser (the bench's Setup tab, the studio, a curl
 * from a phone) POSTs the mode to the server and the projector page follows
 * over SSE. This file is the shared vocabulary of both sides: the server
 * validates against PROJECTOR_MODES and the pages import the same list, so the
 * two cannot disagree about what a valid mode is.
 */
export const PROJECTOR_MODES = ['canvas', 'calibrate'] as const
export type ProjectorMode = (typeof PROJECTOR_MODES)[number]

/** What the server holds and sends: the mode and when it was last switched. */
export interface ProjectorModeState {
  mode: ProjectorMode
  /** ISO time of the last switch. The pattern's legend prints it so a photo of the table says which switch it shows. */
  since: string
}

export const isProjectorMode = (value: unknown): value is ProjectorMode => (PROJECTOR_MODES as readonly unknown[]).includes(value)

/**
 * Follows the server's mode over SSE. The first event carries the current state
 * (so no separate fetch: nothing here may fire a request when a page only
 * mounts a switch), and EventSource reconnects by itself after a server
 * restart (tsx watch restarts it on every save), so the projector recovers
 * without a reload. Until the first event the mode is `canvas`: an unreachable
 * server must never leave the table showing the calibration pattern.
 */
export function useProjectorMode() {
  const [state, setState] = useState<ProjectorModeState>({ mode: 'canvas', since: '' })
  const [error, setError] = useState('')
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const events = new EventSource('/api/projector/events')
    events.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Partial<ProjectorModeState>
        if (isProjectorMode(data.mode)) setState({ mode: data.mode, since: String(data.since ?? '') })
      } catch {
        // A malformed event is ignored; the next one carries the full state anyway.
      }
    }
    return () => events.close()
  }, [])
  const choose = useCallback(async (mode: ProjectorMode) => {
    setError('')
    try {
      const response = await fetch('/api/projector/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
      if (!response.ok) throw new Error('The server refused that mode.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not reach the server.')
    }
  }, [])
  return { ...state, choose, error }
}
