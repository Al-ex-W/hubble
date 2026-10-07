import type { Express, Response } from 'express'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { HardwareWindowClosed, pool as defaultPool, type DevicePool } from '@hubble/room'
import { createMjpegParser } from '../shared/hands/mjpeg.ts'

/**
 * The room's overhead camera (the Brio on pi-projector, organisers' spec
 * Draft 0.4: GET /camera/stream MJPEG, GET /camera/frame JPEG), proxied for
 * our pages:
 *   GET /api/camera/stream  → <base>/camera/stream
 *   GET /api/camera/frame   → <base>/camera/frame
 * `?roi=` is passed through (the Pi crops losslessly, which halves the wifi
 * cost for a table-sized area).
 *
 * Why a proxy and not the Pi's URL in the page: AGENTS.md (pages reach the
 * camera through server proxies), one place that knows the room's address,
 * and a same-origin image, so the hand tracker can read its pixels into a
 * canvas (a cross-origin <img> or fetch would taint it).
 *
 * ## One upstream per ROI, newest frame wins (#84)
 *
 * The old proxy opened a fresh upstream per request and `r.pipe(res)`'d it.
 * Every tab had its own 60 fps stream to the Pi, the runtime pulled another
 * full 1080p still every 2 s, and the operator polled four more a second —
 * six connections where one would do, on a congested channel-48 Wi-Fi. Worse,
 * `pipe()` lets delay build: when a slow reader made `res.write` backpressure,
 * `pipe` paused the Pi's socket, and the bytes already buffered in the OS
 * sockets were delivered in order, so the reader fell further and further
 * behind (a loopback bench measured ~12 s of lag).
 *
 * So: ONE upstream per ROI key, shared by every client, opened and closed
 * through the device pool — the pool is the only code allowed to open a device
 * connection (#73), refuses outside the hardware window, and closes everything
 * at its end. The manager cuts the stream with the shared MJPEG parser and
 * keeps only the newest frame. Each client is written to only while its socket
 * drains; the moment `res.write` returns false the client is skipped until
 * `'drain'`, then it gets the newest frame, never the backlog. One slow tab
 * lowers its own frame rate and can't slow a fast one or the Pi.
 *
 * On the last client leaving, the upstream is destroyed: an idle stream to the
 * Pi is pure cost, and the Pi counts readers.
 *
 * An outside-window refusal answers 503 with the window in the message (so
 * the page shows "camera off until :10", not "camera broken"), and a stream
 * still open at the window's end is cut by the pool's sweep.
 */

const PASS = /^(stream|frame)$/
/** The Pi's parts are 60 fps; older than this a still is not "the live picture" any more. */
export const FRAME_FRESH_MS = 300
/**
 * The freshness threshold also follows the stream's own cadence: a crop that
 * runs slower than 3 fps has a frame interval longer than FRAME_FRESH_MS, and
 * a fixed threshold would make every still fall back to a second full fetch
 * even though a perfectly current frame was sitting in the stream. Capped so
 * a camera that has almost stopped still eventually falls back.
 */
const MAX_FRESH_MS = 1500

interface Client {
  res: Response
  /**
   * Set when `res.write` refused a frame: the client's socket is behind, so
   * every later frame is skipped until it drains. This is the whole
   * newest-wins policy — no queue, no pipe.
   */
  blocked: boolean
  /**
   * The `seq` of the last frame written to this client. `res.write` accepting
   * a frame is what counts (a false return means buffered, not dropped), so
   * on 'drain' the pump sends only a frame NEWER than this. Without it a
   * client that hits backpressure retransmits the same frame on every drain:
   * a review of #94 measured 2,184 copies of one 78 KB frame in 250 ms.
   */
  sent: number
}

interface Latest {
  jpeg: Uint8Array
  /** Monotonic per shared stream: what a client has already been sent. */
  seq: number
  /** When the server finished this frame, for the still's freshness check and the wire header. */
  receivedAt: number
}

interface Shared {
  key: string
  owner: string
  clients: Set<Client>
  latest: Latest | null
  /** Frames parsed so far, for `Latest.seq`. */
  frames: number
  /** Smoothed gap between frames, so the still's freshness follows the stream's real rate. */
  intervalMs: number | null
  up: ClientRequest | null
  done: boolean
}

export interface CameraStreams {
  /** Join (or open) the shared upstream for `roi` and stream it to `res`. Throws HardwareWindowClosed outside the window. */
  attach(roi: string, res: Response): void
  /** The newest live frame for `roi` if fresh, else one pool fetch. */
  frame(roi: string): Promise<Uint8Array>
  /** owner label → subscriber count, merged into `/api/devices` (the pool has no HTTP subscriber count). */
  subscriberCounts(): Record<string, number>
  /** Destroy every upstream; tests and shutdown. Open client responses are ended. */
  close(): void
}

export interface CameraStreamOptions {
  pool?: DevicePool
  now?: () => number
}

const ownerFor = (roi: string) => (roi ? `camera stream (roi=${roi})` : 'camera stream')
const pathFor = (what: string, roi: string) => `/camera/${what}${roi ? `?roi=${encodeURIComponent(roi)}` : ''}`

/** One MJPEG part in the same framing the Pi uses (and the browser parser reads). */
function part(f: Latest): Buffer {
  const head = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.jpeg.length}\r\nX-Hubble-Received-At: ${f.receivedAt}\r\n\r\n`
  const tail = Buffer.from('\r\n')
  return Buffer.concat([Buffer.from(head, 'latin1'), Buffer.from(f.jpeg), tail])
}

export function createCameraStreams(base: string, o: CameraStreamOptions = {}): CameraStreams {
  const pool = o.pool ?? defaultPool
  const now = o.now ?? Date.now
  const shared = new Map<string, Shared>()

  function end(s: Shared) {
    if (s.done) return
    s.done = true
    shared.delete(s.key)
    for (const c of s.clients) if (!c.res.writableEnded) c.res.end()
    s.clients.clear()
    s.up?.destroy()
    s.up = null
  }

  /**
   * One client's newest-wins pump. Writes the latest frame if it is newer
   * than what this client already got; if `write` refuses (the socket is
   * behind), it blocks and waits for `'drain'`, then re-arms and writes the
   * NEWEST frame at that moment — never retransmitting one already sent and
   * never the backlog. `c.sent` is the guard: a false return means the frame
   * was buffered, so it counts as sent, and a drain with no newer frame
   * writes nothing (the review of #94's duplicate-frame bug).
   */
  function pump(c: Client, s: Shared) {
    if (c.blocked || c.res.writableEnded || c.res.destroyed) return
    const f = s.latest
    if (!f || f.seq === c.sent) return
    c.sent = f.seq
    if (!c.res.write(part(f))) {
      c.blocked = true
      c.res.once('drain', () => {
        c.blocked = false
        pump(c, s)
      })
    }
  }

  function opened(roi: string): Shared {
    const key = roi
    const s: Shared = { key, owner: ownerFor(roi), clients: new Set(), latest: null, frames: 0, intervalMs: null, up: null, done: false }
    const url = new URL(pathFor('stream', roi), base)
    // The same generous deadline as the old proxy: on-site frame reads ranged
    // 0.5–8 s (H28), and a socket idle for 15 s is a dead Pi, not a slow one.
    // pool.request throws HardwareWindowClosed here, before a packet leaves;
    // the caller turns that into a 503 with `opensAt` (attached below).
    const parser = createMjpegParser((jpeg) => {
      const receivedAt = now()
      if (s.latest) s.intervalMs = s.intervalMs === null ? receivedAt - s.latest.receivedAt : s.intervalMs * 0.7 + (receivedAt - s.latest.receivedAt) * 0.3
      s.latest = { jpeg, seq: ++s.frames, receivedAt }
      for (const c of s.clients) pump(c, s)
    })
    const up = pool.request(
      url,
      { method: 'GET', timeout: 15000 },
      (r: IncomingMessage) => {
        if (r.statusCode !== 200) return end(s)
        r.on('data', (chunk: Buffer) => parser.push(chunk))
        r.on('error', () => end(s))
        r.on('close', () => end(s))
      },
      s.owner,
    )
    s.up = up
    up.on('timeout', () => up.destroy(new Error('room camera timed out')))
    up.on('error', () => end(s))
    up.end()
    shared.set(key, s)
    return s
  }

  // One in-flight still per ROI. A live stream is always preferred, but when
  // its frame is stale (or no stream is open) several pages polling at once
  // would otherwise each start their own /camera/frame fetch — the review of
  // #94 measured six parallel requests for one stale frame. Coalescing makes
  // the first caller's fetch serve every concurrent waiter.
  const stills = new Map<string, Promise<Uint8Array>>()

  /**
   * One still from the Pi via node:http through the pool.
   *
   * Why not `pool.fetch`: it unregisters the connection when the RESPONSE
   * HEADERS arrive, so a slow body that starts at :29:59.8 and finishes at
   * :30:00.3 is never aborted and answers 200 outside the window. `req.once
   * ('close')`, which the pool uses for `request()`, keeps the registration
   * until the body is fully read, and the :30 sweep's `req.destroy(err)`
   * rejects this promise (HardwareWindowClosed) instead of finishing.
   */
  function fetchStill(roi: string): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      let req: ClientRequest
      try {
        req = pool.request(
          new URL(pathFor('frame', roi), base),
          { method: 'GET', timeout: 15000 },
          (r: IncomingMessage) => {
            if (r.statusCode !== 200) {
              r.resume()
              return reject(new Error(`room camera ${r.statusCode}`))
            }
            const chunks: Buffer[] = []
            r.on('data', (c: Buffer) => chunks.push(c))
            r.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
            r.on('error', reject)
          },
          'camera frame',
        )
      } catch (e) {
        return reject(e)
      }
      req.on('timeout', () => req.destroy(new Error('room camera timed out')))
      req.on('error', reject)
      req.end()
    })
  }

  const freshMs = (s: Shared) => Math.min(MAX_FRESH_MS, Math.max(FRAME_FRESH_MS, (s.intervalMs ?? 0) * 2))

  return {
    attach(roi, res) {
      const s = shared.get(roi) ?? opened(roi)
      // After opened() (which checks the window), the stream may already have
      // failed before this client arrived: reopen instead of hanging.
      if (s.done) return void res.status(502).json({ error: 'room camera stream failed' })
      const client: Client = { res, blocked: false, sent: 0 }
      s.clients.add(client)
      res.status(200)
      res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
      res.setHeader('Cache-Control', 'no-store')
      res.flushHeaders()
      // The newest frame at once: a client joining mid-stream shows a picture
      // now, not on the next camera frame.
      pump(client, s)
      res.on('close', () => {
        s.clients.delete(client)
        if (s.clients.size === 0) end(s)
      })
    },
    async frame(roi) {
      const s = shared.get(roi)
      // A live stream for the SAME roi already has the picture: serving the
      // still from it saves an entire extra fetch on the congested link. The
      // runtime always asks the full-frame ROI (''), so a cropped hand-tracker
      // stream can't serve it — the pixels differ — and this falls through to
      // a fetch. If a full-frame stream is open, it does serve the runtime.
      if (s?.latest && now() - s.latest.receivedAt <= freshMs(s)) return s.latest.jpeg
      const pending = stills.get(roi)
      if (pending) return pending
      const p = fetchStill(roi)
      stills.set(roi, p)
      return p.finally(() => {
        if (stills.get(roi) === p) stills.delete(roi)
      })
    },
    subscriberCounts() {
      const out: Record<string, number> = {}
      for (const s of shared.values()) out[s.owner] = s.clients.size
      return out
    },
    close() {
      for (const s of [...shared.values()]) end(s)
    },
  }
}

/**
 * The `/api/camera/*` HTTP surface over a `CameraStreams`. `?roi=` is
 * validated to the Pi's fractions (or a short name) before it becomes an
 * upstream URL, so a page can't smuggle anything else into the request.
 */
export function mountRoomCamera(app: Express, base: string | undefined, streams: CameraStreams | undefined) {
  app.get('/api/camera/:what', (req, res) => {
    if (!PASS.test(req.params.what)) return void res.status(404).json({ error: 'stream or frame' })
    if (!base || !streams) return void res.status(503).json({ error: 'no room camera: set HUBBLE_ROOM_CAMERA_URL (e.g. http://192.168.42.21)' })
    const roi = typeof req.query.roi === 'string' && /^[\w.,-]{1,64}$/.test(req.query.roi) ? req.query.roi : ''
    if (req.params.what === 'frame') {
      streams
        .frame(roi)
        .then((jpeg) => {
          res.setHeader('Content-Type', 'image/jpeg')
          res.setHeader('Cache-Control', 'no-store')
          res.send(Buffer.from(jpeg))
        })
        .catch((e) => {
          if (e instanceof HardwareWindowClosed) return void res.status(503).json({ error: e.message, opensAt: e.opensAt })
          res.status(502).json({ error: `room camera unreachable: ${e instanceof Error ? e.message : String(e)}` })
        })
      return
    }
    try {
      streams.attach(roi, res)
    } catch (e) {
      if (!(e instanceof HardwareWindowClosed)) throw e
      res.status(503).json({ error: e.message, opensAt: e.opensAt })
    }
  })
}
