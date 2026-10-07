import { useEffect, useState } from 'react'
import { post } from '../operator/status.ts'

/**
 * Setup's lidar buttons (#lidar-wizard): the empty-table baseline, then
 * "Register lidar", which runs the server's wizard (numbered white targets on
 * the table, a finger held on each). The line under them is the server's run
 * state, polled while a run is on; this page never decides anything.
 * The terminal twin is `npm run lidar:live`.
 */
interface RunState {
  on: boolean
  phase: 'idle' | 'target' | 'fitting' | 'done' | 'failed'
  index: number
  total: number
  error: string | null
  result: { rmsTableMm: number } | null
}

export function runLine(s: RunState | null): string {
  if (!s) return ''
  if (s.phase === 'target') return `target ${s.index}/${s.total}: hold a finger on the white dot`
  if (s.phase === 'fitting') return 'fitting…'
  if (s.phase === 'done') return `registered (held-out error ${s.result?.rmsTableMm.toFixed(1)} mm): touch the table for a ripple`
  if (s.phase === 'failed') return `failed: ${s.error}`
  return ''
}

export function RegisterLidar() {
  const [s, setS] = useState<RunState | null>(null)
  const [note, setNote] = useState('')
  const [polling, setPolling] = useState(false)
  useEffect(() => {
    if (!polling) return
    const t = setInterval(() => void fetch('/api/spatial/registration/wizard').then((r) => r.json()).then(setS).catch(() => undefined), 400)
    return () => clearInterval(t)
  }, [polling])
  const baseline = () => {
    setNote('baseline: keep the table clear for 3 s…')
    void post('/api/spatial/baseline').then((r) => {
      const b = r.body as { rotations?: number; reason?: string; error?: string }
      setNote(r.ok ? `baseline from ${b.rotations} rotations` : `baseline: ${b.reason ?? b.error ?? r.status}`)
    })
  }
  const register = () => {
    setNote('')
    setPolling(true)
    void post('/api/spatial/registration/wizard').then((r) => {
      setPolling(false)
      setS(r.body as RunState)
    })
  }
  return (
    <span className="register-lidar">
      <button onClick={baseline} title="Learn the empty table (3 s, hands clear). Needed before registering.">lidar baseline</button>
      <button onClick={register} disabled={polling} title="Six numbered white dots on the table, one at a time: hold a finger on each for ~1 s">
        {polling ? 'registering…' : 'Register lidar'}
      </button>
      <small>{runLine(s) || note}</small>
    </span>
  )
}
