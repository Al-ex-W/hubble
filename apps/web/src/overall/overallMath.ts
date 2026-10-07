/**
 * The overall view's two pure helpers, kept out of the component so their
 * tests need no DOM (docs/plans/2026-10-07-overall-view.md).
 */

/** The three displays' native sizes: the projector's is room.config.json's, the TVs' the Pis' (stage scene.ts). */
export const SCREEN: Record<string, { w: number; h: number; label: string }> = {
  'tv-1': { w: 1920, h: 1080, label: 'TV 1' },
  'tv-2': { w: 1920, h: 1080, label: 'TV 2' },
  table: { w: 1920, h: 1200, label: 'Projector' },
}
export const PROJECTOR = SCREEN.table!

/**
 * A pointer position over the (scaled) projector frame → projector px.
 *
 * The overlay covers exactly the scaled iframe, so the mapping is the
 * overlay's own rectangle against the native size, NOT the page's scale
 * constant: the frame is resized by the window and a stored scale would go
 * stale. Clamped, not rejected: a drag that leaves the frame (the pointer is
 * captured) should pin to the edge, where the server's table-inset then calls
 * it "not on the table", rather than error mid-gesture.
 */
export function clientToPx(client: { x: number; y: number }, rect: { left: number; top: number; width: number; height: number }, native = PROJECTOR) {
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  const x = ((client.x - rect.left) / rect.width) * native.w
  const y = ((client.y - rect.top) / rect.height) * native.h
  return { x: Math.min(native.w, Math.max(0, x)), y: Math.min(native.h, Math.max(0, y)) }
}

/** A page choice → the path an iframe loads: the room's own PAGE_PATH, so the frame loads exactly what the real display would. */
export const pathFor = (page: string, paths: Record<string, string>): string | null => (page === 'off' ? null : (paths[page] ?? null))

export interface Px {
  x: number
  y: number
}
type Post = (body: { id: string; phase: 'down' | 'move' | 'up'; px?: Px }) => Promise<{ ok: boolean }>

/**
 * The page's side of one simulated finger: SEQUENCED requests (down, moves,
 * up reach the server in the order they happened, or an `up` could overtake a
 * `move` and leave the finger on the table) with MOVES COALESCED (a fast drag
 * makes hundreds of events; only the latest position matters, and at most one
 * move is ever waiting). `up` is never dropped. While down, the last position
 * is re-sent on a timer: the server releases a pointer it hears nothing from
 * (a closed tab can't leave a finger down), so a motionless hold must still
 * speak.
 */
export function createPointerClient(post: Post, o: { keepaliveMs?: number; setTimer?: typeof setInterval; clearTimer?: typeof clearInterval } = {}) {
  let id: string | null = null
  let last: Px | null = null
  let chain: Promise<unknown> = Promise.resolve()
  let pendingMove: Px | null = null
  let ka: ReturnType<typeof setInterval> | null = null
  const set = o.setTimer ?? setInterval
  const clear = o.clearTimer ?? clearInterval
  const enqueue = (body: Parameters<Post>[0]) => {
    chain = chain.then(() => post(body)).catch(() => undefined)
  }
  const flushMove = () => {
    if (!id || !pendingMove) return
    const px = pendingMove
    pendingMove = null
    enqueue({ id, phase: 'move', px })
  }
  const stopKeepalive = () => {
    if (ka) clear(ka)
    ka = null
  }
  return {
    down(px: Px) {
      if (id) return
      id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      last = px
      pendingMove = null
      enqueue({ id, phase: 'down', px })
      ka = set(() => {
        if (id && last) {
          pendingMove = last
          flushMove()
        }
      }, o.keepaliveMs ?? 500)
    },
    move(px: Px) {
      if (!id) return
      last = px
      // Coalesce: if a move is already queued behind the chain, just replace it.
      const waiting = pendingMove !== null
      pendingMove = px
      if (!waiting) chain = chain.then(() => flushMove()).catch(() => undefined)
    },
    up() {
      if (!id) return
      const mine = id
      stopKeepalive()
      pendingMove = null
      id = null
      last = null
      enqueue({ id: mine, phase: 'up' })
    },
    isDown: () => id !== null,
    position: () => last,
    idle: () => chain,
  }
}
