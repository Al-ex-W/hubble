import { createMjpegParser } from './mjpeg.ts'

/**
 * The room's overhead camera as an ordinary MediaStream, so the hand tracker
 * runs on it exactly as on a laptop webcam (same <video>, frame gate,
 * calibration taps and MediaPipe call).
 *
 * Why not getUserMedia: the room camera is not on this laptop. It is the
 * Logitech Brio on pi-projector, served as MJPEG over HTTP. The page reaches
 * it through our server (/api/camera/stream → HUBBLE_ROOM_CAMERA_URL), never
 * the Pi directly (AGENTS.md: pages reach the camera through server proxies),
 * which also keeps the canvas untainted for MediaPipe.
 *
 * One canvas frame per JPEG, pushed with requestFrame(): the video's
 * currentTime then advances once per camera frame, which is what the frame
 * gate counts. Repainting on every animation frame would duplicate frames
 * and let one noisy sample pass the two-frame pinch confirmation (review #42).
 */
export interface RoomCamera {
  stream: MediaStream
  stop(): void
}

export async function openRoomCamera(url = '/api/camera/stream'): Promise<RoomCamera> {
  const abort = new AbortController()
  const res = await fetch(url, { signal: abort.signal })
  if (!res.ok || !res.body) throw new Error(`room camera: ${res.status} ${await res.text().catch(() => '')}`.trim())
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const stream = canvas.captureStream(0)
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack
  let stopped = false
  let decoding = false
  let first!: () => void
  const firstFrame = new Promise<void>((r) => (first = r))
  const parser = createMjpegParser((jpeg) => {
    // Newest frame wins: while one decodes, later ones are dropped, so a slow
    // laptop lowers the frame rate instead of building up delay (as the Pi does).
    if (decoding || stopped) return
    decoding = true
    void createImageBitmap(new Blob([jpeg.buffer as ArrayBuffer], { type: 'image/jpeg' }))
      .then((img) => {
        if (stopped) { img.close(); return }
        if (canvas.width !== img.width || canvas.height !== img.height) {
          canvas.width = img.width
          canvas.height = img.height
        }
        ctx.drawImage(img, 0, 0)
        img.close()
        track.requestFrame()
        first()
      })
      .catch(() => undefined)
      .finally(() => (decoding = false))
  })
  const reader = res.body.getReader()
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parser.push(value)
      }
    } catch {
      /* aborted on stop, or the stream dropped */
    }
  })()
  const stop = () => {
    stopped = true
    abort.abort()
    track.stop()
  }
  // Resolve once there is a picture, so the <video> has its size before the
  // calibration taps are taken against it.
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('room camera: no frame within 15 s')), 15000) })
  try {
    await Promise.race([firstFrame, timeout])
  } catch (e) {
    stop()
    throw e
  } finally { clearTimeout(timer!) }
  return { stream, stop }
}
