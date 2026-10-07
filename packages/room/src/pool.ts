import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import WebSocket, { type ClientOptions } from 'ws'
import { DEADLINE_MS } from './room.ts'
import { isDevice, windowAt, WINDOW_LABEL, type HardwareWindow } from './window.ts'

/**
 * The device pool: the ONE owner of every connection to room hardware
 * (Juliusolsson05/hubble#73). Nothing else in the codebase opens one, and an
 * architecture test fails if anything tries.
 *
 * Two jobs, deliberately in one module:
 *
 * 1. **The hardware window.** The owner's rule (AGENTS.md, from 7 Oct 2026
 *    09:00): no connection to any room device outside the first 20 minutes
 *    of each hour, Stockholm time, reads included. The room is shared; those
 *    20 minutes are ours. Every connection is refused outside the window
 *    BEFORE a packet leaves, and every open one is closed at :30.
 * 2. **The pool.** The owner, 7 Oct: "build out the connection pooler". The
 *    pool creates every device connection, keeps a live registry of them
 *    (device, kind, opened-at, owner), shares one long-lived socket per URL
 *    between subscribers, and shows all of it read-only (`snapshot()`), so the
 *    operating surface can show what we hold on the room's devices right now.
 *
 * Why the two are one module: "may we connect" and "what are we connected
 * to" have to agree. With the registry somewhere else, a connection could be
 * opened that the closing sweep doesn't know about, which is exactly the leak the
 * rule forbids.
 *
 * Why by destination, not by caller: live.ts talks to the real room AND to
 * our emulator on 127.0.0.1:8790. Loopback is never hardware (plan, H1), so
 * rehearsal works at :45, while the same code pointed at the room is refused.
 * Loopback connections are neither refused nor registered: they are ours,
 * not the room's.
 *
 * No override (no env flag, no "force"): the rule is the owner's, and a
 * bypass becomes the default within a day. Tests inject a clock.
 */

// The window itself lives in window.ts (no dependencies, erasable syntax), so
// other tools can run the same rule directly in Node.
export { isDevice, WINDOW_LABEL, WINDOW_MINUTES, WINDOW_START_MINUTE, WINDOW_TZ, windowAt, type HardwareWindow } from './window.ts'

export class HardwareWindowClosed extends Error {
  readonly code = 'HARDWARE_WINDOW_CLOSED'
  readonly url: string
  readonly opensAt: number
  constructor(url: string, opensAt: number) {
    // Says what happened and when it reopens, so a refusal never reads as a
    // dead device and nobody walks to the room to reboot a working Pi.
    super(`room hardware is off limits outside ${WINDOW_LABEL} (Stockholm); ${new URL(url).host} refused, next window ${new Date(opensAt).toISOString()}`)
    this.url = url
    this.opensAt = opensAt
    this.name = 'HardwareWindowClosed'
  }
}

/** One live device connection, as the snapshot shows it. */
export interface PooledConnection {
  id: number
  kind: 'http' | 'ws'
  /** host:port of the device. */
  device: string
  /**
   * The device's origin only. Paths and queries carry credentials: room
   * tokens travel in `?token=`, and the Hue API user is a path segment
   * (`/api/<user>/lights/…`). The owner label says what the connection is for.
   */
  url: string
  /** Who asked: "lidar", "room events", "camera proxy"... */
  owner: string
  openedAt: number
  /** ws only: how many subscribers share it. */
  subscribers?: number
}

export interface PoolSnapshot {
  window: HardwareWindow
  connections: PooledConnection[]
}

export interface SocketHealth {
  connected: boolean
  lastMessageAt: number | null
  reconnects: number
  /** Set while the window keeps the socket shut; when it may reconnect. */
  waitingForWindow?: number
}

export interface SubscribeOptions {
  owner?: string
  maxDelayMs?: number
  heartbeatMs?: number
  maxPayload?: number
  onHealth?: (h: SocketHealth) => void
}

export interface PoolOptions {
  now?: () => number
  tz?: string
  /** Tests only: treat a loopback stand-in as a device. Production uses isDevice. */
  isDevice?: (url: string | URL) => boolean
}

export interface DevicePool {
  window(): HardwareWindow
  /** Throws HardwareWindowClosed for a device outside the window; otherwise returns. */
  check(url: string | URL): void
  fetch(url: string | URL, init?: RequestInit, owner?: string): Promise<Response>
  request(url: URL, opts: RequestOptions, onResponse?: (res: IncomingMessage) => void, owner?: string): ClientRequest
  /** A raw device socket for one owner (the display draw sockets); closed at :30 with the rest. */
  webSocket(url: string | URL, opts?: ClientOptions, owner?: string): WebSocket
  /**
   * A kept-alive subscription. Subscribers to the same URL share ONE socket.
   * It reconnects after drops, stays shut outside the window, and reopens at :00.
   */
  subscribe(url: string, onMessage: (data: string) => void, opts?: SubscribeOptions): () => void
  snapshot(): PoolSnapshot
}


export function createDevicePool(o: PoolOptions = {}): DevicePool {
  const now = o.now ?? Date.now
  const device = o.isDevice ?? isDevice
  const win = () => windowAt(now(), o.tz)
  const check = (url: string | URL) => {
    if (!device(url)) return
    const w = win()
    if (!w.open) throw new HardwareWindowClosed(String(url), w.opensAt)
  }

  // The registry. Each entry carries how to end it, so the closing sweep closes
  // whatever it finds, of any kind, without knowing who opened it.
  let nextId = 1
  const open = new Map<number, PooledConnection & { end: () => void; key: string }>()
  const register = (kind: 'http' | 'ws', url: string | URL, owner: string, end: () => void) => {
    const u = new URL(url)
    const id = nextId++
    open.set(id, { id, kind, device: u.host, url: u.origin, owner, openedAt: now(), end, key: String(url) })
    armSweep()
    return id
  }

  // One timer for the whole pool, armed while anything is registered, firing
  // at the end of the current window. One timer and not one per connection:
  // a single place where "everything closes at :30" is true or false.
  // unref so it never keeps a script alive by itself.
  let sweep: ReturnType<typeof setTimeout> | null = null
  function armSweep() {
    if (sweep) return
    sweep = setTimeout(() => {
      sweep = null
      for (const c of [...open.values()]) c.end()
      open.clear()
    }, Math.max(0, win().closesAt - now()))
    sweep.unref?.()
  }

  const subs = new Map<string, Shared>()
  interface Shared {
    listeners: Set<{ onMessage: (d: string) => void; onHealth?: (h: SocketHealth) => void }>
    stop: () => void
    count: () => number
  }

  function shareOne(url: string, first: SubscribeOptions): Shared {
    const listeners: Shared['listeners'] = new Set()
    let ws: WebSocket | null = null
    let id: number | null = null
    let closed = false
    let delay = 250
    let timer: ReturnType<typeof setTimeout> | null = null
    let beat: ReturnType<typeof setInterval> | null = null
    const health: SocketHealth = { connected: false, lastMessageAt: null, reconnects: 0 }
    const report = () => listeners.forEach((l) => l.onHealth?.({ ...health }))
    const later = (ms: number) => {
      timer = setTimeout(connect, ms)
      timer.unref?.()
    }

    // Kept alive the way room sockets must be (review #11): a deadline on
    // opening, and a ping/pong heartbeat, because a half-open socket after a
    // wifi blip stays "open" and silent forever.
    function connect() {
      if (closed) return
      try {
        check(url)
      } catch (e) {
        // Outside the window: wait for it to open, not for an exponential
        // backoff. Backoff would retry every 5 s for 40 minutes, a refusal
        // and a log line each time, while the window says when to come back.
        if (!(e instanceof HardwareWindowClosed)) throw e
        health.waitingForWindow = e.opensAt
        report()
        return later(Math.max(0, e.opensAt - now()))
      }
      health.waitingForWindow = undefined
      const sock = new WebSocket(url, { handshakeTimeout: DEADLINE_MS.connect, maxPayload: first.maxPayload })
      ws = sock
      if (device(url)) id = register('ws', url, first.owner ?? 'subscription', () => sock.terminate())
      let alive = true
      sock.on('open', () => {
        delay = 250
        health.connected = true
        report()
        beat = setInterval(() => {
          if (!alive) return sock.terminate()
          alive = false
          sock.ping()
        }, first.heartbeatMs ?? 5000)
        beat.unref?.()
      })
      sock.on('pong', () => (alive = true))
      sock.on('message', (d) => {
        alive = true
        health.lastMessageAt = Date.now()
        const text = d.toString()
        listeners.forEach((l) => l.onMessage(text))
      })
      sock.on('close', () => {
        if (beat) clearInterval(beat)
        beat = null
        if (id !== null) open.delete(id)
        id = null
        health.connected = false
        report()
        if (closed) return
        // Exponential backoff, capped: fast recovery from a blip without
        // hammering a room server that is down for a minute. If the close
        // was the closing sweep, connect() finds the window shut and waits.
        health.reconnects++
        later(delay)
        delay = Math.min(delay * 2, first.maxDelayMs ?? 5000)
      })
      sock.on('error', () => sock.terminate())
    }
    connect()
    return {
      listeners,
      count: () => listeners.size,
      stop() {
        closed = true
        if (timer) clearTimeout(timer)
        if (beat) clearInterval(beat)
        if (id !== null) open.delete(id)
        ws?.terminate()
      },
    }
  }

  return {
    window: win,
    check,
    fetch(url, init, owner = 'http') {
      try {
        check(url)
      } catch (e) {
        return Promise.reject(e)
      }
      if (!device(url)) return fetch(url, init)
      // In flight counts as a connection: a camera frame that takes 8 s over
      // the room wifi, started at :29:58, must not finish at :30:06.
      const abort = new AbortController()
      const id = register('http', url, owner, () => abort.abort(new HardwareWindowClosed(String(url), win().opensAt)))
      const signal = init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal
      return fetch(url, { ...init, signal }).finally(() => open.delete(id))
    },
    request(url, opts, onResponse, owner = 'http') {
      check(url)
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, opts, onResponse)
      if (!device(url)) return req
      const id = register('http', url, owner, () => req.destroy(new HardwareWindowClosed(String(url), win().opensAt)))
      req.once('close', () => open.delete(id))
      return req
    },
    webSocket(url, opts, owner = 'socket') {
      check(url)
      const ws = new WebSocket(url, opts)
      if (!device(url)) return ws
      const id = register('ws', url, owner, () => ws.terminate())
      ws.once('close', () => open.delete(id))
      return ws
    },
    subscribe(url, onMessage, opts = {}) {
      // One socket per URL: a second subscriber (the runtime and a diagnostic
      // page both following lidar) joins the first instead of opening another
      // connection to the same Pi.
      let s = subs.get(url)
      if (!s) subs.set(url, (s = shareOne(url, opts)))
      const me = { onMessage, onHealth: opts.onHealth }
      s.listeners.add(me)
      const shared = s
      return () => {
        shared.listeners.delete(me)
        if (shared.count() === 0) {
          shared.stop()
          subs.delete(url)
        }
      }
    },
    snapshot() {
      // Read-only copies: the snapshot never hands out a way to end a connection.
      const connections = [...open.values()].map(({ end: _end, key, ...c }) => {
        const s = c.kind === 'ws' ? subs.get(key) : undefined
        return s ? { ...c, subscribers: s.count() } : c
      })
      return { window: win(), connections }
    },
  }
}

/** The process's pool on the real clock. Callers take it as a default; tests pass their own. */
export const pool: DevicePool = createDevicePool()
