import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useRoomHands } from './RoomHands.tsx'
import { fromPrintout, keyboardCorners, type H } from './calibration.ts'
import { createHandPipeline } from './pipeline.ts'
import { createGesturePoster } from './gesturePoster.ts'
import { createLandmarker, type Landmarker } from './landmarker.ts'
import { createFrameGate } from './frameGate.ts'
import type { GestureEvent } from './gestures.ts'
import type { Hand, Pt } from './types.ts'
import { ownsPress, useSurfaces } from '../table/surfaces.ts'

/**
 * The bench's hand tracker: a webcam (or an iPhone through Continuity Camera)
 * looking down at the printed keyboard, the four-corner calibration, and the
 * live loop camera → MediaPipe → pipeline. The panel only wires: presses go
 * to the swipe keyboard (`onPress`, the same reducer the mouse feeds) and
 * every gesture goes to the server's input stream, where the runtime owns
 * what it does (#32). The rules live in pipeline.ts / gestures.ts.
 *
 * The room source is NOT run here any more (#75): it is the page's one
 * shared tracker (RoomHands.tsx), mounted above Show and Setup so pinch
 * typing survives the mode switch. This panel only shows it: its controls and
 * a debug overlay drawn from the shared tracker's frames. A second tracker
 * here would open a second room stream and fight over the input grant.
 */

/** The printouts the hands lab used: scale relative to the 44 mm table keyboard (speeds scale with it). */
const SHEETS = [
  { name: 'table-look (22 mm keys)', scale: 0.5 },
  { name: 'one sheet (24 mm keys)', scale: 0.55 },
  { name: 'true scale (44 mm keys)', scale: 1 },
]

interface Props {
  initialSource?: string
  /** A finished press on the keyboard, keyboard mm. */
  onPress: (points: Pt[]) => void
  /** The press in progress, keyboard mm (the live trail). */
  onTrail: (points: Pt[]) => void
  /** Keyboard mm → table px: where the bench projects the keyboard, for the gestures sent to the server. */
  kbToTable: H
}

// One poster for the page: gestures leave in the order the hand made them.
const gestures = createGesturePoster()
const postGesture = (e: GestureEvent) => void gestures.post(e)

/** The select value for the room's overhead camera (not a local device id). */
const ROOM_CAMERA = 'room'

export function HandPanel(props: Props) {
  const [deviceId, setDeviceId] = useState(props.initialSource ?? '')
  // Two components, not one with branches: the room view holds no camera at
  // all, so hooks for the local webcam must not run (and start) for it.
  return deviceId === ROOM_CAMERA ? <RoomHandsView onSource={setDeviceId} /> : <LocalHands {...props} deviceId={deviceId} onSource={setDeviceId} />
}

function SourcePicker({ value, onChange, disabled, devices }: { value: string; onChange: (id: string) => void; disabled: boolean; devices: MediaDeviceInfo[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">default camera</option>
      <option value={ROOM_CAMERA}>room camera (projector Pi)</option>
      {devices.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || d.deviceId.slice(0, 8)}
        </option>
      ))}
    </select>
  )
}

/** Setup's view of the shared room tracker: its controls, and the overlay drawn from its frames. */
function RoomHandsView({ onSource }: { onSource: (id: string) => void }) {
  const hands = useRoomHands()
  const { state } = hands
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const on = state.phase !== 'off'
  useEffect(
    () =>
      hands.onFrame((hs, v) => {
        const c = canvasRef.current
        if (!c) return
        if (c.width !== v.videoWidth) c.width = v.videoWidth
        if (c.height !== v.videoHeight) c.height = v.videoHeight
        // The picture too: the video element is the provider's (1 px, hidden).
        c.getContext('2d')?.drawImage(v, 0, 0)
        draw(c, v, hs, [], false, false)
      }),
    [hands.onFrame],
  )
  return (
    <div className="lesson-panel">
      <div className="lesson-row">
        <strong>hand tracker</strong>
        {/* Switching away from the room while it runs would hide a live tracker: stop first. */}
        <SourcePicker value={ROOM_CAMERA} onChange={onSource} disabled={on} devices={[]} />
        {on ? <button onClick={hands.stop}>stop</button> : <button onClick={hands.start}>start camera</button>}
        <button disabled={state.phase !== 'running' || state.selectingInput} onClick={() => void hands.setPinch(!state.pinch)}>
          {state.pinch ? 'disable pinch typing' : 'enable pinch typing'}
        </button>
        <span className="lesson-status">{state.inputStatus}</span>
        <span className="lesson-status">{state.text}</span>
      </div>
      <div style={{ position: 'relative', maxWidth: 640, display: state.phase === 'running' ? 'block' : 'none' }}>
        <canvas ref={canvasRef} style={{ width: '100%', display: 'block' }} />
      </div>
    </div>
  )
}

function LocalHands({ onPress, onTrail, kbToTable, deviceId, onSource }: Props & { deviceId: string; onSource: (id: string) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [sheet, setSheet] = useState(0)
  const [taps, setTaps] = useState<Pt[]>([])
  const [running, setRunning] = useState(false)
  // While a start is in flight there is no second start: the button becomes
  // "stop" so the user can cancel, and a double click can't race two
  // camera/tracker loads against each other.
  const [starting, setStarting] = useState(false)
  const [status, setStatus] = useState('off')
  const lmRef = useRef<Landmarker | null>(null)
  const corners = keyboardCorners()
  const calibrated = taps.length === 4
  // Latest callbacks for the frame loop, which must not restart on every render.
  // The surface set, for presses that start on a surface over the keyboard
  // (the launcher owns those, not the keyboard).
  const surfaces = useSurfaces()
  const cb = useRef({ onPress, onTrail, kbToTable, surfaces })
  cb.current = { onPress, onTrail, kbToTable, surfaces }

  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => setDevices(all.filter((d) => d.kind === 'videoinput')))
      .catch(() => undefined)
  }, [running])

  // The camera stream and the tracker are owned here, not through the video
  // element: React clears videoRef before an unmount cleanup runs, so a stop
  // that read the stream from the element released nothing (review #42), and
  // a start that failed half-way (camera granted, tracker failed) left the
  // camera on behind a "start camera" button.
  const streamRef = useRef<MediaStream | null>(null)
  // Bumped by every start and stop: a start that resolves after a stop (or
  // an unmount) must not attach a stream or a tracker nobody will release.
  const runToken = useRef(0)

  const release = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    const v = videoRef.current
    if (v) v.srcObject = null
  }

  const start = async () => {
    const token = ++runToken.current
    release()
    setStarting(true)
    try {
      setStatus('starting camera…')
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: deviceId || undefined, width: { ideal: 1920 }, height: { ideal: 1080 } } })
      if (token !== runToken.current) return void stream.getTracks().forEach((t) => t.stop())
      streamRef.current = stream
      const v = videoRef.current!
      v.srcObject = stream
      await v.play()
      setStatus('loading hand tracker…')
      const lm = lmRef.current ?? (await createLandmarker())
      if (token !== runToken.current) {
        // Superseded while the tracker loaded (stopped, unmounted, or started
        // again): close it unless it is the very instance already held. The
        // first version only closed it when nothing was held, so an
        // abandoned instance leaked whenever a newer start had already
        // stored its own (review #42, round 2).
        if (lm !== lmRef.current) lm.close()
        return
      }
      lmRef.current = lm
      setRunning(true)
    } catch (e) {
      if (token !== runToken.current) return
      release()
      setRunning(false)
      setStatus(`camera or tracker failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (token === runToken.current) setStarting(false)
    }
  }
  const stop = () => {
    runToken.current++
    release()
    setRunning(false)
    setStarting(false)
    setStatus('off')
  }
  useEffect(
    () => () => {
      runToken.current++
      release()
      lmRef.current?.close()
      lmRef.current = null
    },
    [],
  )

  /** A click on the video during calibration: the next key corner, in image px. */
  const tap = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (calibrated || !videoRef.current) return
    const r = e.currentTarget.getBoundingClientRect()
    const v = videoRef.current
    setTaps((t) => [...t, { x: ((e.clientX - r.left) / r.width) * v.videoWidth, y: ((e.clientY - r.top) / r.height) * v.videoHeight }])
  }

  // The live loop: one landmark frame per animation frame, through a fresh
  // pipeline whenever the calibration or the sheet changes.
  useEffect(() => {
    if (!running || !calibrated || !lmRef.current) return
    const pipeline = createHandPipeline({ camToKb: fromPrintout(taps), scale: SHEETS[sheet]!.scale, kbToTable: () => cb.current.kbToTable, covered: (p) => ownsPress(cb.current.surfaces, p) })
    let mirrorBusy = false
    const v = videoRef.current!
    let raf = 0
    let frames = 0
    let lastMirror = 0
    let since = performance.now()
    const fresh = createFrameGate()
    const loop = () => {
      raf = requestAnimationFrame(loop)
      // Once per camera frame, not per display frame: a 60 Hz display shows
      // each frame of a 30 fps camera twice, and pushing it twice let one
      // noisy sample satisfy the two-frame pinch confirmation (review #42).
      if (v.readyState < 2 || !fresh(v.currentTime)) return
      const t = performance.now()
      const frame = lmRef.current!.detect(v, t)
      const step = pipeline.push(frame)
      for (const press of step.presses) cb.current.onPress(press)
      cb.current.onTrail(step.trail)
      for (const e of step.table) postGesture(e)
      draw(canvasRef.current, v, frame.hands, taps, step.pinchClosed)
      // Mirror for the operator's camera view (handsMirror.ts), ~10 a second:
      // enough to watch a hand, cheap next to the gesture posts.
      if (!mirrorBusy && t - lastMirror > 100) {
        lastMirror = t
        mirrorBusy = true
        void fetch('/api/input/hands', {
          method: 'POST',
          signal: AbortSignal.timeout(2500),
          headers: { 'Content-Type': 'application/json' },
          // The room's mirror goes through roomView.ts too: the operator's
          // camera view draws it over the FULL frame (#84).
          body: JSON.stringify({ source: 'local', width: v.videoWidth, height: v.videoHeight, pinch: step.pinchClosed, hands: frame.hands.map((h) => ({ lm: h.lm })) }),
        }).catch(() => undefined).finally(() => { mirrorBusy = false })
      }
      frames++
      if (t - since > 1000) {
        setStatus(`${lmRef.current!.source} assets · ${Math.round((frames * 1000) / (t - since))} fps · ${frame.hands.length} hand(s) · pinch ${step.f.pinch?.toFixed(2) ?? '–'}${step.pinchClosed ? ' (down)' : ''}`)
        frames = 0
        since = t
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [running, calibrated, taps, sheet, deviceId])

  return (
    <div className="lesson-panel">
      <div className="lesson-row">
        <strong>hand tracker</strong>
        {/* Source identity freezes while running or starting: a delayed grant
            must not be labelled as the newly selected camera. */}
        <SourcePicker value={deviceId} onChange={onSource} disabled={running || starting} devices={devices} />
        <select value={sheet} onChange={(e) => setSheet(Number(e.target.value))}>
          {SHEETS.map((s, i) => (
            <option key={s.name} value={i}>
              {s.name}
            </option>
          ))}
        </select>
        {running || starting ? <button onClick={stop}>stop</button> : <button onClick={() => void start()}>start camera</button>}
        <button onClick={() => setTaps([])} disabled={!running}>
          recalibrate
        </button>
        <span className="lesson-status">{running && !calibrated ? `click: ${corners[taps.length]!.name}` : status}</span>
      </div>
      <div style={{ position: 'relative', maxWidth: 640, display: running ? 'block' : 'none' }}>
        <video ref={videoRef} muted playsInline style={{ width: '100%', display: 'block' }} />
        <canvas ref={canvasRef} onClick={tap} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: calibrated ? 'default' : 'crosshair' }} />
      </div>
    </div>
  )
}

/** Landmarks and calibration points over the video, in image px. */
function draw(canvas: HTMLCanvasElement | null, v: HTMLVideoElement, hands: Hand[], taps: Pt[], closed: boolean, clear = true) {
  if (!canvas) return
  if (canvas.width !== v.videoWidth) canvas.width = v.videoWidth
  if (canvas.height !== v.videoHeight) canvas.height = v.videoHeight
  const g = canvas.getContext('2d')
  if (!g) return
  // The room view paints the camera picture first, so it must not be cleared.
  if (clear) g.clearRect(0, 0, canvas.width, canvas.height)
  g.fillStyle = '#ffd34d'
  for (const p of taps) g.fillRect(p.x - 6, p.y - 6, 12, 12)
  for (const h of hands) {
    g.fillStyle = 'rgba(108, 240, 255, 0.9)'
    for (const [x, y] of h.lm) g.fillRect(x - 3, y - 3, 6, 6)
    const [tx, ty] = h.lm[4]!
    const [ix, iy] = h.lm[8]!
    g.fillStyle = closed ? '#36ff7a' : '#ff8a3d'
    g.beginPath()
    g.arc((tx + ix) / 2, (ty + iy) / 2, 10, 0, Math.PI * 2)
    g.fill()
  }
}
