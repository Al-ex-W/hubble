/**
 * The hardware window: the hours-of-use rule for the shared room hardware,
 * in one dependency-free module.
 *
 * No connection to room hardware outside the window each hour, Stockholm
 * time, reads included. Change it HERE: the device pool (pool.ts) and every
 * message read these constants. This file imports nothing and uses only
 * erasable TypeScript, so plain Node can run it as is.
 */

/** The minute of each hour the window opens. */
export const WINDOW_START_MINUTE = 10
/** How long it stays open. */
export const WINDOW_MINUTES = 20
export const WINDOW_TZ = 'Europe/Stockholm'
const HOUR = 3_600_000
const START_MS = WINDOW_START_MINUTE * 60_000
const WINDOW_MS = WINDOW_MINUTES * 60_000
const mm = (n: number) => String(n).padStart(2, '0')
/** "n:10–n:30": every message about the window says it from the constants, never from a copy. */
export const WINDOW_LABEL = `n:${mm(WINDOW_START_MINUTE)}–n:${mm(WINDOW_START_MINUTE + WINDOW_MINUTES)}`

export interface HardwareWindow {
  open: boolean
  /** This window's start when open; the next window's start when closed. */
  opensAt: number
  /** The end of the current hour's window (in the past when closed). */
  closesAt: number
}
const formatters = new Map<string, Intl.DateTimeFormat>()
const formatter = (tz: string) => {
  let f = formatters.get(tz)
  if (!f) formatters.set(tz, (f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, minute: 'numeric', second: 'numeric' })))
  return f
}

/**
 * Where `nowMs` falls against the window, read in the room's zone, not the
 * laptop's: today they match, but a laptop on a half-hour-offset zone would
 * put the edges in the wrong place (plan, H3 refined).
 */
export function windowAt(nowMs: number, tz: string = WINDOW_TZ): HardwareWindow {
  const parts = formatter(tz).formatToParts(new Date(nowMs))
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  const second = Number(parts.find((p) => p.type === 'second')?.value ?? 0)
  const intoHour = minute * 60_000 + second * 1000 + (((nowMs % 1000) + 1000) % 1000)
  const hourStart = nowMs - intoHour
  const thisOpens = hourStart + START_MS
  const thisCloses = thisOpens + WINDOW_MS
  const open = nowMs >= thisOpens && nowMs < thisCloses
  // Closed before this hour's window: it opens later this hour. Closed after
  // it: the next hour's. closesAt is always this hour's end (in the past
  // once it has closed), as before.
  const opensAt = open || nowMs < thisOpens ? thisOpens : thisOpens + HOUR
  return { open, opensAt, closesAt: thisCloses }
}

/**
 * Is this URL a room device? Everything that isn't loopback. Deny by default:
 * a new device, or the laptop's DHCP address moving (.17 → .18), is refused
 * without anyone having to list it.
 */
export function isDevice(url: string | URL): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  return !(host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host))
}

