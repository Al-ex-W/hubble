import { useEffect, useState } from 'react'
import { HandPanel } from '../hands/HandPanel.tsx'
import { RoomHandsProvider } from '../hands/RoomHands.tsx'
import './spatial.css'
import type { SpatialFrame as Snapshot } from '../../../server/spatial/frame.ts'
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const nothing = () => {}

/** An operator view of the SAME state features consume. It never transforms
 * camera or lidar coordinates itself. No dot projection or room write is
 * triggered by opening this page: the lidar registration run's targets appear
 * only after "Start registration", and only with the room output armed. */

type RunState = { phase: string; index: number; total: number; message: string; result: { heldOutMaxMm: number; rmsTableMm: number; goalMm: number } | null }

/**
 * Lidar touch setup (docs/plans/2026-10-07-lidar-web.md): the empty-table
 * baseline, the registration run (#89 T4) and the keyboard's input source.
 * Every decision is the server's; this panel is three buttons and what the
 * server says back, so a reload or a second tab can't diverge from the run.
 */
function LidarSetup({ snapshot, onError }: { snapshot: Snapshot | null; onError(e: string): void }) {
  const [run, setRun] = useState<RunState | null>(null)
  const [mode, setMode] = useState<string>('')
  const [busy, setBusy] = useState('')
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const [r, k] = await Promise.all([fetch('/api/spatial/registration/run'), fetch('/api/keyboard/input')])
        if (live && r.ok) setRun(await r.json())
        if (live && k.ok) setMode(((await k.json()) as { mode: string }).mode)
      } catch {
        /* the status line above already says when the server is gone */
      } finally {
        if (live) timer = setTimeout(read, 400)
      }
    }
    void read()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [])
  const post = async (label: string, url: string, body: unknown) => {
    setBusy(label)
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const out = (await r.json().catch(() => ({}))) as { error?: string; reason?: string }
      if (!r.ok) onError(out.error ?? out.reason ?? `${label} failed (${r.status})`)
      else onError('')
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy('')
    }
  }
  const running = run && ['capturing', 'lifting', 'fitting'].includes(run.phase)
  return (
    <section aria-label="Lidar touch setup" style={{ border: '1px solid #666', padding: 12, margin: '12px 0' }}>
      <h2>Lidar touch</h2>
      <p>
        Touch: {snapshot?.touchEnabled ? 'on' : 'off'} · {snapshot?.reason ?? '…'} · Baseline: {snapshot?.lidar.baseline.state ?? 'none'}
      </p>
      <p>
        1. Clear the table, hands off:{' '}
        <button disabled={!!busy || !!running} onClick={() => void post('baseline', '/api/spatial/baseline', { ms: 3000 })}>
          {busy === 'baseline' ? 'Learning the empty table…' : 'Learn the empty table (3 s)'}
        </button>
      </p>
      <p>
        2. Arm the room output, then hold one fingertip still on each lit dot until it turns green, and lift it:{' '}
        <button disabled={!!busy || !!running} onClick={() => void post('registration', '/api/spatial/registration/run', { action: 'start' })}>
          Start registration (12 dots)
        </button>{' '}
        <button disabled={!running} onClick={() => void post('cancel', '/api/spatial/registration/run', { action: 'cancel' })}>
          Cancel
        </button>
      </p>
      {run && run.phase !== 'idle' && (
        <p role="status">
          {run.phase === 'capturing' || run.phase === 'lifting' ? `Dot ${Math.min(run.index + 1, run.total)} of ${run.total} · ` : ''}
          {run.phase}: {run.message}
          {run.result && ` (held-out ${run.result.heldOutMaxMm.toFixed(1)} mm, goal ${run.result.goalMm} mm${run.result.heldOutMaxMm > run.result.goalMm ? ': keep lidar typing off' : ''})`}
        </p>
      )}
      <p>
        3. Keyboard input: {mode || '…'}{' '}
        <button disabled={!!busy || mode === 'pointer'} onClick={() => void post('pointer', '/api/keyboard/input', { mode: 'pointer' })}>
          Pointer
        </button>{' '}
        <button disabled={!!busy || mode === 'room-lidar'} onClick={() => void post('lidar typing', '/api/keyboard/input', { mode: 'room-lidar' })}>
          Lidar typing
        </button>
      </p>
      <p>Taps and drags on web pages work as soon as touch is on. Lidar typing is separate because a finger hovering a few cm up also counts as a touch.</p>
    </section>
  )
}

export function SpatialPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  const [targets, setTargets] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const response = await fetch('/api/spatial', { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2500)]) })
        if (!response.ok) throw new Error(`Spatial service: ${response.status}`)
        setSnapshot(await response.json())
        setError('')
      } catch (e) {
        if (!abort.signal.aborted) {
          setSnapshot(null)
          setError(String(e))
        }
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(read, 100)
      }
    }
    void read()
    return () => {
      abort.abort()
      clearTimeout(timer)
    }
  }, [])
  const register = async () => {
    setSaving(true)
    try {
      const body = JSON.parse(targets)
      const r = await fetch('/api/spatial/registration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const result = await r.json()
      if (!r.ok) throw new Error(result.error)
      setError('')
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }
  const rawExtent = Math.max(1000, ...(snapshot?.lidar.returns ?? []).map((p) => Math.hypot(p.sensor.x, p.sensor.y))) * 1.05
  return (
    <main className="spatial">
      <h1>Spatial diagnostics</h1>
      <p>Camera, lidar and projected surfaces in one coordinate system. Contact is unverified. Camera tracking starts in diagnostics mode; pinch typing is a separate, explicit choice.</p>
      <button onClick={() => void fetch('/api/keyboard/open', { method: 'POST' }).catch(e => setError(String(e)))}>Open projected keyboard</button>
      <p role="status">
        {error ||
          `Camera: ${snapshot?.camera.state ?? 'unavailable'} · Lidar: ${snapshot?.lidar.health?.state ?? 'not configured'} · Registration: ${snapshot?.calibrated ? 'installed' : 'incomplete'}`}
      </p>
      <LidarSetup snapshot={snapshot} onError={setError} />
      {/* Its own provider: /spatial is a separate page, so its tracker is the page's one tracker (#75). */}
      <RoomHandsProvider>
        <HandPanel initialSource="room" onPress={nothing} onTrail={nothing} kbToTable={identity} />
      </RoomHandsProvider>
      <svg
        viewBox={`0 0 ${snapshot?.surface.widthPx ?? 1920} ${snapshot?.surface.heightPx ?? 1080}`}
        aria-label="Shared projector coordinate view"
        className="spatial-map"
      >
        {!snapshot?.surfaces.length && !snapshot?.camera.fingers.some((p) => p.projector) && !snapshot?.calibration.registration && (
          <text x="60" y="90" fill="#aaa" fontSize={28}>
            Start the camera to see mapped fingers. Lidar alignment awaits measured targets.
          </text>
        )}
        {snapshot?.surfaces.map((s) => (
          <g key={s.instance}>
            <rect x={s.box.x} y={s.box.y} width={s.box.w} height={s.box.h} fill="none" stroke="#888" strokeWidth={3} />
            <text x={s.box.x + 8} y={s.box.y + 24} fill="white" fontSize={20}>
              {s.kind}
            </text>
          </g>
        ))}
        {snapshot?.lidar.returns.map((p, i) => p.projector && <circle key={i} cx={p.projector.x} cy={p.projector.y} r={3} fill="#f4bb55" />)}
        {snapshot?.camera.fingers.map(
          (p) =>
            p.projector && (
              <g key={p.index}>
                <circle cx={p.projector.x} cy={p.projector.y} r={12} fill="#6cecff" />
                <text x={p.projector.x + 18} y={p.projector.y} fill="white" fontSize={20}>
                  {p.surfaceId ?? 'table'} · contact unknown
                </text>
              </g>
            ),
        )}
      </svg>
      <p>Cyan: camera index-tip projection onto the table plane. Amber: registered lidar returns, including background. Finger height and temporal alignment are unmeasured.</p>
      <details open>
        <summary>Raw lidar in its own coordinate frame</summary>
        <svg
          viewBox={`${-rawExtent} ${-rawExtent} ${rawExtent * 2} ${rawExtent * 2}`}
          aria-label="Raw lidar sensor coordinates"
          className="spatial-map spatial-map--raw"
        >
          <path d={`M ${-rawExtent} 0 H ${rawExtent} M 0 ${-rawExtent} V ${rawExtent}`} stroke="#444" strokeWidth={rawExtent / 250} />
          <circle cx={0} cy={0} r={rawExtent / 80} fill="#fff" />
          {snapshot?.lidar.returns.map((p, i) => (
            <circle key={i} cx={p.sensor.x} cy={p.sensor.y} r={rawExtent / 300} fill="#f4bb55" />
          ))}
        </svg>
        <p>Millimetres from the sensor; these points have not been identified as touches.</p>
      </details>
      <details>
        <summary>Measured table and lidar registration</summary>
        <p>
          Supply table mm → projector pixels and lidar Cartesian mm → table mm target pairs, with at least four fit targets and two separate check targets for each mapping. No
          calibration dots are projected here.
        </p>
        <textarea
          aria-label="Measured registration JSON"
          value={targets}
          onChange={(e) => setTargets(e.target.value)}
          rows={12}
          placeholder={'{"table":[{"from":{"x":0,"y":0},"to":{"x":0,"y":0}}],"tableCheck":[],"lidar":[],"lidarCheck":[],"maxProjectorErrorPx":10,"maxTableErrorMm":20}'}
        />
        <button disabled={saving} onClick={() => void register()}>
          Save measured registration
        </button>
        <p>If the table, sensor or projector moves, clear registration before measuring again.</p>
        <button disabled={!snapshot?.calibration.registration} onClick={() => void fetch('/api/spatial/registration', { method: 'DELETE' }).catch((e) => setError(String(e)))}>
          Clear table/lidar registration
        </button>
      </details>
    </main>
  )
}
