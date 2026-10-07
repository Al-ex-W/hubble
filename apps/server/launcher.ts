import type { Box } from '@hubble/stage'
import type { TableGesture } from './inputs.ts'
import type { SurfaceManager } from './surfaces.ts'

/**
 * The launcher (#33): the table's home. An open palm held still opens it
 * near the hand; picking an item opens that thing; a flick from it or a
 * second open palm closes it.
 *
 * One owner: this module is the only place that reads a wake or a gesture
 * aimed at the launcher. `onGesture` returns whether it took the gesture,
 * and gestures on the launcher's box are always its own, so #32 (moving and
 * dismissing other surfaces) asks here first and a drag on the launcher is
 * never both a pick and a move.
 *
 * The item boxes are laid out here and published in the surface state; the
 * renderer draws exactly those boxes and the pick is tested against exactly
 * those boxes, so what is lit and what is hit can't drift apart.
 */
export const LAUNCHER_ID = 'launcher'

export interface LauncherItem {
  id: string
  label: string
  /** Surface-local px, inside the launcher's box. */
  box: Box
}
export interface LauncherState extends Record<string, unknown> {
  items: LauncherItem[]
}

/** What each item does. Only the items given are shown (plan Decision 4: no greyed-out promises). */
export type LauncherActions = Partial<Record<'ask' | 'keyboard' | 'web' | 'assets' | 'lesson', () => void>>
const ORDER: { id: keyof LauncherActions; label: string }[] = [
  { id: 'ask', label: 'Ask' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'web', label: 'Web' },
  { id: 'assets', label: 'Assets' },
  { id: 'lesson', label: 'Lesson' },
]

// Physical sizes (real table mm), converted through the surface's mm/px so
// the launcher is the same size under any projector (AGENTS.md rule 5).
const ITEM_MM = 64
const GAP_MM = 8
const PAD_MM = 12
/** Space left between the palm and the launcher's bottom edge, so the hand that opened it doesn't cover it. */
const ABOVE_PALM_MM = 40
/**
 * A pick moves less than this between pinch and release. The release's own
 * smear (opening fingers drag the pinch point ~15 mm, gestures.ts) is
 * already kept out of the press by the gesture machine, so this only has to
 * absorb the hold's jitter. Below the keyboard's 24 key-mm tap limit so a
 * short deliberate drag isn't a pick. Not yet checked against a recorded
 * pick on open table (plan ruling).
 */
const PICK_MAX_MM = 15

export function createLauncher(opts: { surfaces: SurfaceManager; actions: LauncherActions }) {
  const { surfaces } = opts
  // The drag in progress, if it started on the launcher (table px).
  let press: { start: { x: number; y: number }; item: string | null } | null = null

  const current = () => surfaces.list().find((s) => s.id === LAUNCHER_ID)
  const available = () => ORDER.filter((o) => typeof opts.actions[o.id] === 'function')
  const inBox = (p: { x: number; y: number }, b: Box) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
  /** The item under a table-px point, or null (also null when the launcher is closed). */
  const itemAt = (p: { x: number; y: number }): string | null => {
    const s = current()
    if (!s || !inBox(p, s.box)) return null
    const local = { x: p.x - s.box.x, y: p.y - s.box.y }
    return (s.state as LauncherState).items.find((i) => inBox(local, i.box))?.id ?? null
  }

  const open = (palm?: { x: number; y: number }) => {
    const items = available()
    if (!items.length) return
    const mm = surfaces.bounds().mmPerPx
    const px = (v: number) => v / mm
    const w = px(PAD_MM * 2 + items.length * ITEM_MM + (items.length - 1) * GAP_MM)
    const h = px(PAD_MM * 2 + ITEM_MM)
    const b = surfaces.bounds()
    // Centred on the palm, its bottom edge above it; without a palm (an
    // older tracker), centred on the table. The manager clamps it on.
    const box = palm ? { x: palm.x - w / 2, y: palm.y - px(ABOVE_PALM_MM) - h, w, h } : { x: (b.widthPx - w) / 2, y: (b.heightPx - h) / 2, w, h }
    const state: LauncherState = {
      items: items.map((it, i) => ({ id: it.id, label: it.label, box: { x: px(PAD_MM + i * (ITEM_MM + GAP_MM)), y: px(PAD_MM), w: px(ITEM_MM), h: px(ITEM_MM) } })),
    }
    surfaces.openLaid(LAUNCHER_ID, 'launcher', box, state)
  }
  const close = () => {
    if (current()) surfaces.close(LAUNCHER_ID)
  }
  const pick = (id: string) => {
    close()
    opts.actions[id as keyof LauncherActions]?.()
  }

  return {
    /** Whether it is open, for state and tests. */
    isOpen: () => current() !== undefined,
    /**
     * One gesture from the hand tracker. Returns true when the launcher took
     * it (the caller must then not act on it as anything else).
     */
    onGesture(g: TableGesture): boolean {
      // A press belongs to the launcher it started on. Closed by any path
      // (the surface route, the operator's close-all), its press goes with
      // it: kept, its release reached a later launcher and closed it from a
      // drag that never touched it (review #48).
      if (press && !current()) press = null
      if (g.type === 'wake') {
        // An open palm toggles: it is the one gesture that means "home".
        if (current()) close()
        else open(g.p)
        return true
      }
      if (!current()) return false
      if (g.type === 'drag-start') {
        if (!inBox(g.p, current()!.box)) return false
        press = { start: g.p, item: itemAt(g.p) }
        return true
      }
      if (g.type === 'drag-move') return press !== null
      if (g.type === 'drag-end') {
        if (!press) return false
        const { start, item } = press
        press = null
        if (g.flick) {
          close()
          return true
        }
        const moved = Math.hypot(g.p.x - start.x, g.p.y - start.y) * surfaces.bounds().mmPerPx
        if (!g.cancelled && item && moved < PICK_MAX_MM && itemAt(g.p) === item) pick(item)
        return true
      }
      if (g.type === 'tap') {
        // A launcher over the projected keyboard: the press started on the
        // keys, so it arrives as a tap, not a drag pair.
        const item = itemAt(g.p)
        if (!item) return false
        pick(item)
        return true
      }
      return false
    },
    close,
  }
}

export type Launcher = ReturnType<typeof createLauncher>
