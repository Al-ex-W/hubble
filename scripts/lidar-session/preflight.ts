import { windowAt, WINDOW_LABEL, WINDOW_TZ } from '@hubble/room'

/**
 * May a guided lidar take start now? (Codex review of PR #90, P1.)
 *
 * Why this exists as its own module: the first version did the check inline in
 * lidar-session.ts with the laptop's local clock and a hard-coded `:20`
 * (`now.getMinutes() >= 20`). That was a second owner of the hardware window,
 * and it drifted the same day: the owner moved the window to n:10–n:30 at 11:40,
 * after which the script still allowed a preflight at :05 (the window is shut,
 * another team owns the room) and refused a take at :25 (the window is open).
 * It also read the laptop's zone, not the room's. Now the only source of truth is
 * packages/room/src/window.ts: `windowAt` decides open/closed and where it
 * closes, in Europe/Stockholm, and `WINDOW_LABEL` says it in every message, so
 * the next move of the window changes one file.
 *
 * Why the take must FINISH before the close, not just start inside the window:
 * AGENTS.md, "never start hardware work at :28 hoping it will be quick". The
 * pool would cut the socket at the close anyway, but a take cut mid-way is an
 * unlabelled half-take that looks like the touch code missed the last cues.
 *
 * Why loopback is always allowed: the emulator and a replay on our own laptop
 * are allowed at any time (AGENTS.md), and the device pool never gates
 * loopback either. The pool stays the enforcement; this is the polite early
 * refusal, so a take isn't half-set-up when the pool says no.
 *
 * Pure (clock injected) so the edges can be tested at :09, :10, :25 and :30
 * without waiting for the hour.
 */
export type Preflight = { ok: true } | { ok: false; reason: string }

/** Seconds of slack after the last cue: one more rotation plus socket close and the manifest write. */
export const TAKE_SLACK_MS = 10_000

const clock = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: WINDOW_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))

export function preflight(input: { nowMs: number; takeMs: number; url: string; takeId: string }): Preflight {
  const { nowMs, takeMs, url, takeId } = input
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  const loopback = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
  if (loopback) return { ok: true }
  const needMs = takeMs + TAKE_SLACK_MS
  const w = windowAt(nowMs)
  const need = `${Math.ceil(needMs / 1000)} s`
  if (!w.open) {
    return { ok: false, reason: `Take ${takeId} reads the real lidar, and the hardware window (${WINDOW_LABEL}, ${WINDOW_TZ}) is closed: it is ${clock(nowMs)}, it opens at ${clock(w.opensAt)}.` }
  }
  if (nowMs + needMs > w.closesAt) {
    return { ok: false, reason: `Take ${takeId} needs ${need} and must finish before the window (${WINDOW_LABEL}) closes at ${clock(w.closesAt)}; it is ${clock(nowMs)}. Wait for the next window.` }
  }
  return { ok: true }
}
