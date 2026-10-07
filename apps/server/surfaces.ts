import {
  closeSurface,
  DEFAULT_SURFACE,
  moveSurface,
  openSurface,
  raiseSurface,
  resolvePanels,
  updateSurface,
  type Box,
  type RenderStreamLine,
  type Scene,
  type StageEvent,
  type Surface,
  type SurfaceSet,
  type SurfacesLine,
  type TableSurface,
} from '@hubble/stage'

/**
 * The live set of surfaces on the table, and the one place that changes it.
 *
 * The rules (clamping, stacking, hit-testing) are pure functions in
 * packages/stage surfaces.ts; this module owns the *state*: the current set,
 * its revision, and publishing every change to displays as one full
 * `surfaces` line through the hub (which replays the latest to a display that
 * reconnects). The runtime creates it, so "what is on the table" sits next to
 * the rest of the product state and nowhere else.
 *
 * The answer is one surface, id `answer`, driven by the render lines the hub
 * accepted for the active slot (latest request wins there, so it wins here).
 * Its box is where its panels are: the union of `resolvePanels`, the same
 * geometry the brain verified and StageView draws, so a hand later hits the
 * box the answer really occupies. The server only has the estimated heights;
 * the renderer may grow a panel past them. Hit-testing (#32,
 * surfaceGestures.ts) uses this box as it is, so a pinch on the grown part of
 * a panel misses it; nothing has needed the measured height yet.
 */
export const ANSWER_ID = 'answer'
/**
 * The limits on a surface id and one move. They live here, with the set they
 * protect, so the HTTP route (runtimeRoutes.ts) and the puppet master's table
 * tools validate with the same rules: a hand and a model may ask for exactly
 * the same things, and neither definition can drift from the other.
 */
export const SURFACE_ID = /^[\w-]{1,64}$/
export const MAX_MOVE_PX = 10_000
/** The one swipe keyboard on the table (#29). */
export const KEYBOARD_ID = 'keyboard'

export interface AnswerState extends Record<string, unknown> {
  renderId: string
  /** How far the answer has been moved from where it was laid out (StageView panelOffset). */
  offset: { x: number; y: number }
}

/** What a display needs to draw a web surface: the page's own url and title, and where its frames are streamed. */
// A type, not an interface: surface state is a Record, and only type
// aliases are assignable to an index signature.
export type WebSurfaceState = {
  url: string
  title: string
  status: 'loading' | 'ready' | 'error'
  error?: string
  stream: string
}

export function createSurfaceManager(opts: {
  publish: (line: SurfacesLine) => void
  /** The projector until a render says otherwise (see `bounds` below). */
  bounds?: Surface
  /**
   * Closing the answer surface must clear the answer itself (the hub's
   * snapshot), or displays keep drawing it and a reconnect replays it
   * (review #38). The runtime passes the hub's dismiss here.
   */
  onCloseAnswer?: () => void
  /**
   * The keyboard surface left the table, by any path: its own close route,
   * the generic surface close, the operator's close-all, reset or act
   * switch. Its owner (swipeKeyboard.ts) discards the draft here, once for
   * all of them; before, only the keyboard's own route did, and the next
   * person to open it got the last person's half-typed line (review #47).
   */
  onCloseKeyboard?: () => void
}) {
  // The projector the surfaces live on: the one the active answer was laid
  // out for (its scene's surface), so the clamp and the renderer agree. A
  // fixed 1920x1080 here clamped a 960x540 projection's answer off its own
  // table, and pushed a 4K one's answer away from where it is drawn (#38).
  let bounds = opts.bounds ?? DEFAULT_SURFACE
  let set: SurfaceSet = []
  let rev = 0
  // Drawings get their own ids, never reused while the server runs: "draw a
  // star" then "draw a moon" are two things on the table, and the agent can
  // close one by the id it was given.
  let drawings = 0
  const observers = new Set<() => void>()
  // The active answer as the server last saw it: events so far and the scene
  // they were laid out against.
  let answer: { renderId: string; scene: Scene; events: StageEvent[]; laidOut: Box | null } | null = null

  const line = (): SurfacesLine => ({ kind: 'surfaces', rev, surfaces: [...set] })
  /**
   * Publish only real changes. The ops return the same array when nothing
   * changed (a move against the edge, re-raising the top surface), and an
   * answer streams hundreds of events that mostly don't move its panels; a
   * line per event would flood every display for nothing.
   */
  const commit = (next: SurfaceSet) => {
    if (next === set) return false
    set = next
    rev++
    opts.publish(line())
    for (const observer of observers) observer()
    return true
  }
  const get = (id: string) => set.find((s) => s.id === id)
  const offsetOf = (s: TableSurface | undefined) => (s?.state as AnswerState | undefined)?.offset ?? { x: 0, y: 0 }

  const union = (boxes: Box[]): Box | null => {
    if (!boxes.length) return null
    const x0 = Math.min(...boxes.map((b) => b.x))
    const y0 = Math.min(...boxes.map((b) => b.y))
    const x1 = Math.max(...boxes.map((b) => b.x + b.w))
    const y1 = Math.max(...boxes.map((b) => b.y + b.h))
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }
  const same = (a: Box | null, b: Box | null) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)

  return {
    subscribe(observer: () => void) {
      observers.add(observer)
      return () => { observers.delete(observer) }
    },
    list: (): SurfaceSet => set,
    line,

    /**
     * Follow the active render. Only lines the hub's slot accepted arrive
     * here, so a superseded render can't resurrect its answer surface.
     */
    onRenderLine(l: RenderStreamLine) {
      if (l.kind === 'start') {
        if (l.scene?.surface) bounds = l.scene.surface
        answer = { renderId: l.renderId, scene: l.scene ?? { surface: bounds, objects: [] }, events: [], laidOut: null }
        // A new answer is laid out fresh by the model, so any move the last
        // one had is forgotten. It opens on top: it is what was just asked.
        // Until a panel exists it has no area (nothing to hit).
        const state: AnswerState = { renderId: l.renderId, offset: { x: 0, y: 0 } }
        commit(openSurface(set, { id: ANSWER_ID, kind: 'answer', box: { x: 0, y: 0, w: 0, h: 0 }, pinned: false, state }, bounds))
        return
      }
      if (l.kind !== 'event' || !answer || l.renderId !== answer.renderId) return
      answer.events.push(l.event)
      // Text counts: wrapped words change a panel's estimated height, which
      // can move later panels (counted on the recordings in review #38).
      if (l.event.type === 'drop' || l.event.type === 'end') return
      const laidOut = union(resolvePanels(answer.events, answer.scene).map((p) => ({ x: p.placed.x, y: p.placed.y, w: p.placed.w, h: p.placed.h })))
      if (same(laidOut, answer.laidOut) || !laidOut) return
      answer.laidOut = laidOut
      const cur = get(ANSWER_ID)
      if (!cur) return
      const off = offsetOf(cur)
      const placed = updateSurface(set, ANSWER_ID, { box: { ...laidOut, x: laidOut.x + off.x, y: laidOut.y + off.y } }, bounds)
      // The clamp may have stopped the box short of laid-out + offset (a move
      // made while the answer was still empty, then the panels grew). The
      // offset is re-derived from where the box really is, so StageView draws
      // the panels exactly inside the box that is hit-tested (review #38).
      const box = placed.find((x) => x.id === ANSWER_ID)!.box
      const state: AnswerState = { ...(cur.state as AnswerState), offset: { x: box.x - laidOut.x, y: box.y - laidOut.y } }
      commit(updateSurface(placed, ANSWER_ID, { state }, bounds))
    },

    /**
     * Move a surface. For the answer, the distance actually moved (after the
     * clamp) is added to its offset, so StageView shifts its panels by exactly
     * what the window list shows, never by what was asked.
     */
    move(id: string, d: { dx: number; dy: number }): boolean {
      const before = get(id)
      const next = moveSurface(set, id, d, bounds)
      if (next === set || !before) return false
      if (before.kind !== 'answer') return commit(next)
      const moved = next.find((s) => s.id === id)!
      const off = offsetOf(before)
      const state: AnswerState = { ...(before.state as AnswerState), offset: { x: off.x + moved.box.x - before.box.x, y: off.y + moved.box.y - before.box.y } }
      return commit(updateSurface(next, id, { state }, bounds))
    },
    /**
     * Open a webpage as its own surface at a real-world size, centred (#31).
     * The box is what the page is rendered at: the caller reads the clamped
     * box back from the set and opens the browser page at exactly that px
     * size, so a point on the surface is the same point on the page.
     * Returns that box.
     */
    openWeb(id: string, url: string, size: { widthMm: number; heightMm: number }): Box {
      // Whole px: the browser's viewport is whole px, and the box must be
      // exactly it for a surface point to be the page point (review #46: a
      // 614.4 px box over a 614 px page).
      const w = Math.round(size.widthMm / bounds.mmPerPx)
      const h = Math.round(size.heightMm / bounds.mmPerPx)
      const box = { x: Math.round((bounds.widthPx - w) / 2), y: Math.round((bounds.heightPx - h) / 2), w, h }
      const state: WebSurfaceState = { url, title: '', status: 'loading', stream: `/api/web/${id}/stream` }
      commit(openSurface(set, { id, kind: 'web', box, pinned: false, state }, bounds))
      return get(id)!.box
    },
    /**
     * The browser's view of a web surface (url, title, status). A page that
     * reports after its surface closed is ignored: updateSurface skips an id
     * that is no longer in the set, so a slow page can't re-open it.
     */
    updateWeb(id: string, patch: { url: string; title: string; status: WebSurfaceState['status']; error?: string }) {
      const cur = get(id)
      if (!cur || cur.kind !== 'web') return false
      const prev = cur.state as unknown as WebSurfaceState
      const next: WebSurfaceState = { url: patch.url, title: patch.title, status: patch.status, stream: prev.stream, ...(patch.error ? { error: patch.error } : null) }
      // Unchanged state publishes nothing (the host reports after every op).
      if (prev.url === next.url && prev.title === next.title && prev.status === next.status && prev.error === next.error) return false
      return commit(updateSurface(set, id, { state: next }, bounds))
    },
    /**
     * Open (or re-open) a surface the caller laid out itself: the launcher
     * (#33) computes its box and item boxes, this only owns the set. Returns
     * the box as clamped onto the table, since the caller hit-tests in it.
     */
    openLaid(id: string, kind: 'launcher', box: Box, state: Record<string, unknown>): Box {
      commit(openSurface(set, { id, kind, box, pinned: false, state }, bounds))
      return get(id)!.box
    },
    /**
     * Open a library asset as its own surface, at its real-world size,
     * centred on the table (the clamp keeps it on). The state carries
     * everything a display needs to draw it, so displays need no library of
     * their own. One surface per asset: opening it again raises it.
     */
    openAsset(a: { id: string; kind: string; title: string; aspect: number; url: string; widthMm: number; heightMm: number }) {
      // Already open: bring it up where it is. Re-centring it threw away
      // wherever someone had moved it (review #43).
      if (get(`asset-${a.id}`)) return commit(raiseSurface(set, `asset-${a.id}`))
      const w = a.widthMm / bounds.mmPerPx
      const h = a.heightMm / bounds.mmPerPx
      const box = { x: (bounds.widthPx - w) / 2, y: (bounds.heightPx - h) / 2, w, h }
      const state = { assetId: a.id, kind: a.kind, title: a.title, aspect: a.aspect, url: a.url }
      return commit(openSurface(set, { id: `asset-${a.id}`, kind: 'asset', box, pinned: false, state }, bounds))
    },
    /**
     * Open a drawing the agent made (draw_svg), at the physical size it asked
     * for, centred where it asked (table mm) or on the table, clamped on like
     * every surface. `svg` must already be checked and normalised to this
     * box's px (apps/server/drawing.ts openDrawingOnTable); the surface set
     * only owns where it is. Returns the id and the box as clamped.
     */
    openDrawing(d: { svg: string; widthMm: number; heightMm: number; xMm?: number; yMm?: number; title?: string }): { id: string; box: Box } {
      const id = `drawing-${++drawings}`
      const box = drawingBox(d, bounds)
      commit(openSurface(set, { id, kind: 'drawing', box, pinned: false, state: { svg: d.svg, title: d.title ?? '' } }, bounds))
      return { id, box: get(id)!.box }
    },
    raise: (id: string) => commit(raiseSurface(set, id)),
    /**
     * Close a surface. The answer surface *is* the answer: closing it also
     * dismisses the answer (hub snapshot cleared), the one path both the
     * table's dismiss button and the surface route take.
     */
    close(id: string) {
      if (id === ANSWER_ID) {
        // Frees the buffered events. Not what keeps a closed answer away:
        // updateSurface ignores an id that is no longer in the set, so late
        // events of this render can't re-open it either way.
        answer = null
        opts.onCloseAnswer?.()
      }
      if (id === KEYBOARD_ID && get(KEYBOARD_ID)) opts.onCloseKeyboard?.()
      return commit(closeSurface(set, id))
    },

    /**
     * Close everything on the table at once (the operator's "close all",
     * #34). One commit, so displays get one empty set instead of a line per
     * surface. Returns whether the answer was among them: the caller then
     * knows the hub was already dismissed through `onCloseAnswer`, and must
     * not dismiss again (a second empty start would be harmless on screen,
     * but it is a second owner clearing the same answer).
     */
    closeAll(): { closedAnswer: boolean } {
      const closedAnswer = set.some((s) => s.id === ANSWER_ID)
      if (closedAnswer) {
        answer = null
        opts.onCloseAnswer?.()
      }
      if (get(KEYBOARD_ID)) opts.onCloseKeyboard?.()
      // commit() publishes only when the array changes; an already empty
      // table keeps its revision.
      commit(set.length ? [] : set)
      return { closedAnswer }
    },

    /** The projector the boxes are in right now (it follows the active answer's scene). */
    bounds: () => bounds,

    /**
     * Open the swipe keyboard (#29) at `box`, on top, with the focus. Its
     * state is owned by apps/server/swipeKeyboard.ts, which writes it through
     * `setKeyboardState`; this module only keeps it in the set, so the
     * keyboard is hit-tested, stacked and moved like every other surface.
     * Opening an open keyboard raises it where it is: re-placing it would
     * throw away wherever someone moved it (same rule as #43's assets).
     */
    openKeyboard(box: Box, state: Record<string, unknown>) {
      if (get(KEYBOARD_ID)) return commit(raiseSurface(set, KEYBOARD_ID))
      return commit(openSurface(set, { id: KEYBOARD_ID, kind: 'keyboard', box, pinned: false, state }, bounds))
    },
    /** Replace the keyboard's drawn state (text, candidates, sent); a no-op when it is closed. */
    setKeyboardState(state: Record<string, unknown>) {
      return commit(updateSurface(set, KEYBOARD_ID, { state }, bounds))
    },
  }
}

export type SurfaceManager = ReturnType<typeof createSurfaceManager>

/**
 * A drawing's box in px from its size and centre in table mm (the agent's
 * units: AGENTS.md rule 5, physical truth). Without a centre it sits in the
 * middle of the table. Not clamped here: openSurface clamps every box the
 * same way, so a drawing near the edge behaves like any surface pushed there.
 */
export function drawingBox(d: { widthMm: number; heightMm: number; xMm?: number; yMm?: number }, bounds: { widthPx: number; heightPx: number; mmPerPx: number }): Box {
  const w = d.widthMm / bounds.mmPerPx
  const h = d.heightMm / bounds.mmPerPx
  const cx = d.xMm === undefined ? bounds.widthPx / 2 : d.xMm / bounds.mmPerPx
  const cy = d.yMm === undefined ? bounds.heightPx / 2 : d.yMm / bounds.mmPerPx
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}
