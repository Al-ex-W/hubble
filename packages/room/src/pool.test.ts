import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { createDevicePool, HardwareWindowClosed, isDevice, windowAt, WINDOW_LABEL, WINDOW_START_MINUTE, type SocketHealth } from './pool.ts'

/**
 * The device pool (Juliusolsson05/hubble#73).
 *
 * The window's oracle is the owner's rule, "only the first 20 minutes of each
 * hour", Stockholm time. The instants are written out by hand here, never
 * computed with the pool's helpers; they are schema-derived from the rule
 * (the window's edges). 7 Oct 2026 is CEST (UTC+2), so 09:00 Stockholm is
 * 07:00Z.
 *
 * Devices are loopback stand-ins (an HTTP + WebSocket server), routed through
 * the device check by injection. Oracle: what the stand-in actually received
 * (hit and connection counters), so "refused" means nothing arrived.
 */
const STHLM_0900 = Date.parse('2026-10-07T07:00:00.000Z')
const MIN = 60_000
/** This hour's window opens at 09:10 (WINDOW_START_MINUTE); every test time is measured from it. */
const OPEN = STHLM_0900 + WINDOW_START_MINUTE * MIN

describe('windowAt: the owner rule, n:10 to n:30 Stockholm time (moved from n:00–n:20 on 7 Oct)', () => {
  it('is open from :10:00.000 up to but not including :30:00.000', () => {
    // Breaks caught: an off-by-one at either edge (:30 still open, or :10
    // still closed); and the old window surviving the move: 09:00–09:10 now
    // belongs to another team, so it must be CLOSED.
    expect(windowAt(STHLM_0900).open).toBe(false)
    expect(windowAt(OPEN - 1).open).toBe(false)
    expect(windowAt(OPEN).open).toBe(true)
    expect(windowAt(OPEN + 20 * MIN - 1).open).toBe(true)
    expect(windowAt(OPEN + 20 * MIN).open).toBe(false)
    expect(windowAt(STHLM_0900 + 59 * MIN + 59_999).open).toBe(false)
    expect(windowAt(OPEN + 60 * MIN).open).toBe(true)
    expect(WINDOW_LABEL).toBe('n:10–n:30')
  })

  it('says when it closes and when it next opens, before, during and after', () => {
    // Break caught: a closed window before :10 pointing at NEXT hour's
    // opening, so the pool would wait 70 min instead of 10.
    expect(windowAt(STHLM_0900 + 5 * MIN)).toEqual({ open: false, opensAt: OPEN, closesAt: OPEN + 20 * MIN })
    expect(windowAt(OPEN + 5 * MIN)).toEqual({ open: true, opensAt: OPEN, closesAt: OPEN + 20 * MIN })
    expect(windowAt(OPEN + 30 * MIN)).toEqual({ open: false, opensAt: OPEN + 60 * MIN, closesAt: OPEN + 20 * MIN })
  })

  it('reads the minute in Stockholm, whatever the laptop clock zone is', () => {
    // Break caught: reading the laptop's zone. 09:15 Stockholm is 12:45 in
    // Kolkata (a half-hour offset), outside the window there.
    expect(windowAt(OPEN + 5 * MIN, 'Asia/Kolkata').open).toBe(false)
    expect(windowAt(OPEN + 5 * MIN).open).toBe(true)
  })
})

describe('isDevice: classified by destination, never by caller', () => {
  it('lets loopback through and treats everything else as room hardware', () => {
    // Breaks caught: the emulator (127.0.0.1:8790) refused at :45, which
    // stops rehearsal; or a room address passing as local. live.ts serves
    // both, so only the destination can decide (stage 0).
    for (const u of ['http://127.0.0.1:8790/room', 'ws://localhost:8790/events', 'http://[::1]:8792/', 'http://127.5.0.1/']) expect(isDevice(u)).toBe(false)
    for (const u of ['http://192.168.42.21/camera/frame', 'ws://192.168.42.24/scan', 'https://room.local:8443/api', 'http://pi-lidar.local/']) expect(isDevice(u)).toBe(true)
  })
})

async function stand() {
  let hits = 0
  let sockets = 0
  const server: Server = createServer((req, res) => {
    hits++
    // /slow never answers: an in-flight request for the :20 sweep to cut.
    if (req.url === '/slow') return
    res.end('ok')
  })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws) => {
    sockets++
    ws.send('hello')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    hits: () => hits,
    sockets: () => sockets,
    close: () =>
      new Promise<void>((r) => {
        wss.clients.forEach((c) => c.terminate())
        wss.close()
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

const until = async (ok: () => boolean, ms = 2000) => {
  const t0 = Date.now()
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setImmediate(r))
  }
}

describe('the pool refuses before any packet leaves', () => {
  const cleanup: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    vi.useRealTimers()
    for (const c of cleanup.splice(0)) await c()
  })

  it('refuses a device fetch outside the window and lets it through inside', async () => {
    // Break caught: the check placed after the request, or skipped for fetch.
    const dev = await stand()
    cleanup.push(dev.close)
    let now = OPEN + 30 * MIN
    const pool = createDevicePool({ now: () => now, isDevice: () => true })
    const refused = pool.fetch(`${dev.http}/frame`)
    // Refused at the check, not cut by the :20 sweep afterwards: nothing was
    // registered, so no request was ever started (a mutant that skipped the
    // check survived on the sweep's abort alone).
    expect(pool.snapshot().connections).toEqual([])
    await expect(refused).rejects.toBeInstanceOf(HardwareWindowClosed)
    expect(dev.hits()).toBe(0)
    now = OPEN + 5 * MIN
    expect(await (await pool.fetch(`${dev.http}/frame`)).text()).toBe('ok')
    expect(dev.hits()).toBe(1)
  })

  it('refuses node http requests and raw sockets the same way', async () => {
    // Break caught: legacy.ts and the camera proxy use node:http(s), and the
    // draw sockets use ws; a gate on fetch alone would leave them open.
    const dev = await stand()
    cleanup.push(dev.close)
    const pool = createDevicePool({ now: () => OPEN + 45 * MIN, isDevice: () => true })
    expect(() => pool.request(new URL(`${dev.http}/x`), { method: 'GET' })).toThrow(HardwareWindowClosed)
    expect(() => pool.webSocket(dev.ws)).toThrow(HardwareWindowClosed)
    await new Promise((r) => setTimeout(r, 50))
    expect(dev.hits()).toBe(0)
    expect(dev.sockets()).toBe(0)
  })

  it('never refuses or registers loopback, so the emulator works at :45', async () => {
    // Break caught: a pool that refuses every URL outside the window, which
    // stops emulator rehearsal 40 minutes of every hour.
    const dev = await stand()
    cleanup.push(dev.close)
    const pool = createDevicePool({ now: () => OPEN + 45 * MIN })
    expect(await (await pool.fetch(`${dev.http}/room`)).text()).toBe('ok')
    expect(pool.snapshot().connections).toEqual([])
  })

  it('names the window and the next opening in the refusal', () => {
    // Break caught: an opaque "fetch failed" that reads as a dead device.
    const pool = createDevicePool({ now: () => OPEN + 45 * MIN, isDevice: () => true })
    try {
      pool.check('http://192.168.42.21/camera/frame')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(HardwareWindowClosed)
      expect((e as HardwareWindowClosed).opensAt).toBe(OPEN + 60 * MIN)
      expect((e as Error).message).toMatch(/n:10–n:30/)
    }
  })
})

describe('the pool: one registry, shared sockets, everything closed at :30', () => {
  const cleanup: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    vi.useRealTimers()
    for (const c of cleanup.splice(0)) await c()
  })

  it('shares one socket between subscribers to the same URL, and shows it without the token', async () => {
    // Breaks caught: a second subscriber opening a second connection to the
    // same Pi (what the pool exists to stop); and the room token, which
    // travels in ?token=, leaking into the snapshot the operating surface shows.
    const dev = await stand()
    cleanup.push(dev.close)
    const pool = createDevicePool({ now: () => OPEN + 5 * MIN, isDevice: () => true })
    const a: string[] = []
    const b: string[] = []
    const url = `${dev.ws}/scan?token=secret-team-token`
    const stopA = pool.subscribe(url, (d) => a.push(d), { owner: 'lidar' })
    const stopB = pool.subscribe(url, (d) => b.push(d), { owner: 'spatial page' })
    cleanup.push(stopA, stopB)
    await until(() => a.length > 0)
    expect(dev.sockets()).toBe(1)
    expect(b).toEqual(a)
    const snap = pool.snapshot()
    expect(snap.window.open).toBe(true)
    expect(snap.connections).toHaveLength(1)
    expect(snap.connections[0]).toMatchObject({ kind: 'ws', owner: 'lidar', subscribers: 2, url: dev.ws })
    expect(JSON.stringify(snap)).not.toContain('secret-team-token')
  })

  it('never shows a path in the snapshot, because the Hue API user is one', async () => {
    // Break caught: the Hue bridge's API user (a credential, env only) shown
    // on the operating surface, since Hue puts it in the path:
    // PUT /api/<user>/lights/3/state. Oracle: the user string must not appear.
    const dev = await stand()
    cleanup.push(dev.close)
    const pool = createDevicePool({ now: () => OPEN + 5 * MIN, isDevice: () => true })
    const req = pool.fetch(`${dev.http}/slow?x=1`.replace('/slow', '/api/hue-user-secret/slow'), undefined, 'hue light')
    req.catch(() => {})
    expect(JSON.stringify(pool.snapshot())).not.toContain('hue-user-secret')
    expect(pool.snapshot().connections[0]).toMatchObject({ kind: 'http', owner: 'hue light', url: dev.http })
  })

  it('keeps the socket while one subscriber remains, and closes it with the last', async () => {
    // Break caught: the first unsubscribe tearing down a socket another
    // subscriber still reads from (a page closing kills the runtime's lidar).
    const dev = await stand()
    cleanup.push(dev.close)
    const pool = createDevicePool({ now: () => OPEN + 5 * MIN, isDevice: () => true })
    const got: string[] = []
    const stopA = pool.subscribe(`${dev.ws}/scan`, () => {})
    const stopB = pool.subscribe(`${dev.ws}/scan`, (d) => got.push(d))
    await until(() => got.length > 0)
    stopA()
    expect(pool.snapshot().connections).toHaveLength(1)
    stopB()
    expect(pool.snapshot().connections).toHaveLength(0)
  })

  it('closes every device connection at :30, and the subscription waits for :10 instead of retrying', async () => {
    // Breaks caught: a lidar socket opened at :19 streaming on past :20 (a
    // connect-time check alone never ends an open connection); a request in
    // flight at :20 finishing afterwards; and a reconnect loop retrying every
    // few seconds for 40 minutes instead of waiting for the window.
    const dev = await stand()
    cleanup.push(dev.close)
    let now = OPEN + 19 * MIN
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pool = createDevicePool({ now: () => now, isDevice: () => true })
    const health: SocketHealth[] = []
    cleanup.push(pool.subscribe(`${dev.ws}/scan`, () => {}, { owner: 'lidar', onHealth: (h) => health.push(h) }))
    const inflight = pool.fetch(`${dev.http}/slow`, undefined, 'camera')
    await vi.waitFor(() => expect(dev.hits()).toBe(1))
    await vi.waitFor(() => expect(health.some((h) => h.connected)).toBe(true))
    expect(pool.snapshot().connections.map((c) => c.kind).sort()).toEqual(['http', 'ws'])

    now = OPEN + 20 * MIN
    vi.advanceTimersByTime(MIN)
    await expect(inflight).rejects.toBeInstanceOf(HardwareWindowClosed)
    await vi.waitFor(() => expect(health.at(-1)?.connected).toBe(false))
    // The close schedules a reconnect; running it finds the window shut, and the subscription then waits for :00.
    now = OPEN + 30 * MIN
    vi.advanceTimersByTime(5000)
    await vi.waitFor(() => expect(health.at(-1)?.waitingForWindow).toBe(OPEN + 60 * MIN))
    expect(pool.snapshot().connections).toEqual([])
    expect(dev.sockets()).toBe(1)
    // Waiting means waiting: ten more closed minutes bring no new attempt.
    // A backoff mutant retried (and reported) every 5 s here.
    const waits = health.filter((h) => h.waitingForWindow).length
    vi.advanceTimersByTime(10 * MIN)
    expect(health.filter((h) => h.waitingForWindow).length).toBe(waits)

    now = OPEN + 60 * MIN
    vi.advanceTimersByTime(21 * MIN)
    await vi.waitFor(() => expect(dev.sockets()).toBe(2))
  })
})
