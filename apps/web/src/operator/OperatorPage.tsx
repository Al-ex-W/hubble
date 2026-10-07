import { ReferencePoints } from '../surface/ReferencePoints.tsx'
import { RegisterLidar } from '../surface/RegisterLidar.tsx'
import { useEffect, useState } from 'react'
import { LessonPanel } from '../lesson/LessonPanel.tsx'
import { ago, useOperatorStatus } from './status.ts'
import { roiParam } from '../../../shared/hands/roi.ts'
import './operator.css'
import { PianoPanel } from './PianoPanel.tsx'

/**
 * The show controls: the bench's right-hand column at `/` (#66), on the
 * laptop beside the stage. It was its own page, `/operator` (#34), until the
 * owner ruled that the bench and the operator page are one job and belong on
 * one screen: the operator needs the simulated table and the hand tracker
 * beside the act buttons, not a tab away. `/operator` now redirects to `/`.
 *
 * Built for someone who has seconds and is looking at the audience, not the
 * screen: few, large buttons; four status tiles that are green, amber or
 * red at a glance; and both fallbacks one click away. Every button is one
 * request to /api/operator/* (operator.ts), which asks the runtime or the hub
 * to do what they already do; this page holds no state of its own beyond
 * the last thing it was told.
 *
 * The virtual MiniLab is the bench's LessonPanel: its keys post the same
 * MIDI-shaped events as the real keyboard, so if USB MIDI dies the lesson
 * carries on from here. It is embedded *controlled*: it shows this page's
 * lesson state and its song buttons go through /api/operator/act, so there
 * is one lesson view and one way to start the act (review #40, findings 2-3).
 */

// Font sizes offered for the iPad's task, in real mm (the server allows 4-20).
const TEXT_SIZES = [6, 8, 10, 12, 14, 16]

type Level = 'ok' | 'warn' | 'bad'

/**
 * `embedded`: drawn as the bench's column (no full-page height, a narrow
 * single-column layout). Without it the component still lays out as a page,
 * which only its own tests use now.
 */
export function OperatorPage({ embedded = false }: { embedded?: boolean } = {}) {
  // The poll, the shape check and the lesson control are status.ts's (one
  // owner for this column and Show mode).
  const { s, down, note, act: request, lessonControl: control } = useOperatorStatus()
  const act = (label: string, url: string, body?: unknown) => () => void request(label, url, body)

  const tiles: { name: string; level: Level; text: string }[] = s
    ? [
        { name: 'room', level: s.room.ok ? 'ok' : 'bad', text: s.room.ok ? `${s.room.kind}: ${s.room.displays} displays, ${s.room.lights} lights` : `${s.room.kind}: ${s.room.error ?? 'down'}` },
        { name: 'camera', level: s.camera.calibrated ? 'ok' : 'warn', text: s.camera.calibrated ? `calibrated, ${s.camera.seen} objects seen` : 'not calibrated' },
        // MIDI has no "connected" signal server-side, only presses; silence is
        // amber, not red, because nobody plays during the math act.
        { name: 'midi', level: s.midi.lastAt === null ? 'warn' : 'ok', text: `last key ${ago(s.midi.agoMs)}` },
        {
          name: 'brain',
          level: !s.brain.configured ? 'bad' : s.brain.lastRender && !s.brain.lastRender.ok ? 'warn' : 'ok',
          text: !s.brain.configured
            ? 'no model key: use the recorded answers'
            : s.brain.lastRender
              ? `last answer ${s.brain.lastRender.ok ? 'ok' : 'FAILED'} in ${(s.brain.lastRender.ms / 1000).toFixed(1)} s`
              : 'ready, no answer yet',
        },
      ]
    : []

  const [calibrating, setCalibrating] = useState(false)
  const [calNote, setCalNote] = useState('')
  useEffect(() => {
    void fetch('/api/calibration').then((r) => r.json()).then((c: { calibrated: boolean; rms?: number; at?: string }) => setCalNote(c.calibrated ? `calibrated ${c.at?.slice(11, 19) ?? ''}, rms ${c.rms?.toFixed(1)} px` : 'not calibrated')).catch(() => undefined)
  }, [])
  // Lights one dot at a time on the table (~1-3 s each): our /table page must be on the projector.
  const calibrate = () => {
    setCalibrating(true)
    setCalNote('lighting dots one at a time…')
    void fetch('/api/calibrate', { method: 'POST' })
      .then((r) => r.json())
      .then((c: { ok: boolean; rms?: number; error?: string; dots: { seen: unknown }[] }) => setCalNote(c.ok ? `ok: rms ${c.rms!.toFixed(1)} px, ${c.dots.filter((d) => d.seen).length}/${c.dots.length} dots` : `failed: ${c.error}`))
      .catch((e) => setCalNote(`failed: ${String(e)}`))
      .finally(() => setCalibrating(false))
  }
  return (
    // `liquid-theme` repeats what main.tsx already puts on #root, so the page
    // stays styled on its own (owner's Liquid restyle). The fixed aurora layer
    // is only for the standalone page: inside the bench's show column it would
    // paint over its neighbouring columns.
    <div className={embedded ? 'liquid-theme op op-embedded' : 'liquid-theme op'}>
      {!embedded && <div className="op-aurora" aria-hidden="true" />}
      <header className="op-head">
        <strong>{embedded ? 'show' : 'hubble · operator'}</strong>
        <span className={`op-pill ${down ? 'bad' : 'ok'}`}>{down ? 'server unreachable' : s ? `${s.act} act · ${s.mode}` : '…'}</span>
        {s?.lesson && (
          <span className="op-pill ok">
            {s.lesson.song}: {s.lesson.index}/{s.lesson.total}
          </span>
        )}
        <span className="op-note">{note}</span>
      </header>

      <section className="op-tiles">
        {tiles.map((t) => (
          <div key={t.name} className={`op-tile ${t.level}`}>
            <span className="op-tile-name">{t.name}</span>
            <span>{t.text}</span>
          </div>
        ))}
      </section>

      <RoomCameraView />

      <section className="op-group">
        <h2>camera ↔ projector</h2>
        <button onClick={calibrate} disabled={calibrating}>{calibrating ? 'calibrating… (dots on the table)' : 'calibrate'}</button>
        <span className="op-note">{calNote}</span>
        {/* Markers instead of dots (#91): one frame per camera instead of 13,
            the iPad localized too, and the printed markers learned. The dot
            calibration above stays the fallback. */}
        <ReferencePoints />
      </section>
      <section className="op-group">
        <h2>lidar ↔ table</h2>
        <RegisterLidar />
      </section>
      <PianoPanel />

      <section className="op-group">
        <h2>acts</h2>
        <button className={s?.act === 'math' ? 'on' : ''} onClick={act('math act', '/api/operator/act', { act: 'math' })}>
          math
        </button>
        <button className={s?.act === 'lesson' ? 'on' : ''} onClick={act('keyboard act', '/api/operator/act', { act: 'lesson', song: 'ode-to-joy' })}>
          keyboard · Ode to Joy
        </button>
        <button onClick={act('keyboard act', '/api/operator/act', { act: 'lesson', song: 'twinkle' })}>keyboard · Twinkle</button>
      </section>

      {s?.output?.requiresArm && (
        // The real room is shared (organisers, other teams): nothing of ours
        // reaches its projector, TVs or lights until this is ticked, and
        // ticking it takes the projector from whoever has it. Owner's rule.
        <section className="op-group op-sheet">
          <h2>room output</h2>
          <label className="op-check">
            <input type="checkbox" checked={s.output.active} onChange={(e) => act(e.target.checked ? 'room output armed' : 'room output off', '/api/operator/room', { armed: e.target.checked })()} />
            write to the real room (projector, TVs, lights)
          </label>
          <span className={s.output.active ? 'op-err' : 'op-note'}>{s.output.active ? 'ARMED: Hubble has the projector and lights' : 'off: nothing is sent to the room'}</span>
        </section>
      )}

      {s?.worksheet && (
        // The iPad worksheet (#60): the owner asked for "just a checkbox" that
        // hosts it. Ticking it starts the worksheet server; the URL is what to
        // open on the iPad. Everything else here goes through the same one
        // route, and the page shows what the server says back, not what was
        // clicked, so a refused change can't look applied.
        <section className="op-group op-sheet">
          <h2>iPad worksheet</h2>
          <label className="op-check">
            <input type="checkbox" checked={s.worksheet.on} onChange={(e) => act(e.target.checked ? 'worksheet on' : 'worksheet off', '/api/operator/worksheet', { on: e.target.checked })()} />
            host the worksheet for the iPad
          </label>
          {s.worksheet.on && (
            <>
              <span className="op-url">{s.worksheet.url ? <a href={s.worksheet.url} target="_blank" rel="noreferrer">{s.worksheet.url}</a> : 'no LAN address: is the laptop on the room network?'}</span>
              <select aria-label="task" value={s.worksheet.shown?.taskId ?? ''} onChange={(e) => act('task', '/api/operator/worksheet', { taskId: e.target.value })()}>
                {s.worksheet.tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id}: {t.task}
                  </option>
                ))}
              </select>
              <select aria-label="text size" value={s.worksheet.shown?.textMm ?? 8} onChange={(e) => act('text size', '/api/operator/worksheet', { textMm: Number(e.target.value) })()}>
                {TEXT_SIZES.map((mm) => (
                  <option key={mm} value={mm}>
                    text {mm} mm
                  </option>
                ))}
              </select>
              <label className="op-check">
                <input type="checkbox" checked={s.worksheet.ruler} onChange={(e) => act('ruler', '/api/operator/worksheet', { ruler: e.target.checked })()} />
                project the 10 cm check ruler
              </label>
            </>
          )}
          {s.worksheet.error && <span className="op-err">{s.worksheet.error}</span>}
        </section>
      )}

      <ReadPagePanel />

      <section className="op-group">
        <h2>table</h2>
        <button onClick={act('close all', '/api/operator/close-all')}>close all surfaces</button>
        <button className="danger" onClick={act('reset', '/api/operator/reset')}>
          reset show
        </button>
      </section>

      <section className="op-group">
        <h2>fallback: recorded answer (no model)</h2>
        <button onClick={act('recorded linear', '/api/operator/fallback', { answer: 'linear' })}>linear equation</button>
        <button onClick={act('recorded graph', '/api/operator/fallback', { answer: 'graph' })}>quadratic + graph</button>
      </section>

      <section className="op-group op-midi">
        <h2>fallback: virtual MiniLab</h2>
        <LessonPanel control={control} />
      </section>
    </div>
  )
}

/**
 * What the room's overhead camera sees, so the operator can check the table
 * (is the keyboard projected, is a hand in view) without walking over.
 *
 * Polled stills from /api/camera/frame (our server's proxy to pi-projector),
 * at most once a second, not the MJPEG <img>: a stream holds one of the
 * browser's 6 per-host connections for as long as the page is open, and that
 * limit is what froze the bench (#56). A still costs a connection only while
 * it loads, and each load waits for the previous one, so a slow link lowers
 * the rate instead of piling requests up.
 *
 * Why the crop (#84): a full 1080p still is the most expensive thing this
 * column asks of the congested room Wi-Fi, and the hand tracker's own stream
 * is already cropped to the keyboard. The operator view asks
 * GET /api/camera/roi for the same rectangle and passes it, so the still
 * costs a fraction of the frame. The hands mirror is full-frame px, though, so
 * the overlay is drawn in CROP space: subtract the crop origin and size the
 * viewBox to the crop, or the joints sit in the wrong corner.
 */
// MediaPipe's 21-point hand: wrist to each fingertip, plus the palm's knuckle line.
const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
]
interface HandsMirror {
  ageMs: number | null
  source?: 'room' | 'local'
  width?: number
  height?: number
  pinch?: boolean
  hands?: { lm: [number, number][] }[]
}
/** The snapped crop the still is streamed with, in full-frame px (GET /api/camera/roi). */
type Rect = { x: number; y: number; w: number; h: number }
// Older than this, the tracker has stopped (or its tab is gone): draw nothing.
const HANDS_STALE_MS = 1000
/** One poll a second: enough to watch the table, cheap on the room link (#84). */
const POLL_MS = 1000

function RoomCameraView() {
  const [src, setSrc] = useState<string | null>(null)
  const [hands, setHands] = useState<HandsMirror>({ ageMs: null })
  const [crop, setCrop] = useState<Rect | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    let url: string | null = null
    const next = async () => {
      while (alive) {
        const t0 = performance.now()
        try {
          // The keyboard crop for this poll (#84): null without a keyboard or
          // a calibration, in which case the still is the full frame.
          const view = await fetch('/api/camera/roi', { signal: AbortSignal.timeout(2000) })
            .then((r) => r.json() as Promise<{ roi?: { x: number; y: number; w: number; h: number } | null; crop?: Rect | null }>)
            .catch(() => ({ roi: null as null, crop: null as Rect | null }))
          const q = view.roi ? `roi=${roiParam(view.roi)}&` : ''
          const r = await fetch(`/api/camera/frame?${q}t=${Date.now()}`, { signal: AbortSignal.timeout(4000) })
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
          const blob = await r.blob()
          // The tracker's own landmarks (handsMirror.ts), fetched with each
          // still so the joints and the picture are at most one poll apart.
          const h = await fetch('/api/input/hands').then((x) => x.json() as Promise<HandsMirror>).catch(() => ({ ageMs: null }))
          if (alive) setHands(h)
          if (alive) setCrop(view.crop ?? null)
          if (!alive) return
          const fresh = URL.createObjectURL(blob)
          setSrc(fresh)
          if (url) URL.revokeObjectURL(url)
          url = fresh
          setError(null)
        } catch (e) {
          if (alive) setError(e instanceof Error ? e.message : String(e))
        }
        await new Promise((res) => setTimeout(res, Math.max(0, POLL_MS - (performance.now() - t0))))
      }
    }
    void next()
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [])
  const live = hands.ageMs !== null && hands.ageMs < HANDS_STALE_MS && hands.source === 'room'
  // The mirror is full-frame; the still may be a crop. One origin, applied
  // once, so a joint can never be drawn at its full-frame spot over a crop.
  const ox = crop?.x ?? 0
  const oy = crop?.y ?? 0
  const viewW = crop?.w ?? hands.width ?? 1920
  const viewH = crop?.h ?? hands.height ?? 1080
  const handsNote =
    hands.ageMs === null || hands.ageMs >= HANDS_STALE_MS
      ? 'hand tracker: off (start it on the bench with "room camera", then calibrate)'
      : hands.source !== 'room'
        ? 'hand tracker: running on a laptop camera, so its joints are not drawn over the room camera'
        : `hand tracker: ${hands.hands!.length} hand(s)${hands.pinch ? ', pinched' : ''}`
  return (
    <section className="op-group op-camera">
      <h2>room camera</h2>
      {src ? (
        <div style={{ position: 'relative', width: '100%', maxWidth: 960 }}>
          <img src={src} alt="the table from the overhead camera" style={{ width: '100%', borderRadius: 6, display: 'block' }} />
          {live && hands.width && hands.height ? (
            <svg viewBox={`0 0 ${viewW} ${viewH}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} aria-label="hand joints the tracker sees">
              {hands.hands!.map((h, i) => (
                <g key={i}>
                  {BONES.map(([a, b]) => (
                    <line key={`${a}-${b}`} x1={h.lm[a]![0] - ox} y1={h.lm[a]![1] - oy} x2={h.lm[b]![0] - ox} y2={h.lm[b]![1] - oy} stroke="#6cf0ff" strokeWidth={4} strokeLinecap="round" opacity={0.85} />
                  ))}
                  {h.lm.map(([x, y], j) => (
                    <circle key={j} cx={x - ox} cy={y - oy} r={j === 4 || j === 8 ? 9 : 6} fill={j === 4 || j === 8 ? (hands.pinch ? '#36ff7a' : '#ff8a3d') : '#e8fbff'} />
                  ))}
                </g>
              ))}
            </svg>
          ) : null}
        </div>
      ) : null}
      <span className="op-note">{handsNote}</span>
      {error ? <span className="op-note">camera: {error}</span> : !src ? <span className="op-note">waiting for the first frame…</span> : null}
    </section>
  )
}

interface TaskReadView {
  tasks: { n: number; text: string }[]
  source: 'camera' | 'worksheet' | 'none'
  agreed: boolean
  raw: Record<string, string>
  ms: number
  error?: string
}

/**
 * "Read page" (#86): one camera still → the page crop → both vision models.
 * Shows exactly what was read and where it came from, because the owner's
 * rule is "no faked tasks": the operator must see whether the brain will be
 * told the camera's text (both models agreed) or the iPad's manifest text
 * (the fallback), before asking "solve problem 2". The crop is shown too, so
 * "the box is in the wrong spot" is visible at a glance, not guessed from an
 * UNREADABLE. Setup only: it costs a camera still and two model calls.
 */
function ReadPagePanel() {
  const [read, setRead] = useState<TaskReadView | null>(null)
  const [busy, setBusy] = useState(false)
  const [at, setAt] = useState(0)
  const go = async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/read-task', { method: 'POST' })
      setRead((await r.json()) as TaskReadView)
      setAt(Date.now())
    } catch {
      setRead({ tasks: [], source: 'none', agreed: false, raw: {}, ms: 0, error: 'server unreachable' })
    } finally {
      setBusy(false)
    }
  }
  const from = read?.source === 'camera' ? 'camera (both models agree)' : read?.source === 'worksheet' ? 'iPad worksheet text (fallback)' : 'nothing'
  return (
    <section className="op-group op-sheet">
      <h2>read the page (camera)</h2>
      <button onClick={go} disabled={busy}>
        {busy ? 'reading…' : 'Read page'}
      </button>
      {read && (
        <>
          <span className="op-note">
            source: {from} · {(read.ms / 1000).toFixed(1)} s
          </span>
          {read.tasks.map((t) => (
            <span key={t.n} className="op-url">
              {t.n}: {t.text}
            </span>
          ))}
          {read.error && <span className="op-err">{read.error}</span>}
          {Object.entries(read.raw).map(([m, text]) => (
            <span key={m} className="op-note">
              {m}: {text || '(no answer)'}
            </span>
          ))}
          {at > 0 && <img src={`/api/read-task/crop.jpg?t=${at}`} alt="the crop the models read" style={{ maxWidth: 160, alignSelf: 'flex-start' }} onError={(e) => (e.currentTarget.style.display = 'none')} />}
        </>
      )}
    </section>
  )
}
