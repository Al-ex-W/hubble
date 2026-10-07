import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { readFileSync, readdirSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDevicePool, WINDOW_LABEL, WINDOW_MINUTES, WINDOW_START_MINUTE } from '@hubble/room'
import { createApp } from './index.ts'

/**
 * The room camera's one shared stream per ROI (#84), over real HTTP.
 *
 * Fixtures: apps/server/fixtures/calibration-2026-10-07/*.jpg, a RECORDING of
 * real room-camera frames, re-served as MJPEG multipart at 60 fps. The fake
 * camera is schema-derived (the Pi's own wire format, camera.py). Oracles,
 * independent of the manager's code:
 *   - the fake camera's counters: how many /camera/stream connections it
 *     opened, how many /camera/frame stills it served, and how many streams
 *     are open right now;
 *   - the `X-Hubble-Received-At` header the manager stamps on each part,
 *     read by a naive boundary scanner here, so frame age is measured on the
 *     wire, not through the code under test.
 *
 * The pool's device check is injected (loopback counts as a device, as in
 * devices.test.ts) and its clock is fixed, so the window can be exercised
 * without a real device.
 */
const AT = (min: number) => Date.parse('2026-10-07T07:00:00.000Z') + min * 60_000
// The window's edges from the room package's own constants, never hard-coded:
// #97 moved the window from n:00–n:20 to n:10–n:30, and a test that spelled
// :00/:20 would have gone red for the wrong reason (or, worse, passed while
// testing the wrong minutes).
const WINDOW_OPEN = AT(WINDOW_START_MINUTE + 5)
const WINDOW_SHUT = AT(WINDOW_START_MINUTE + WINDOW_MINUTES + 5)
const WINDOW_END = AT(WINDOW_START_MINUTE + WINDOW_MINUTES)
const FIX = new URL('./fixtures/calibration-2026-10-07/', import.meta.url)
const FRAMES = readdirSync(FIX)
  .filter((n) => n.endsWith('.jpg'))
  .map((n) => new Uint8Array(readFileSync(new URL(n, FIX))))

interface FakeCamera {
  url: string
  streamConnections: () => number
  /** Frames the fake camera has WRITTEN to its stream(s) (the upstream count). */
  streamFrames: () => number
  frameHits: () => number
  openStreams: () => number
  /** Manual mode only: write one more MJPEG part to the open stream(s). */
  pushFrame: () => void
  close: () => Promise<void>
}

interface FakeOptions {
  /** Parts per second on the stream (default 60). Ignored in manual mode. */
  fps?: number
  /** No timer: frames are written only by `pushFrame()`, so a test controls exactly what the upstream sends. */
  manual?: boolean
  /** Delay before /camera/frame's body (after headers), to overlap concurrent stills. */
  frameDelayMs?: number
}

async function fakeCamera(opts: number | FakeOptions = 60): Promise<FakeCamera> {
  const o: FakeOptions = typeof opts === 'number' ? { fps: opts } : opts
  const fps = o.fps ?? 60
  let streamConnections = 0
  let streamFrames = 0
  let frameHits = 0
  let openStreams = 0
  const open = new Set<import('node:http').ServerResponse>()
  const writeFrame = (res: import('node:http').ServerResponse) => {
    const jpeg = FRAMES[streamFrames % FRAMES.length]!
    streamFrames++
    res.write(Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`), Buffer.from(jpeg), Buffer.from('\r\n')]))
  }
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/camera/frame')) {
      frameHits++
      res.setHeader('Content-Type', 'image/jpeg')
      // Headers first, then a delayed body: concurrent stills overlap, and a
      // body can finish after the window's end (finding 2).
      if (o.frameDelayMs) {
        res.flushHeaders()
        setTimeout(() => res.end(Buffer.from(FRAMES[frameHits % FRAMES.length]!)), o.frameDelayMs)
      } else {
        res.end(Buffer.from(FRAMES[frameHits % FRAMES.length]!))
      }
      return
    }
    if (req.url?.startsWith('/camera/stream')) {
      streamConnections++
      openStreams++
      open.add(res)
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' })
      let timer: ReturnType<typeof setInterval> | null = null
      if (!o.manual) timer = setInterval(() => writeFrame(res), Math.round(1000 / fps))
      res.on('close', () => {
        if (timer) clearInterval(timer)
        open.delete(res)
        openStreams--
      })
      return
    }
    res.statusCode = 404
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    streamConnections: () => streamConnections,
    streamFrames: () => streamFrames,
    frameHits: () => frameHits,
    openStreams: () => openStreams,
    pushFrame: () => { for (const res of open) writeFrame(res) },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

/** A part the client received, with the manager's arrival stamp. */
interface Part {
  bytes: number
  receivedAt: number
}

/**
 * An independent MJPEG reader for the test (not the production parser): scans
 * for the `--frame` boundary, reads Content-Length and the received-at header,
 * and hands on whole parts. Deliberately naive, so a frame age measured here
 * is not the implementation grading itself.
 */
function readParts(reader: ReadableStreamDefaultReader<Uint8Array>, onPart: (p: Part) => void) {
  let buf = Buffer.alloc(0)
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf = Buffer.concat([buf, Buffer.from(value)])
        for (;;) {
          const headEnd = buf.indexOf('\r\n\r\n')
          if (headEnd < 0) break
          const header = buf.subarray(0, headEnd).toString('latin1')
          const len = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? -1)
          if (len < 0) {
            buf = buf.subarray(headEnd + 4)
            continue
          }
          if (buf.length < headEnd + 4 + len) break
          const receivedAt = Number(/x-hubble-received-at:\s*(\d+)/i.exec(header)?.[1] ?? 0)
          onPart({ bytes: len, receivedAt })
          buf = buf.subarray(headEnd + 4 + len)
          // The trailing CRLF after the body.
          if (buf.subarray(0, 2).toString('latin1') === '\r\n') buf = buf.subarray(2)
        }
      }
    } catch {
      /* aborted on close */
    }
  })()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The received-at stamps of whatever parts a raw chunk carries (test-side, independent). */
function partsIn(chunk: Buffer): { receivedAt: number }[] {
  const out: { receivedAt: number }[] = []
  for (const m of chunk.toString('latin1').matchAll(/x-hubble-received-at:\s*(\d+)/gi)) out.push({ receivedAt: Number(m[1]) })
  return out
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function bench(nowMs: number, cam: FakeCamera, now: () => number = () => nowMs) {
  const devices = createDevicePool({ now, isDevice: () => true })
  const app = createApp({ port: 0, llm: { baseUrl: 'http://unused', apiKey: undefined, model: 'unused' }, jevApiKey: undefined, roomCameraUrl: cam.url }, { devices })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cleanups.push(() => { server.closeAllConnections(); server.close() })
  return { base, devices, app }
}

beforeAll(() => {
  // A moved fixtures directory must fail loudly, not run on zero frames.
  if (FRAMES.length < 12) throw new Error(`camera fixtures missing: ${FRAMES.length}`)
})

describe('one upstream per ROI, shared by every client (#84)', () => {
  it('N browser clients produce exactly 1 upstream connection, counted in /api/devices', async () => {
    // Break caught: the old per-request proxy, which opened one 60 fps stream
    // to the Pi for every tab, or the shared manager opening a second stream
    // for the same ROI. Oracle: the fake camera's connection counter.
    const cam = await fakeCamera()
    cleanups.push(cam.close)
    const { base } = await bench(WINDOW_OPEN, cam)
    const controllers: AbortController[] = []
    for (let i = 0; i < 4; i++) {
      const ac = new AbortController()
      controllers.push(ac)
      const r = await fetch(`${base}/api/camera/stream`, { signal: ac.signal })
      expect(r.status).toBe(200)
      readParts(r.body!.getReader(), () => {})
    }
    // Wait until the upstream has actually opened and every client joined.
    await sleep(200)
    expect(cam.streamConnections()).toBe(1)
    const snap = (await (await fetch(`${base}/api/devices`)).json()) as { connections: { kind: string; owner: string; subscribers?: number }[] }
    expect(snap.connections).toHaveLength(1)
    expect(snap.connections[0]).toMatchObject({ kind: 'http', owner: 'camera stream', subscribers: 4 })
    for (const ac of controllers) ac.abort()
  })

  it('two different ROIs are two upstreams, each shared by its own clients', async () => {
    // Break caught: keying the shared stream by nothing (or by "full" always),
    // so two clients asking for different crops would get ONE upstream's
    // frames and one of them would show the wrong rectangle while its
    // landmarks are mapped with the other crop.
    const cam = await fakeCamera()
    cleanups.push(cam.close)
    const { base } = await bench(WINDOW_OPEN, cam)
    const acs: AbortController[] = []
    for (const roi of ['0.1,0.2,0.3,0.4', '0.1,0.2,0.3,0.4', '0.5,0.5,0.2,0.2']) {
      const ac = new AbortController()
      acs.push(ac)
      const r = await fetch(`${base}/api/camera/stream?roi=${roi}`, { signal: ac.signal })
      readParts(r.body!.getReader(), () => {})
    }
    await sleep(200)
    expect(cam.streamConnections()).toBe(2)
    const snap = (await (await fetch(`${base}/api/devices`)).json()) as { connections: { owner: string; subscribers?: number }[] }
    const counts = snap.connections.map((c) => [c.owner, c.subscribers] as const).sort()
    expect(counts).toEqual([
      ['camera stream (roi=0.1,0.2,0.3,0.4)', 2],
      ['camera stream (roi=0.5,0.5,0.2,0.2)', 1],
    ])
    for (const ac of acs) ac.abort()
  })

  it('a stalled client does not slow a fast one, and never accumulates a backlog', async () => {
    // Break caught: piping the one shared upstream to every client. A slow
    // reader then applies backpressure to the upstream itself, the Pi pauses,
    // and every OTHER client starves too; and when the slow reader returns it
    // walks a growing queue of stale frames. Newest-wins per client prevents
    // both. Oracles: the fast client's frame count/age while the slow one is
    // paused, and the slow client's own frame age once it resumes.
    const cam = await fakeCamera(60)
    cleanups.push(cam.close)
    const { base } = await bench(WINDOW_OPEN, cam)

    // Fast client: fetch, read every part, record ages.
    const fastAc = new AbortController()
    cleanups.push(() => fastAc.abort())
    const r = await fetch(`${base}/api/camera/stream`, { signal: fastAc.signal })
    const ages: number[] = []
    readParts(r.body!.getReader(), (p) => ages.push(Date.now() - p.receivedAt))

    // Slow client: a raw node request whose socket we simply never read.
    const slow = await new Promise<{ res: import('node:http').IncomingMessage; close: () => void }>((resolve) => {
      const req = httpRequest(`${base}/api/camera/stream`, (res) => {
        res.pause()
        resolve({ res, close: () => (res.destroy(), req.destroy()) })
      })
      req.end()
    })
    cleanups.push(slow.close)

    // Pause the slow client for 1.2 s (~72 camera frames at 60 fps). A pipe
    // backlog of that many frames is what must not exist; we let the server
    // reach backpressure first.
    await sleep(300)
    const before = ages.length
    await sleep(1200)
    const during = ages.length - before
    // 60 fps over 1.2 s; a shared-pipe mutant gives a handful at most because
    // the paused socket stops the shared upstream for everyone.
    expect(during).toBeGreaterThan(20)
    const fastWorst = Math.max(...ages.slice(before))
    // Fresh frames, not a backlog: well under the 1.2 s the slow client stalled.
    expect(fastWorst).toBeLessThan(500)

    // Now the slow client resumes. The FIRST frames may be whatever was
    // already in its kernel buffer when backpressure hit (a couple of frames),
    // but a pipe backlog would be ~72. Count how many stale frames arrive
    // Resume and consume what is already in the socket buffer. A pipe backlog
    // of ~72 frames (1.2 s at 60 fps) would put dozens of stale frames ahead
    // of the first current one; a skip keeps at most the handful the kernel
    // buffered when backpressure hit. The threshold is well under the 72 a
    // pipe accumulates and well above the kernel's own buffer.
    const slowAges: number[] = []
    slow.res.on('data', (chunk: Buffer) => {
      for (const p of partsIn(chunk)) slowAges.push(Date.now() - p.receivedAt)
    })
    slow.res.resume()
    for (let i = 0; i < 80 && !slowAges.some((a) => a < 34); i++) await sleep(10)
    const firstFresh = slowAges.findIndex((a) => a < 34)
    expect(firstFresh).toBeGreaterThanOrEqual(0)
    // The first current frame arrives within a kernel-buffer's worth, not the
    // ~72 stale ones a pipe would queue behind it.
    expect(firstFresh).toBeLessThan(40)
  })
})

describe('/api/camera/frame from the live stream', () => {
  it('serves the newest streamed frame without a second upstream request', async () => {
    // Break caught: a still that opens its own /camera/frame request on the
    // Pi while a stream is already live — the extra 1080p fetch per poll that
    // congested the link in the first place. Oracle: the fake camera's still
    // counter must not move.
    const cam = await fakeCamera()
    cleanups.push(cam.close)
    const { base } = await bench(WINDOW_OPEN, cam)
    const ac = new AbortController()
    cleanups.push(() => ac.abort())
    const stream = await fetch(`${base}/api/camera/stream`, { signal: ac.signal })
    let first = false
    readParts(stream.body!.getReader(), () => (first = true))
    // Wait for a streamed frame (up to 1 s).
    for (let i = 0; i < 50 && !first; i++) await sleep(20)
    expect(first).toBe(true)
    const before = cam.frameHits()
    const r = await fetch(`${base}/api/camera/frame`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('image/jpeg')
    const bytes = new Uint8Array(await r.arrayBuffer())
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8])
    // The stream supplied it: no second fetch to the camera.
    expect(cam.frameHits()).toBe(before)
    ac.abort()
  })

  it('falls back to one pool fetch when no stream is live', async () => {
    // Break caught: a still that only ever reads a stream, so it hangs (or
    // 503s) when the hand tracker is not running.
    const cam = await fakeCamera()
    cleanups.push(cam.close)
    const { base } = await bench(WINDOW_OPEN, cam)
    const r = await fetch(`${base}/api/camera/frame`)
    expect(r.status).toBe(200)
    expect(cam.frameHits()).toBe(1)
  })
})

describe('the upstream is closed with its last client, and at the window end', () => {
  it('the last client leaving closes the upstream', async () => {
    // Break caught: an abandoned stream to the Pi running on after every tab
    // closed, which the Pi counts as a reader forever. Oracle: the fake
    // camera's open-stream counter, and an empty /api/devices.
    const cam = await fakeCamera()
    cleanups.push(cam.close)
    const { base } = await bench(WINDOW_OPEN, cam)
    const ac = new AbortController()
    const r = await fetch(`${base}/api/camera/stream`, { signal: ac.signal })
    readParts(r.body!.getReader(), () => {})
    await sleep(150)
    expect(cam.openStreams()).toBe(1)
    ac.abort()
    // The client's socket close must reach the server and end the upstream.
    for (let i = 0; i < 50 && cam.openStreams() !== 0; i++) await sleep(20)
    expect(cam.openStreams()).toBe(0)
    expect(((await (await fetch(`${base}/api/devices`)).json()) as { connections: unknown[] }).connections).toEqual([])
  })

  it('outside the window the stream is refused before the camera is touched', async () => {
    // Break caught: /api/camera/stream reaching the Pi outside the window,
    // which the operating surface and the bench would poll all hour.
    const cam = await fakeCamera()
    cleanups.push(cam.close)
    const { base } = await bench(WINDOW_SHUT, cam)
    const r = await fetch(`${base}/api/camera/stream`)
    expect(r.status).toBe(503)
    const body = (await r.json()) as { error: string; opensAt: number }
    // The label comes from the package constant, so a moved window changes it here too.
    expect(body.error).toContain(WINDOW_LABEL)
    expect(body.opensAt).toBe(AT(60 + WINDOW_START_MINUTE))
    expect(cam.streamConnections()).toBe(0)
  })

  it('the pool sweep closes the shared upstream and the client at the window end (injected clock)', async () => {
    // Break caught: a stream opened just inside the window running past its
    // end, which would keep sending on another team's time. The clock is
    // injected; the pool arms its sweep for the window's real close, so a
    // clock half a second before the end fires it while the edge crosses.
    let now = WINDOW_END - 500
    const cam = await fakeCamera()
    cleanups.push(cam.close)
    const { base, devices } = await bench(0, cam, () => now)
    const ac = new AbortController()
    cleanups.push(() => ac.abort())
    const r = await fetch(`${base}/api/camera/stream`, { signal: ac.signal })
    readParts(r.body!.getReader(), () => {})
    await sleep(100)
    expect(cam.openStreams()).toBe(1)
    // Cross the window's end.
    now = WINDOW_END
    for (let i = 0; i < 200 && (devices.snapshot().connections.length !== 0 || cam.openStreams() !== 0); i++) await sleep(20)
    expect(devices.snapshot().connections).toEqual([])
    expect(cam.openStreams()).toBe(0)
  })

  it('a still whose body finishes after the window end is aborted, not answered 200 (finding 2)', async () => {
    // Break caught: `pool.fetch` unregisters at response HEADERS, so a slow
    // body (headers just before the end, body 550 ms later) finishes outside
    // the window and /api/camera/frame wrongly answers 200. The manual frame
    // delay makes the overlap deterministic; the clock crosses WINDOW_END
    // between headers and body.
    let now = WINDOW_END - 200
    const cam = await fakeCamera({ frameDelayMs: 550 })
    cleanups.push(cam.close)
    const { base } = await bench(0, cam, () => now)
    const pending = fetch(`${base}/api/camera/frame`)
    // Headers are up quickly; then cross the window's end while the body waits.
    await sleep(80)
    now = WINDOW_END + 10
    const r = await pending
    // The pool sweep destroyed the still's transfer: the route answers with
    // the window refusal, never a 200 that finished on another team's time.
    expect(r.status).toBe(503)
    expect((await r.json()).error).toContain(WINDOW_LABEL)
  })

  it('six concurrent stills open one upstream request, not six (finding 3)', async () => {
    // Break caught: once the cached frame is stale, each concurrent still
    // starts its own /camera/frame fetch (the review measured six parallel
    // requests for one stale frame). Coalescing shares one in-flight promise
    // per ROI. Oracle: the fake camera's still counter.
    const cam = await fakeCamera({ frameDelayMs: 120 })
    cleanups.push(cam.close)
    const { base } = await bench(WINDOW_OPEN, cam)
    const results = await Promise.all(Array.from({ length: 6 }, () => fetch(`${base}/api/camera/frame`)))
    for (const r of results) expect(r.status).toBe(200)
    await Promise.all(results.map((r) => r.arrayBuffer()))
    expect(cam.frameHits()).toBe(1)
  })
})

describe('the newest-wins pump never retransmits, and a joiner gets the cache', () => {
  it('a client that hits backpressure sends at most one copy of each upstream frame (finding 1)', async () => {
    // Break caught: on 'drain' the pump re-writes `latest` unconditionally,
    // so a continuously-reading client retransmits the same 78 KB frame on
    // every drain (the review measured 2,184 copies of one frame in 250 ms).
    // Oracle: count parts on the wire against the fake camera's own write
    // count for that stream — the broadcast must never exceed the source.
    // Manual mode: the test writes exactly N frames and can count to a stop.
    const cam = await fakeCamera({ manual: true })
    cleanups.push(cam.close)
    const { base } = await bench(WINDOW_OPEN, cam)
    const ac = new AbortController()
    cleanups.push(() => ac.abort())
    const r = await fetch(`${base}/api/camera/stream`, { signal: ac.signal })
    const parts: number[] = []
    readParts(r.body!.getReader(), (p) => parts.push(p.receivedAt))
    // The fake camera increments openStreams when the upstream request lands;
    // pushFrame only writes to open streams, so wait for it.
    for (let i = 0; i < 50 && cam.openStreams() === 0; i++) await sleep(10)
    expect(cam.openStreams()).toBe(1)
    // Write one frame; let the client receive it and (with a large frame and
    // a busy loopback) work the write path hard for 250 ms.
    cam.pushFrame()
    await sleep(250)
    // Write a handful more, each of which must appear just once.
    const N = 8
    for (let i = 1; i < N; i++) { cam.pushFrame(); await sleep(30) }
    await sleep(200)
    // No part may be duplicated: each upstream frame yields at most one part.
    // (With `sent` tracking, count === frames; without it, a client under
    // backpressure duplicates until the buffer clears.)
    expect(parts.length).toBeLessThanOrEqual(cam.streamFrames())
    // And the writes actually happened, so the bound is not vacuous.
    expect(parts.length).toBeGreaterThan(0)
    expect(cam.streamFrames()).toBe(N)
  })

  it('a late joiner gets the cached frame immediately, before the next upstream frame (surviving mutation)', async () => {
    // Break caught: dropping the immediate `pump(client, s)` on attach, so a
    // client joining between two upstream frames waits a whole frame interval
    // with no picture (a blank operator view, a stalled hand tracker). Manual
    // mode: the upstream is held open and must NOT send anything, so the only
    // possible source of the joiner's first part is the cached frame.
    const cam = await fakeCamera({ manual: true })
    cleanups.push(cam.close)
    const { base } = await bench(WINDOW_OPEN, cam)
    // First client gets one frame, then stays joined (keeps the upstream open).
    const ac1 = new AbortController()
    cleanups.push(() => ac1.abort())
    const first = await fetch(`${base}/api/camera/stream`, { signal: ac1.signal })
    let firstGot = 0
    readParts(first.body!.getReader(), () => firstGot++)
    for (let i = 0; i < 50 && cam.openStreams() === 0; i++) await sleep(10)
    cam.pushFrame()
    for (let i = 0; i < 50 && firstGot === 0; i++) await sleep(10)
    expect(firstGot).toBe(1)
    const upstreamFrames = cam.streamFrames()
    // A second client joins. No new upstream frame is written; if the join
    // does not replay the cache, it receives nothing.
    const ac2 = new AbortController()
    cleanups.push(() => ac2.abort())
    const second = await fetch(`${base}/api/camera/stream`, { signal: ac2.signal })
    let secondGot = 0
    readParts(second.body!.getReader(), () => secondGot++)
    for (let i = 0; i < 50 && secondGot === 0; i++) await sleep(10)
    expect(secondGot).toBe(1)
    expect(cam.streamFrames()).toBe(upstreamFrames)
  })
})
