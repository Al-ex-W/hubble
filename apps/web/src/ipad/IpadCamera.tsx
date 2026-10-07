import { useEffect, useRef, useState } from 'react'
import { createLandmarker, type Landmarker } from '../hands/landmarker.ts'
import { createObservationClient } from '../hands/observationClient.ts'
import { createKeyboardInputClient } from '../hands/keyboardInputClient.ts'
import { createFrameGate } from '../hands/frameGate.ts'
import { createMarkerDetector } from '../../../shared/markers/detect.ts'
import type { Marker } from '../../../shared/markers/layout.ts'
import type { Hand } from '../hands/types.ts'
import { cameraBlocker, createMarkerSender, observationFromHands, startCamera, type LocalizationReply } from './ipadCamera.ts'

/**
 * /ipad-camera (#91): the iPad on a stand, looking at the table, as a
 * second camera. Opened at https://<laptop>:5173/ipad-camera (tls.ts says
 * why https, and how the one port speaks both).
 *
 * Everything heavy runs here, on the iPad: MediaPipe's hand landmarker on
 * every camera frame, and the marker detector twice a second. Only
 * landmarks and marker corners go to the server, which owns what they mean
 * (the spatial service: which camera map, which source is read, whether a
 * pinch types). This page never decides a key or a camera map.
 *
 * The page is deliberately plain and big: it is set up by someone holding
 * an iPad over a table, not read at a desk.
 */

// Ask Safari for 720p at up to 60 fps on the rear camera. 720p keeps
// MediaPipe and the detector fast on the iPad; the markers are big enough
// (a 4×4 cell at ~8 px) at the stand's distance. `ideal`, never `exact`:
// an exact constraint Safari can't meet fails getUserMedia outright.
const CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
}

export function IpadCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [status, setStatus] = useState('tap start')
  const [running, setRunning] = useState(false)
  const [loc, setLoc] = useState<LocalizationReply | null>(null)
  const [typing, setTyping] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(createKeyboardInputClient())
  const blocker = cameraBlocker(window.location, window.isSecureContext, Boolean(navigator.mediaDevices?.getUserMedia))

  useEffect(() => {
    if (!running) return
    const observations = createObservationClient()
    const markers = createMarkerSender()
    const detector = createMarkerDetector()
    const grab = document.createElement('canvas')
    const session = crypto.randomUUID()
    let seq = 0
    const fresh = createFrameGate()
    // startCamera (ipadCamera.ts) owns the start/stop ordering: late
    // resources are disposed, and stopping always releases pinch mode.
    const stop = startCamera({
      wake: async () => (await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen')) ?? null,
      stream: () => navigator.mediaDevices.getUserMedia(CONSTRAINTS),
      play: async (stream) => {
        const v = videoRef.current!
        v.srcObject = stream
        await v.play()
      },
      landmarker: (): Promise<Landmarker> => createLandmarker(),
      status: setStatus,
      error: (e) => {
        setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
        setRunning(false)
      },
      released: () => {
        inputRef.current.disable()
        setTyping(false)
      },
      run: (lm) => {
        const v = videoRef.current!
        let raf = 0
        let frames = 0
        let since = performance.now()
        let seen: Marker[] = []
        let hands: Hand[] = []
        const loop = () => {
          raf = requestAnimationFrame(loop)
          // Once per camera frame, not per display frame (frameGate.ts: a
          // repeated frame would vote twice in the pinch confirmation).
          if (v.readyState < 2 || !fresh(v.currentTime)) return
          const t = performance.now()
          const w = v.videoWidth
          const h = v.videoHeight
          hands = lm.detect(v, t).hands
          observations.post(observationFromHands(hands, w, h, { session, seq: ++seq, capturedAt: t, input: inputRef.current.current() }))
          if (markers.due()) {
            grab.width = w
            grab.height = h
            const ctx = grab.getContext('2d', { willReadFrequently: true })!
            ctx.drawImage(v, 0, 0, w, h)
            seen = detector.detect(ctx.getImageData(0, 0, w, h))
            void markers.send(seen, w, h).then((r) => r && setLoc(r))
          }
          draw(canvasRef.current, w, h, hands, seen)
          frames++
          if (t - since > 1000) {
            setStatus(`${lm.source} assets · ${w}×${h} · ${Math.round((frames * 1000) / (t - since))} fps · ${hands.length} hand(s) · ${seen.length} marker(s)`)
            frames = 0
            since = t
          }
        }
        raf = requestAnimationFrame(loop)
        return () => cancelAnimationFrame(raf)
      },
    })
    return () => {
      stop()
      observations.stop()
    }
  }, [running])

  const toggleTyping = async () => {
    setError('')
    if (typing) {
      inputRef.current.disable()
      setTyping(false)
      return
    }
    try {
      if (await inputRef.current.enable()) setTyping(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const last = loc?.last
  return (
    <main style={{ background: '#000', color: '#eee', minHeight: '100vh', font: '18px system-ui', padding: 12 }}>
      <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>Hubble · iPad camera</h1>
      {blocker ? (
        <p style={{ color: '#ffb347' }}>{blocker}</p>
      ) : (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <button style={big} onClick={() => setRunning((r) => !r)}>{running ? 'stop camera' : 'start camera'}</button>
          <button style={big} disabled={!running} onClick={() => void toggleTyping()}>{typing ? 'stop pinch typing' : 'pinch typing'}</button>
          {/* A recording for the fixtures (plan: Verification boundary). Saved
              on the iPad (Files / Photos), AirDropped to the laptop: no
              upload endpoint, so nothing on the room Wi-Fi can write files
              to the laptop through this page. */}
          <button style={big} disabled={!running} onClick={() => saveFrame(videoRef.current)}>save frame</button>
          <span>{status}</span>
        </div>
      )}
      <p style={{ margin: '8px 0' }}>
        {last
          ? last.ok
            ? `map: rms ${last.rms?.toFixed(1)} table px from ${last.markers.length} markers${last.rejected.length ? `, ignored ${last.rejected.join(',')}` : ''} · ${loc!.installs ? 'installed' : `confirming ${loc!.confirmed}/3`}`
            : `map: ${last.error}`
          : 'map: no markers seen yet. Press "reference points" on the laptop, or place the printed markers.'}
      </p>
      {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}
      <div style={{ position: 'relative', width: '100%' }}>
        {/* playsInline + muted: iOS refuses to play a camera stream inline otherwise. */}
        <video ref={videoRef} playsInline muted autoPlay style={{ width: '100%', display: 'block' }} />
        <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      </div>
    </main>
  )
}

const big = { fontSize: 20, padding: '12px 20px', borderRadius: 10 }

/** What the iPad sees: hands as dots, markers as outlines. Feedback for whoever aims the stand. */
function draw(c: HTMLCanvasElement | null, w: number, h: number, hands: Hand[], markers: Marker[]) {
  if (!c) return
  if (c.width !== w) c.width = w
  if (c.height !== h) c.height = h
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, w, h)
  ctx.lineWidth = 3
  ctx.strokeStyle = '#36ff7a'
  for (const m of markers) {
    ctx.beginPath()
    m.corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
    ctx.closePath()
    ctx.stroke()
    ctx.fillStyle = '#36ff7a'
    ctx.font = '20px system-ui'
    ctx.fillText(String(m.id), m.corners[0].x, m.corners[0].y - 6)
  }
  ctx.fillStyle = '#6cf0ff'
  for (const hand of hands)
    for (const [x, y] of hand.lm) {
      ctx.beginPath()
      ctx.arc(x, y, 4, 0, Math.PI * 2)
      ctx.fill()
    }
}

/** The camera's current frame, full size, as a JPEG download named with its size and time. */
function saveFrame(v: HTMLVideoElement | null) {
  if (!v || !v.videoWidth) return
  const c = document.createElement('canvas')
  c.width = v.videoWidth
  c.height = v.videoHeight
  c.getContext('2d')!.drawImage(v, 0, 0)
  c.toBlob(
    (b) => {
      if (!b) return
      const a = document.createElement('a')
      a.href = URL.createObjectURL(b)
      a.download = `ipad-${c.width}x${c.height}-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    },
    'image/jpeg',
    0.95,
  )
}
