import type { Response as ExpressResponse } from 'express'
import type { OverlayLine, RenderRequest, RenderStreamLine, SurfacesLine, TouchLine } from '@hubble/stage'

/**
 * Past this much unflushed SSE output a display is dropped rather than
 * buffered without end. A healthy display drains in milliseconds; one that
 * falls a megabyte behind is a frozen tab or a dead Wi-Fi link, and every
 * render would otherwise grow the server's memory for it. Dropping is safe
 * only because subscribe() replays the active render: EventSource reconnects
 * on its own and lands on exactly what the table should show.
 */
export const MAX_CLIENT_BUFFER_BYTES = 1024 * 1024

/**
 * One render's claim on the table. Exactly one slot is active at a time:
 * opening a slot supersedes the previous one (latest request wins), so two
 * people asking at once never get their answers interleaved on the projector.
 */
export interface RenderSlot {
  /** Relay one brain line to the displays, if this slot still owns the table. */
  emit(line: RenderStreamLine): void
  /** Aborts when a newer request takes the table. */
  signal: AbortSignal
}

/** What the hub remembers about the active render, for follow-up actions. */
export interface ActiveRender {
  request: RenderRequest
  /** Set from the `done` line; undefined while streaming or after a failure. */
  answer?: string
}

/**
 * The stage hub: owns which render is on the projector and fans it out to
 * displays over Server-Sent Events (one-way and dependency-free, which is all
 * a display needs, and it works in the room Pi's Chromium).
 *
 * The server, not each display, decides what is active. Displays only ever
 * mirror; if each display picked its own "latest" they could disagree after a
 * reconnect, and a late display would have nothing to pick from at all.
 */
export function createStageHub() {
  const clients = new Set<ExpressResponse>()
  let active: { controller: AbortController; render: ActiveRender } | null = null
  // The lines a display needs to redraw the active render from scratch:
  // `start` plus everything after it except `raw`/`trace`, which displays
  // ignore and which are most of the bytes. Bounded by one answer's events.
  let snapshot: RenderStreamLine[] = []
  // Current overlay per layer (the lesson's lit keys), replayed to every new
  // display after the answer snapshot, so a reconnecting Pi shows the key to
  // press too, not only the answer.
  const overlays = new Map<string, OverlayLine>()
  // The latest full surface set (the runtime's surface manager publishes it).
  // One line replaces the last, so replaying the latest is a complete restore.
  let surfaces: SurfacesLine | null = null

  const send = (client: ExpressResponse, line: RenderStreamLine | OverlayLine | SurfacesLine | TouchLine) => {
    client.write(`data: ${JSON.stringify(line)}\n\n`)
    // `write` never refuses; it queues. writableLength is what is still
    // queued in userland for this socket, i.e. how far behind the display is.
    if (client.writableLength > MAX_CLIENT_BUFFER_BYTES) {
      clients.delete(client)
      client.destroy()
    }
  }
  const broadcast = (line: RenderStreamLine | OverlayLine | SurfacesLine | TouchLine) => {
    for (const client of clients) send(client, line)
  }

  return {
    subscribe(res: ExpressResponse) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(': connected\n\n')
      clients.add(res)
      // A display that (re)connects mid-answer, e.g. after a slot reset on the
      // Pi, must show the current answer, not a blank table until the next one.
      for (const line of snapshot) send(res, line)
      for (const line of overlays.values()) send(res, line)
      // After the answer: a display applies the surface set to the answer it
      // just rebuilt (e.g. the answer's moved offset), so order matters.
      if (surfaces) send(res, surfaces)
      // Idle streams get closed by proxies and some browsers; a comment line
      // every 15 s keeps the connection open without sending an event.
      const ping = setInterval(() => res.write(': ping\n\n'), 15000)
      const unsubscribe = () => {
        clearInterval(ping)
        clients.delete(res)
      }
      res.on('close', unsubscribe)
      return unsubscribe
    },

    /**
     * Claim the table for a new render. Called when the request arrives, not
     * when its `start` line does: "latest" means latest asked, and the brain
     * might otherwise emit an older request's start after a newer one's.
     */
    open(request: RenderRequest): RenderSlot {
      active?.controller.abort()
      const controller = new AbortController()
      const mine = { controller, render: { request } as ActiveRender }
      active = mine
      return {
        signal: controller.signal,
        emit(line) {
          if (active !== mine) return
          if (line.kind === 'raw' || line.kind === 'trace') {
            // Displays ignore these, but they cost nothing to forward and keep
            // the SSE stream a faithful mirror for debugging tools.
            broadcast(line)
            return
          }
          // The snapshot is reset on this slot's own start, not on open(), so a
          // display reconnecting in the instant between the two still gets the
          // previous answer rather than nothing.
          if (line.kind === 'start') snapshot = [line]
          else snapshot.push(line)
          if (line.kind === 'done') mine.render.answer = line.answer || undefined
          broadcast(line)
        },
      }
    },

    /** The render on the table, for follow-up actions. */
    active(): ActiveRender | null {
      return active?.render ?? null
    },

    /**
     * Clear the table. Displays have no "clear" line in the stream contract,
     * so this is an empty render: a `start` with no events. It also goes into
     * the snapshot, so a display reconnecting afterwards stays blank instead
     * of resurrecting the dismissed answer.
     */
    dismiss() {
      active?.controller.abort()
      active = null
      const start: RenderStreamLine = { kind: 'start', renderId: `dismiss-${Math.random().toString(36).slice(2, 8)}`, intent: '', model: '', t: 0 }
      snapshot = [start]
      broadcast(start)
    },

    /**
     * Replace one overlay layer on every display. Independent of the active
     * render: a new answer must not wipe the lesson's lit key, and the lesson
     * must not need a render to change a light.
     */
    overlay(line: OverlayLine) {
      if (line.shapes.length) overlays.set(line.layer, line)
      else overlays.delete(line.layer)
      broadcast(line)
    },

    /**
     * A finger on the table, for the displays' ripple (#89). Broadcast only:
     * unlike overlay() and surfaces() nothing is kept, so subscribe() has
     * nothing to replay. A touch is a moment, not a state; a projector that
     * reconnects (Pi Wi-Fi drops, a slot reset) must not ripple at spots
     * people touched before it came back. A display that misses a touch while
     * disconnected simply doesn't ripple, which is the truthful outcome.
     */
    touch(line: TouchLine) {
      broadcast(line)
    },

    /** Publish the whole surface set to every display, and keep it for reconnects. */
    surfaces(line: SurfacesLine) {
      surfaces = line
      broadcast(line)
    },

    /** Re-send the active render so every display plays it again from the top. */
    replay() {
      for (const line of snapshot) broadcast(line)
    },
  }
}
