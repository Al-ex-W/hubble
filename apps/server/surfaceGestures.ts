import { hitTest, type Scene, type SceneObject, type Surface, type SurfaceKind, type SurfaceSet, type TableSurface } from '@hubble/stage'
import { keyboardSceneObject } from '@hubble/stage/swipe'
import type { TableGesture } from './inputs.ts'
import type { SurfaceManager } from './surfaces.ts'

/**
 * What a hand does to the surfaces on the table (#32): the one place that
 * turns gestures into surface operations.
 *
 * The hand tracker (#42) only reports what the hand did (pinch here, dragged
 * there, flicked, tapped), in table px. What that *means* depends on what is
 * under the hand, and only the surface manager knows that. So the decision
 * lives on the server, beside the set, reading the input stream: the bench,
 * the Pi and any future camera can't disagree about which surface a drag
 * grabbed, because none of them decides it.
 *
 * Kind-specific behaviour (a click inside a webpage, a scroll) isn't here: a
 * kind registers a handler, and this module only routes to it with the point
 * in the surface's own px.
 *
 * Built and tested, but no kind registers a handler in the product today
 * (runtime.ts calls createSurfaceGestures with none, and nothing calls `on`).
 * A web page is clicked and scrolled by its own renderer posting
 * /api/web/:id/:op, and the launcher takes its gestures in runtime.ts before
 * they reach here. Kept on purpose: the owner wants hand clicks and scrolls
 * on surfaces back (7 Oct, "this will come back later"), and this is where
 * they land without a second router.
 */

/** A web surface's title strip: a drag that starts here moves it; below it, a drag scrolls the page. */
export const TITLE_STRIP_MM = 30

export interface SurfaceHandler {
  /** A pinch-tap on the surface, at `local` (px from its box's top-left). */
  activate?(s: TableSurface, local: { x: number; y: number }): void
  /** A drag inside the surface that scrolls rather than moves it. */
  scroll?(s: TableSurface, d: { dx: number; dy: number }): void
}

type Grab = {
  /**
   * The opening of the surface that was grabbed (TableSurface.instance, owned
   * by stage's surface ops), never its id: ids are reused (every answer is
   * `answer`, a closed asset reopens as `asset-<id>`), and a grab keyed on
   * the id moved, put back or flicked away whatever was opened in its place
   * while the pinch was held (reviews of #49).
   */
  instance: number
  mode: 'move' | 'scroll' | 'none'
  /** Where the box was when grabbed: a lost hand puts it back here. */
  from: { x: number; y: number }
  last: { x: number; y: number }
}

export function createSurfaceGestures(d: { surfaces: SurfaceManager; handlers?: Partial<Record<SurfaceKind, SurfaceHandler>> }) {
  const handlers: Partial<Record<SurfaceKind, SurfaceHandler>> = { ...d.handlers }
  // One grab at a time: the tracker follows one hand (#42).
  let grab: Grab | null = null
  const get = (id: string) => d.surfaces.list().find((s) => s.id === id) ?? null
  /**
   * The grabbed surface if that opening of it is still on the table;
   * otherwise the grab is over (closed, replaced, closed and reopened) and is
   * dropped, so nothing a stale hand does can reach whatever is there now.
   */
  const held = (): TableSurface | null => {
    if (!grab) return null
    const s = d.surfaces.list().find((x) => x.instance === grab!.instance) ?? null
    if (!s) grab = null
    return s
  }

  const modeFor = (s: TableSurface, p: { x: number; y: number }): Grab['mode'] => {
    if (s.kind === 'web' && handlers.web?.scroll) {
      // Physical, like every size on the table (AGENTS.md rule 5).
      const strip = TITLE_STRIP_MM / d.surfaces.bounds().mmPerPx
      if (p.y > s.box.y + strip) return 'scroll'
    }
    // Pinned: raised (it was touched) but never moved; it was placed on purpose.
    return s.pinned ? 'none' : 'move'
  }

  return {
    /** One gesture; returns whether it was a surface's (taken). */
    handle(g: TableGesture): boolean {
      switch (g.type) {
        case 'drag-start': {
          const id = hitTest(d.surfaces.list(), g.p)
          // Bare table: nothing to grab. Not an error: people rest their hands.
          if (!id) {
            grab = null
            return false
          }
          d.surfaces.raise(id)
          const s = get(id)!
          grab = { instance: s.instance, mode: modeFor(s, g.p), from: { x: s.box.x, y: s.box.y }, last: g.p }
          return true
        }
        case 'drag-move': {
          const cur = held()
          if (!grab || !cur) return false
          const dx = g.p.x - grab.last.x
          const dy = g.p.y - grab.last.y
          grab.last = g.p
          if (grab.mode === 'move') d.surfaces.move(cur.id, { dx, dy })
          else if (grab.mode === 'scroll') handlers[cur.kind]?.scroll?.(cur, { dx, dy })
          return true
        }
        case 'drag-end': {
          const s = held()
          const g0 = grab
          grab = null
          if (!g0 || !s) return false
          if (g0.mode === 'scroll') {
            // The last stretch since the final move still counts. A flick
            // while scrolling is a fling (it scrolls), not a close: the hand
            // was reading the page, not throwing it away.
            const dx = g.p.x - g0.last.x
            const dy = g.p.y - g0.last.y
            if (dx || dy) handlers[s.kind]?.scroll?.(s, { dx, dy })
            return true
          }
          if (g0.mode !== 'move') return true
          if (g.cancelled) {
            // The hand was lost mid-drag: where it vanished is not a place
            // anyone chose (same rule as a lost keyboard press, never typed).
            d.surfaces.move(s.id, { dx: g0.from.x - s.box.x, dy: g0.from.y - s.box.y })
            return true
          }
          // The release point is part of the drag (no move may have reported it).
          d.surfaces.move(s.id, { dx: g.p.x - g0.last.x, dy: g.p.y - g0.last.y })
          if (g.flick) d.surfaces.close(s.id)
          return true
        }
        case 'tap': {
          // Keyboard taps are the keyboard's (presses), not a surface's.
          if (g.region !== 'surface') return false
          const id = hitTest(d.surfaces.list(), g.p)
          if (!id) return false
          d.surfaces.raise(id)
          const s = get(id)!
          handlers[s.kind]?.activate?.(s, { x: g.p.x - s.box.x, y: g.p.y - s.box.y })
          return true
        }
        default:
          // pen-down / pen-move / stroke: keyboard evidence. wake: the launcher (#33).
          return false
      }
    },
    /** Let a kind handle clicks and scrolls. Nothing registers yet (see the header). */
    on(kind: SurfaceKind, h: SurfaceHandler) {
      handlers[kind] = h
    },
    grabbed: () => (grab ? { instance: grab.instance, mode: grab.mode } : null),
  }
}

export type SurfaceGestures = ReturnType<typeof createSurfaceGestures>

/**
 * The surfaces on the table as scene objects, so the next answer is laid out
 * around them, wherever a hand moved them (#32: "the brain is told its new
 * position"). The answer is left out: the next answer replaces it.
 */
export function surfacesAsObjects(set: SurfaceSet): SceneObject[] {
  // The swipe keyboard keeps the object #29 defined for it (keyboardSceneObject:
  // id `swipe-keyboard`, "projected keyboard"), so the model reads the same
  // name whichever path put it there.
  return set.filter((s) => s.kind !== 'answer').map((s) => (s.kind === 'keyboard' ? keyboardSceneObject(s.box) : { id: `surface-${s.id}`, kind: 'other', label: `${s.kind} on the table`, box: { ...s.box } }))
}

/**
 * Scene objects this server adds for surfaces: rebuilt on every render, never
 * trusted from a request (a client's stale copy of the keyboard's box lost to
 * the runtime's, review #47).
 */
const SURFACE_OBJECT = /^(surface-|swipe-keyboard$)/

/**
 * The request a render actually runs: whatever else is on the table (a
 * keyboard, an asset, wherever a hand moved it) goes into the scene, so the
 * answer is laid out around it (#32).
 *
 * Rebuilt from the live set on every render, never carried over: a
 * follow-up (`next`) reuses the previous request, and keeping its surface
 * objects told the brain a closed asset was still in the way (review #49).
 * So every `surface-*` object in the request is dropped first, even when
 * nothing is open now. Everything else in the scene stays exactly as it was
 * (the physical objects, and the asset library: rebuilding the scene from
 * surface + objects alone silently took the library away, review #49).
 * A request with no scene and nothing on the table is returned as asked.
 */
export function withSurfaces<R extends { scene?: Scene }>(asked: R, set: SurfaceSet, bounds: Surface): R {
  const around = surfacesAsObjects(set)
  if (!asked.scene && around.length === 0) return asked
  const scene: Scene = asked.scene ?? { surface: bounds, objects: [] }
  return { ...asked, scene: { ...scene, objects: [...scene.objects.filter((o) => !SURFACE_OBJECT.test(o.id)), ...around] } }
}
