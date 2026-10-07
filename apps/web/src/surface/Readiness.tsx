import { useEffect, useState } from 'react'
import { isStatus, post, type Status } from '../operator/status.ts'

/**
 * The readiness strip for Show mode (demo boot, 7 Oct): projector · camera ·
 * lidar · model · iPad. Green when ready, else ONE short reason. Nothing to
 * click unless something is red (owner: zero setup on demo day).
 *
 * Why its own component that fetches for itself: Show mode is becoming a step
 * runner on another branch (feat/show-steps owns ShowView.tsx), which mounts
 * this at the top. Taking no props means that mount is one line and the two
 * branches can't conflict.
 *
 * Why it only reads: every decision here is the server's (the operator
 * status, the spatial frame's own `reason`); this view never re-derives
 * whether touch works, it shows what the spatial service says.
 */
type Spatial = {
  touchEnabled?: boolean
  reason?: string
  lidar?: { health?: { state?: string } | null; baseline?: { state?: string } }
}
type Chip = { name: string; ok: boolean; reason: string; fix?: { label: string; run: () => void } }

function chips(s: Status | null, sp: Spatial | null, refresh: () => void): Chip[] {
  if (!s) return [{ name: 'server', ok: false, reason: 'not answering' }]
  const arm = () => void post('/api/operator/room', { armed: true }).then(refresh)
  const baseline = () => void post('/api/spatial/baseline', {}).then(refresh)
  const live = s.room.kind !== 'none'
  const projector: Chip = !live
    ? { name: 'projector', ok: false, reason: 'offline (outside the hardware window)' }
    : !s.room.ok
      ? { name: 'projector', ok: false, reason: s.room.error ?? 'room not answering' }
      : s.output?.requiresArm && !s.output.active
        ? { name: 'projector', ok: false, reason: 'output not armed', fix: { label: 'arm', run: arm } }
        : { name: 'projector', ok: true, reason: 'ready' }
  const camera: Chip = s.camera.calibrated
    ? { name: 'camera', ok: true, reason: s.camera.source === 'standard' ? 'standard map' : 'ready' }
    : { name: 'camera', ok: false, reason: 'no camera map' }
  const lidarState = sp?.lidar?.health?.state
  const lidar: Chip = !sp
    ? { name: 'lidar', ok: false, reason: 'no spatial service' }
    : sp.touchEnabled
      ? { name: 'lidar', ok: true, reason: 'ready' }
      : sp.lidar?.baseline?.state === 'capturing'
        ? { name: 'lidar', ok: false, reason: 'learning the empty table…' }
        : {
            name: 'lidar', ok: false,
            reason: sp.reason ?? `lidar ${lidarState ?? 'unavailable'}`,
            // Only the baseline is fixable by a click; the automatic take
            // normally gets there first (autoBaseline.ts).
            ...(lidarState === 'receiving' && sp.lidar?.baseline?.state === 'none' && { fix: { label: 'take baseline', run: baseline } }),
          }
  const model: Chip = !s.brain.configured
    ? { name: 'model', ok: false, reason: 'no API key' }
    : s.brain.lastRender && !s.brain.lastRender.ok
      ? { name: 'model', ok: false, reason: 'last answer failed' }
      : { name: 'model', ok: true, reason: 'ready' }
  const w = s.worksheet
  const ipad: Chip = !w
    ? { name: 'iPad', ok: false, reason: 'worksheet not available' }
    : w.error
      ? { name: 'iPad', ok: false, reason: w.error }
      : w.on && w.url
        ? { name: 'iPad', ok: true, reason: 'ready' }
        : { name: 'iPad', ok: false, reason: 'worksheet off', fix: { label: 'start', run: () => void post('/api/operator/worksheet', { on: true }).then(refresh) } }
  return [projector, camera, lidar, model, ipad]
}

export function Readiness() {
  const [s, setS] = useState<Status | null>(null)
  const [sp, setSp] = useState<Spatial | null>(null)
  const refresh = () => {
    fetch('/api/operator/status').then((r) => r.json()).then((j: unknown) => setS(isStatus(j) ? j : null)).catch(() => setS(null))
    fetch('/api/spatial').then((r) => r.json()).then((j: Spatial) => setSp(j)).catch(() => setSp(null))
  }
  // Every 2 s: the strip is a glance, and /api/spatial carries every lidar
  // return, so polling it faster would be waste.
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="readiness" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '6px 0', fontSize: 13 }}>
      {chips(s, sp, refresh).map((c) => (
        <span key={c.name} title={c.reason} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, background: c.ok ? 'rgba(40,160,80,0.15)' : 'rgba(210,60,50,0.15)', color: c.ok ? '#2a9d55' : '#d0453a' }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, background: 'currentColor' }} />
          <strong>{c.name}</strong>
          {!c.ok && <span>{c.reason}</span>}
          {!c.ok && c.fix && <button onClick={c.fix.run} style={{ marginLeft: 4 }}>{c.fix.label}</button>}
        </span>
      ))}
    </div>
  )
}
