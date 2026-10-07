/**
 * One connection to /api/stage/events per page, shared by every hook that
 * reads it (surfaces, overlays, the table display).
 *
 * Why: each hook used to open its own EventSource. The dev server is plain
 * HTTP/1.1, where Chrome allows 6 connections per host across ALL tabs, and
 * an EventSource holds one forever. The bench mounted four of them (overlays,
 * surfaces in ChatPreview, TableSim and HandPanel) plus the emulator's state
 * stream: 5 of 6 slots gone before anything else ran. Every POST (send, each
 * MIDI note, keyboard strokes) and the render's own NDJSON stream queued for
 * the last one; on 2026-10-06 MIDI posts waited 92 s, send did nothing, and
 * a reload hung loading its own modules. Measured: 7 established Chrome
 * connections to :5173 (6 HTTP + Vite's websocket).
 *
 * The cost of sharing: the hub replays the current state to each NEW
 * connection, and a hook that mounts after the shared one opened would miss
 * it. So the lines since the connection opened are kept and replayed to a
 * late subscriber, which then sees what its own connection would have shown
 * (the hub's replay followed by every live line). The buffer starts over on
 * each (re)open, because the server replays everything again then.
 */

export interface StageListener {
  line(l: { kind?: string } & Record<string, unknown>): void
  /** The connection (re)opened: the server is about to replay its state. */
  open?(): void
}

// A render's NDJSON is a few hundred lines; this keeps many renders' worth
// while bounding a long-running display. Past it, the oldest lines go: a
// late subscriber could then miss the start of an old render, never the
// latest surfaces or overlays (those are re-sent whole on every change).
const MAX_BUFFER = 5000

let source: EventSource | null = null
let buffer: ({ kind?: string } & Record<string, unknown>)[] = []
const listeners = new Set<StageListener>()
let retry: ReturnType<typeof setTimeout> | null = null
let backoffMs = 0

/**
 * Reopen after the browser gave up. An EventSource retries by itself after a
 * dropped connection, but NOT after an HTTP error: Vite answers 500/502 while
 * our server restarts (every tsx-watch save, every calibration reload), and
 * the browser then closes the EventSource for good (readyState CLOSED). Until
 * 7 Oct nothing reopened it, so /table, the Show preview and the bench froze
 * until someone reloaded the page (the audit's HIGH finding, and the owner's
 * "500" after a restart). So when it is CLOSED and someone still listens,
 * open a new one after a short, growing pause: 0.5 s, doubling, at most 5 s,
 * reset once a connection opens. The new connection gets the hub's full
 * replay, exactly like a first connect.
 */
const MIN_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 5000

function connect() {
  const es = new EventSource('/api/stage/events')
  source = es
  es.onopen = () => {
    backoffMs = 0
    buffer = []
    for (const x of listeners) x.open?.()
  }
  es.onmessage = (m) => {
    let line: { kind?: string } & Record<string, unknown>
    try {
      line = JSON.parse(m.data)
    } catch {
      return
    }
    // Touch lines (#89) are events, not state: the hub never replays them,
    // so this buffer mustn't either. Buffered, a ripple layer that mounts
    // late (a route change, a panel opened) would replay every touch since
    // the connection opened, as a burst of ripples at old spots. A reconnect
    // (#92's backoff) clears the buffer and the hub replays only state, so
    // touches never come back through either path.
    if (line.kind !== 'touch') buffer.push(line)
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
    for (const x of listeners) x.line(line)
  }
  es.onerror = () => {
    // Still CONNECTING: the browser is retrying on its own; leave it.
    if (es.readyState !== 2 /* EventSource.CLOSED */ || source !== es || retry) return
    es.close()
    backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs ? backoffMs * 2 : MIN_BACKOFF_MS)
    retry = setTimeout(() => {
      retry = null
      if (listeners.size > 0 && source === es) connect()
    }, backoffMs)
  }
}

export function subscribeStage(l: StageListener): () => void {
  listeners.add(l)
  if (!source) {
    connect()
  } else {
    // Late subscriber: catch it up as if it had connected itself.
    for (const line of buffer) l.line(line)
  }
  return () => {
    listeners.delete(l)
    if (listeners.size === 0 && source) {
      source.close()
      source = null
      buffer = []
      if (retry) clearTimeout(retry)
      retry = null
      backoffMs = 0
    }
  }
}
