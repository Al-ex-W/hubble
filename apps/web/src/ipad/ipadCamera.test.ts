import { describe, expect, it } from 'vitest'
import { MarkerObservation, Observation } from '../../../server/spatial/observations.ts'
import { cameraBlocker, createMarkerSender, observationFromHands, startCamera } from './ipadCamera.ts'

/**
 * What leaves the iPad (#91). Label: schema-derived; the oracle is the
 * server's own wire schemas (observations.ts), which decide what the
 * spatial service accepts, and plain counting of requests.
 */
const hand = { handedness: 'Right' as const, score: 1, lm: Array.from({ length: 21 }, (_, i) => [i * 10, i * 5] as [number, number]) }

describe('the iPad page', () => {
  it('sends hands the server accepts as the ipad source, sized as its frame', () => {
    // Break caught: an observation without `source: ipad` is the room
    // camera's (the default) and gets read with the room's map; one whose
    // geometry doesn't carry its size can be read with a map measured at
    // another resolution.
    const o = observationFromHands([hand, hand, hand], 1280, 720, { session: 's', seq: 1, capturedAt: 5, input: undefined })
    expect(Observation.safeParse(o).success).toBe(true)
    expect(o.source).toBe('ipad')
    expect(o.geometry).toBe('ipad:1280x720')
    expect(o.hands).toHaveLength(2)
    expect(o.hands[0]!.index).toEqual({ x: 80, y: 40 })
    expect(o.hands[0]!.pinch).toEqual({ thumb: { x: 40, y: 20 }, wrist: { x: 0, y: 0 }, middle: { x: 90, y: 45 } })
  })

  it('sends markers at most twice a second, one request at a time, accepted by the server', async () => {
    // Break caught: detecting and posting on every camera frame. Detection
    // costs tens of ms on the iPad, straight out of the hand tracker's rate,
    // and stacked requests reach the server stale.
    let t = 0
    const bodies: unknown[] = []
    let release!: () => void
    const fetcher = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      await new Promise<void>((r) => (release = r))
      return new Response(JSON.stringify({ last: null, confirmed: 0, installs: 0 }), { status: 202 })
    }) as unknown as typeof fetch
    const s = createMarkerSender({ fetcher, now: () => t, session: 'x' })
    const corners = [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }, { x: 0, y: 9 }] as const
    expect(s.due()).toBe(true)
    const first = s.send([{ id: 0, corners: [...corners] as never }], 1280, 720)
    expect(s.due()).toBe(false)
    t = 1000
    expect(s.due()).toBe(false) // still in flight
    release()
    await first
    expect(s.due()).toBe(true)
    void s.send([], 1280, 720)
    t = 1400
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(s.due()).toBe(false) // in flight done, but only 400 ms since the last
    expect(bodies).toHaveLength(2)
    for (const b of bodies) expect(MarkerObservation.safeParse(b).success).toBe(true)
  })

  it('tells the person why the camera is blocked', () => {
    // Break caught: Safari hiding mediaDevices on plain http, and the page
    // failing with "undefined is not an object" on the stand.
    const loc = { protocol: 'http:', hostname: '192.168.42.39', host: '192.168.42.39:5173' }
    expect(cameraBlocker(loc, false, false)).toContain('https://192.168.42.39:5173/ipad-camera')
    expect(cameraBlocker(loc, true, true)).toBeNull()
  })
})

describe('starting and stopping the iPad camera (review of #95, findings 5 and 6)', () => {
  // Label: synthetic (the browser's camera and MediaPipe can't run in
  // tests); the fakes resolve only when the test says so, which is the
  // ordering the bug needs. Oracle: counting stop()/close()/release calls.
  const deferred = <T,>() => {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const fakes = () => {
    const log: string[] = []
    const stream = { getTracks: () => [{ stop: () => log.push('track stopped') }] }
    const lm = { close: () => log.push('tracker closed') }
    const wake = { release: async () => void log.push('wake released') }
    const s = deferred<typeof stream>()
    const l = deferred<typeof lm>()
    const deps = {
      wake: async () => wake,
      stream: () => s.promise,
      play: async () => undefined,
      landmarker: () => l.promise,
      run: () => (log.push('loop started'), () => log.push('loop cancelled')),
      released: () => log.push('pointer mode'),
      error: (e: unknown) => log.push(`error ${String(e)}`),
    }
    return { log, deps, stream, lm, s, l }
  }

  it('stops a camera stream that arrives after stop', async () => {
    // Break caught (6): stop() while getUserMedia is pending; the stream
    // resolving afterwards kept the iPad's camera on with nothing reading it.
    const { log, deps, stream, s } = fakes()
    const stop = startCamera(deps)
    await flush()
    stop()
    s.resolve(stream)
    await flush()
    expect(log).toContain('track stopped')
    expect(log).not.toContain('loop started')
  })

  it('closes a hand tracker that arrives after stop', async () => {
    // Break caught (6): the same for createLandmarker, which holds the GPU.
    const { log, deps, stream, lm, s, l } = fakes()
    const stop = startCamera(deps)
    s.resolve(stream)
    await flush()
    stop()
    l.resolve(lm)
    await flush()
    expect(log).toContain('tracker closed')
    expect(log).toContain('track stopped')
    expect(log).not.toContain('loop started')
  })

  it('returns to pointer mode whenever the camera stops', async () => {
    // Break caught (5): stopping the camera left pinch typing granted, so
    // the server kept reading pinches for a camera nobody was running.
    const { log, deps, stream, lm, s, l } = fakes()
    const stop = startCamera(deps)
    s.resolve(stream)
    l.resolve(lm)
    await flush()
    expect(log).toContain('loop started')
    stop()
    expect(log).toEqual(expect.arrayContaining(['loop cancelled', 'tracker closed', 'track stopped', 'pointer mode']))
    stop() // idempotent: one release, not two
    expect(log.filter((x) => x === 'pointer mode')).toHaveLength(1)
  })
})
