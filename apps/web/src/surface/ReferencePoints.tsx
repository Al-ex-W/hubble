import { useEffect, useState } from 'react'
import { post } from '../operator/status.ts'

/**
 * The "reference points" button (#91), for Show (compact, beside the room
 * arm) and Setup (beside "calibrate", with the details). One component, so
 * both modes send the same request and read the same status.
 *
 * Pressing it projects the marker grid on the table for ~12 s (the server
 * refuses unarmed on the real room: a projector write needs the owner's
 * go). Every camera that sees it localizes, and the printed markers'
 * positions are learned. The line under it is the spatial service's
 * localization state, never this page's guess.
 */

interface Localization {
  projecting: boolean
  anchors: { markers: Record<string, unknown>; learnedAt: string } | null
  calibrated: string[]
  sources: Record<string, { last: { ok: boolean; rms: number | null; markers: number[]; error: string | null } | null; installs: number }>
}

export function localizationLine(l: Localization | null): string {
  if (!l) return 'localization: …'
  const parts = Object.entries(l.sources).map(([src, s]) =>
    !s.last ? `${src}: no markers yet` : s.last.ok ? `${src}: rms ${s.last.rms?.toFixed(1)} px, ${s.last.markers.length} markers${s.installs ? '' : ' (confirming)'}` : `${src}: ${s.last.error}`,
  )
  const anchors = l.anchors ? Object.keys(l.anchors.markers).length : 0
  return [l.projecting ? 'markers ON the table' : null, ...parts, `${anchors}/4 printed markers learned`, `maps: ${l.calibrated.join(', ') || 'none'}`].filter(Boolean).join(' · ')
}

export function ReferencePoints({ compact = false }: { compact?: boolean }) {
  const [l, setL] = useState<Localization | null>(null)
  const [note, setNote] = useState('')
  useEffect(() => {
    let alive = true
    const read = () =>
      fetch('/api/spatial/localization')
        .then((r) => r.json())
        .then((j: Localization) => alive && j && typeof j === 'object' && 'sources' in j && setL(j))
        .catch(() => undefined)
    void read()
    // Every 2 s: a run lasts 12 s, and the line should show it confirming.
    const t = setInterval(read, 2000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])
  const press = (on: boolean) =>
    void post('/api/spatial/reference', { on }).then((r) => setNote(r.ok ? (on ? 'markers on the table for ~12 s' : 'cleared') : `refused: ${(r.body as { error?: string }).error ?? r.status}`))
  return (
    <span className="reference-points">
      <button onClick={() => press(!l?.projecting)} title="Project reference markers on the table for ~12 s; every camera that sees them localizes">
        {l?.projecting ? 'clear reference points' : 'reference points'}
      </button>
      {!compact && (
        <a href="/api/spatial/markers/print" target="_blank" rel="noreferrer">
          print the table markers
        </a>
      )}
      <small>{note || localizationLine(l)}</small>
    </span>
  )
}
