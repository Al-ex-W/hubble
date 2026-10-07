import { pool as defaultPool, type DevicePool, type SocketHealth, type SubscribeOptions } from './pool.ts'

export type { SocketHealth }

/**
 * A WebSocket that keeps itself connected. Room sockets drop when the wifi
 * hiccups or the room server restarts between slots, and the demo must
 * recover without anyone touching the laptop, so every subscription goes
 * through this.
 *
 * Since #73 this is a thin name over the device pool's `subscribe`, which owns
 * the socket. The pool is where the hardware window is enforced (shut outside
 * n:10–n:30, closed at :30, reopened at :10), where subscribers to one URL
 * share a single connection, and where the operating surface reads what we
 * hold. The keep-alive itself moved there too (open deadline, ping/pong
 * heartbeat, capped backoff; review #11 on half-open sockets), because
 * "reconnect" and "may we connect now" must be one decision. Loopback URLs
 * (the emulator) are never refused.
 *
 * `pool` is for tests; production uses the process's one pool.
 */
export function keepAlive(
  url: string,
  onMessage: (data: string) => void,
  opts: SubscribeOptions & { pool?: DevicePool } = {},
): () => void {
  const { pool = defaultPool, ...rest } = opts
  return pool.subscribe(url, onMessage, rest)
}
