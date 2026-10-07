import { useEffect, useState } from 'react'
import './room.css'

/**
 * The bench's window into the room (the emulator in development, ROOM=emulator).
 * Shows what each display has *actually been told* to show, by loading that
 * URL in a frame, the same way the room's Pi browsers will. So the bench
 * exercises the real path: runtime → display command → page → SSE → render.
 *
 * Also the room's controls we need to rehearse: press a Hue button, hand the
 * slot to another team and back (423 and the reset), calibrate the camera,
 * record the lidar's empty-table baseline.
 */
interface EmuState {
  displays: Record<string, { type: string; url?: string } | undefined>
  lights: Record<string, { on?: boolean; bri?: number; color?: string }>
  ourSlot: boolean
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json().catch(() => ({})))

export function RoomPanel() {
  const [s, setS] = useState<EmuState | null>(null)
  const [note, setNote] = useState('')
  useEffect(() => {
    const es = new EventSource('/emulator/state')
    es.onmessage = (m) => setS(JSON.parse(m.data))
    es.onerror = () => setS(null)
    return () => es.close()
  }, [])
  if (!s) return <div className="room-panel off">room: no emulator (run npm run dev:emulator and start the server with ROOM=emulator)</div>

  const frame = (id: string) => {
    const d = s.displays[id]
    // Our own pages, framed at their real 16:9; anything else is shown as its command.
    return d?.type === 'url' && d.url ? <iframe title={id} src={new URL(d.url).pathname} /> : <div className="blank">{d ? d.type : 'idle (room default)'}</div>
  }
  return (
    <div className="room-panel">
      <div className="room-row">
        <strong>room (emulator)</strong>
        <span className={s.ourSlot ? 'slot ours' : 'slot theirs'}>{s.ourSlot ? 'our slot' : 'another team’s slot: writes get 423'}</span>
        <button onClick={() => void post('/emulator/button', { id: 'hue-button-1' })}>press hue button</button>
        <button onClick={() => void post('/emulator/slot', { team: s.ourSlot ? 'team-b' : 'hubble', minutes: 30 })}>{s.ourSlot ? 'give slot away' : 'take slot back'}</button>
        <button onClick={() => void post('/api/calibrate').then((r) => setNote(r.ok ? `calibrated, rms ${r.rms?.toFixed(1)} px` : `calibration: ${r.error}`))}>calibrate camera</button>
        {/* The spatial service owns the lidar and its baseline since #89; the old /api/lidar/baseline is gone. */}
        <button onClick={() => void post('/api/spatial/baseline').then((r) => setNote(r.ok ? `baseline from ${r.rotations} rotations` : `baseline: ${r.reason ?? r.error}`))}>record lidar baseline</button>
        <span className="note">{note}</span>
      </div>
      <div className="room-displays">
        <figure>
          <figcaption>tv-1</figcaption>
          {frame('tv-1')}
        </figure>
        <figure>
          <figcaption>tv-2</figcaption>
          {frame('tv-2')}
        </figure>
        <figure className="lights">
          <figcaption>lights</figcaption>
          <div className="glows">
            {Object.entries(s.lights)
              .filter(([id]) => id !== '__scene')
              .map(([id, l]) => (
                <span key={id} title={id} style={{ background: l.on === false ? '#111' : l.color ?? '#888', opacity: 0.25 + 0.75 * ((l.bri ?? 127) / 254) }} />
              ))}
          </div>
        </figure>
      </div>
    </div>
  )
}
