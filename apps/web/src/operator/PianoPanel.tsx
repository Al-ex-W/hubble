import { useEffect, useRef, useState } from 'react'
import './operator.css'
import type { CameraPoint, PianoState } from '../../../shared/piano.ts'

const labels: Record<PianoState['status'], string> = {
  off: 'Off', 'no-camera': 'No camera connected', searching: 'Searching for piano', tracking: 'Tracking',
  'last-known': 'Last known position', 'detector-unavailable': 'Detector unavailable', 'camera-unavailable': 'Camera unavailable',
}
const points = (corners: CameraPoint[]) => corners.map((p) => `${p.x},${p.y}`).join(' ')
const noteName = (note: number) => `${['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][note % 12]}${Math.floor(note / 12) - 1}`

/** Camera inspection has its own poll: the general operator status can wait
 * on room health, and should never transfer a JPEG to every status consumer.
 * Polls are sequential. A toggle invalidates an older read so a slow GET
 * cannot check the box again after the operator has just unchecked it. */
export function PianoPanel() {
  const [s, setS] = useState<PianoState | null>(null)
  const [down, setDown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const revision = useRef(0)
  const mutating = useRef(false)
  const lifetime = useRef<AbortController | null>(null)

  useEffect(() => {
    const ctl = new AbortController()
    lifetime.current = ctl
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const mine = revision.current
      try {
        if (!mutating.current) {
          const res = await fetch('/api/operator/piano', { signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(5000)]), cache: 'no-store' })
          if (!res.ok) throw new Error('status unavailable')
          const value: PianoState = await res.json()
          if (!ctl.signal.aborted && mine === revision.current) { setS(value); setDown(false) }
        }
      } catch {
        if (!ctl.signal.aborted && mine === revision.current) setDown(true)
      } finally {
        if (!ctl.signal.aborted) timer = setTimeout(poll, 1000)
      }
    }
    void poll()
    return () => { ctl.abort(); clearTimeout(timer) }
  }, [])

  const change = async (enabled: boolean) => {
    if (mutating.current || !lifetime.current) return
    mutating.current = true
    revision.current++
    setBusy(true)
    setMessage('')
    const ctl = lifetime.current
    try {
      const res = await fetch('/api/operator/piano', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }), signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(5000)]) })
      if (!res.ok) throw new Error('toggle refused')
      const value: PianoState = await res.json()
      if (!ctl.signal.aborted) { setS(value); setDown(false) }
    } catch {
      if (!ctl.signal.aborted) { setMessage('Could not change piano playground. Try again.'); setDown(true) }
    } finally {
      mutating.current = false
      if (!ctl.signal.aborted) setBusy(false)
    }
  }

  const snapshot = s?.enabled ? s.snapshot : null
  const live = !down && s?.status === 'tracking'
  return (
    <section className="op-piano" aria-label="Piano camera controls">
      <div className="op-piano-head">
        <label className="op-piano-toggle">
          <input type="checkbox" checked={s?.enabled ?? false} disabled={!s || busy} onChange={(e) => void change(e.target.checked)} />
          <span>Piano playground<small>Find the keyboard with the room camera</small></span>
        </label>
        <span className={`op-pill ${live ? 'ok' : 'warn'}`} role="status">
          {down ? 'Server unreachable · preview paused' : s ? labels[s.status] : 'Connecting…'}
          {snapshot && ` · ${snapshot.keys.length} keys`}
        </span>
      </div>
      {snapshot ? (
        <div className={`op-piano-preview ${live ? '' : 'stale'}`}>
          {/* One SVG coordinate system for image and quads survives resizing,
              portrait screens and rotated keyboards without offset arithmetic.
              Remount each observation so an old decoded image never sits under
              a new frame's key outlines while its JPEG loads. */}
          <svg key={snapshot.id} viewBox={`0 0 ${snapshot.width} ${snapshot.height}`} role="img" aria-label="Room camera with detected piano keys">
            <image href={snapshot.image} width={snapshot.width} height={snapshot.height} />
            {snapshot.keybed && <polygon className="piano-boundary" points={points(snapshot.keybed)} vectorEffect="non-scaling-stroke" />}
            {snapshot.keys.map((key) => {
              const x = key.corners.reduce((sum, p) => sum + p.x, 0) / 4
              const y = key.corners.reduce((sum, p) => sum + p.y, 0) / 4
              return <g key={key.note}>
                <polygon data-note={key.note} className={key.black ? 'piano-key black' : 'piano-key white'} points={points(key.corners)} vectorEffect="non-scaling-stroke"><title>{noteName(key.note)} · MIDI {key.note}</title></polygon>
                <text x={x} y={y} textAnchor="middle" dominantBaseline="middle" fontSize={Math.max(8, snapshot.width / 110)}>{noteName(key.note)}</text>
              </g>
            })}
          </svg>
          {!live && <span className="op-piano-frozen">{s?.status === 'camera-unavailable' || down ? 'Preview paused' : 'Detection not confirmed'}</span>}
        </div>
      ) : (
        <div className="op-piano-empty">{!s?.enabled ? 'Enable Piano playground to inspect the camera and all 25 keys.' : !s.available ? 'Connect a room camera to see the piano.' : 'Waiting for the first camera frame…'}</div>
      )}
      <div className="op-piano-footer">
        <span>{snapshot ? 'Cyan: playable area · Green: white keys · Amber: black keys' : 'Detection uses the room camera.'}
          {s?.enabled && s.ageMs !== null && s.ageMs !== undefined && ` · Last confirmed ${Math.floor(s.ageMs / 1000)} s ago`}
        </span>
        <span>{s?.calibrated ? 'Projection calibrated' : 'Camera detection works now; use Setup’s camera ↔ projector calibration before projecting onto the keys.'}</span>
      </div>
      {message && <p className="op-piano-message" role="status">{message}</p>}
    </section>
  )
}
