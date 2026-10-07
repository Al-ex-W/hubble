import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LessonControl } from '../lesson/LessonPanel.tsx'

/**
 * The one owner of "what state is the show in" on the operating surface (#75).
 *
 * Why its own module: Show mode and Setup mode's show column both read the
 * same status, and each used to need its own poll and its own shape check.
 * Two polls drift. One mode would show "math act" while the other showed
 * "lesson" for up to a second, and one would trust a body the other refused.
 * So the poll, the shape check, the action helper and the lesson control
 * live here, and the views only draw.
 *
 * The shape is what apps/server/operator.ts's GET /api/operator/status
 * returns: runtime.state() (act, mode, lesson, keys) plus the device
 * summaries.
 */
export interface Status {
  act: 'math' | 'lesson'
  mode: string
  lesson: { song: string; index: number; total: number; expected: number | null } | null
  /** Keys the runtime holds for the MiniLab, and where they came from. Optional: older servers. */
  keys?: number
  keySource?: 'camera' | 'camera-stale' | 'estimate' | null
  room: { kind: string; ok: boolean; error?: string; displays?: number; lights?: number }
  /** Whether Hubble may write to the room (the real room needs the operator to arm it). Optional: older servers. */
  output?: { room: string | null; requiresArm: boolean; active: boolean }
  camera: { calibrated: boolean; seen: number; source?: 'measured' | 'standard' | null; at?: string | null }
  midi: { lastAt: number | null; agoMs: number | null }
  brain: { configured: boolean; lastRender: { ok: boolean; ms: number; at: number } | null }
  /** The iPad worksheet (#60); null when the server runs without it. Optional: older servers don't send it. */
  worksheet?: {
    on: boolean
    url: string | null
    /** taskIds: every problem on the iPad, in its numbered order (#88). Optional: older servers send only taskId. */
    shown: { taskId: string; taskIds?: string[]; numbers?: number[]; textMm: number } | null
    /** How many problems one sheet takes (the worksheet state's MAX_PICKS). Optional: older servers. */
    maxPicks?: number
    ruler: boolean
    error?: string
    tasks: { id: string; task: string }[]
  } | null
}

export const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }))

export const ago = (ms: number | null) => (ms === null ? 'never' : ms < 60_000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60_000)} min ago`)

/**
 * A status body is trusted only once it has the fields every view reads.
 * Why: a throw while rendering the status would blank the whole surface, not
 * just one tile. An older server, a proxy error page parsed as JSON, or a
 * test stand-in answering `{}` must read as "server unreachable" instead.
 */
export const isStatus = (j: unknown): j is Status => {
  const o = j as Partial<Status> | null
  return Boolean(o && typeof o === 'object' && o.room && o.camera && o.midi && o.brain)
}

export function useOperatorStatus() {
  const [s, setS] = useState<Status | null>(null)
  const [down, setDown] = useState(false)
  const [note, setNote] = useState('')

  const refresh = useCallback(() => {
    fetch('/api/operator/status')
      .then((r) => r.json())
      .then((j: unknown) => {
        if (!isStatus(j)) throw new Error('not an operator status')
        setS(j)
        setDown(false)
      })
      .catch(() => setDown(true))
  }, [])
  // Once a second: fast enough that a dead room or a silent keyboard shows
  // before the operator needs it, cheap because the room call has a 1.5 s
  // deadline server-side and everything else is in memory.
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 1000)
    return () => clearInterval(t)
  }, [refresh])

  /** One button's request: says what happened in `note`, then re-reads the status so the view shows the server's answer, not the click. */
  const act = useCallback(
    (label: string, url: string, body?: unknown) =>
      post(url, body).then((r) => {
        setNote(r.ok ? `${label}: done` : `${label}: failed (${r.status}${r.body?.error ? `, ${r.body.error}` : ''})`)
        refresh()
        return r
      }),
    [refresh],
  )

  // The virtual MiniLab's owner (review #40): its song buttons go through the
  // operator's act switch, and it shows this status's lesson. Memoised on the
  // lesson only, so the panel's callbacks (and its MIDI subscription) are not
  // rebuilt on every 1 s poll.
  const lesson = s?.lesson ?? null
  const lessonControl = useMemo<LessonControl>(
    () => ({
      lesson,
      start: (song) => void act('keyboard act', '/api/operator/act', { act: 'lesson', song }),
      stop: () => void act('math act', '/api/operator/act', { act: 'math' }),
      played: refresh,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the lesson's fields, not the object identity a poll replaces
    [lesson?.song, lesson?.index, lesson?.total, lesson?.expected, act, refresh],
  )

  return { s, down, note, setNote, refresh, act, lessonControl }
}
