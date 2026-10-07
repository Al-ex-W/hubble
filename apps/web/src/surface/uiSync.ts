import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

/**
 * The control panel's mirror on TV 1 (owner, 7 Oct: "when i navigate around
 * the control panel that is on one tv"). The server half is
 * apps/server/operatorUi.ts, which says why the latest poster leads.
 *
 * Two roles, decided once per page load by `?mirror=1`:
 * - the operator's page REPORTS its navigation (mode, active step, the More
 *   drawer, a feed filter) with a debounced POST, and re-posts on any pointer
 *   or key press, so the page last touched becomes the one the TV follows;
 * - the mirror only LISTENS on the SSE stream and never posts, so a TV can't
 *   take the lead from the laptop.
 */
export type OperatorUi = {
  mode: 'show' | 'setup'
  step: string | null
  stepPhase: string | null
  stepText: string | null
  more: boolean
  feed: string | null
  leader: string | null
}

export const EMPTY_UI: OperatorUi = { mode: 'show', step: null, stepPhase: null, stepText: null, more: false, feed: null, leader: null }

export const isMirror = (search: string = globalThis.location?.search ?? '') => new URLSearchParams(search).get('mirror') === '1'

export interface UiSync {
  mirror: boolean
  /** The state to draw in mirror mode (the operator's); the page's own last report otherwise. */
  ui: OperatorUi
  /** Operator pages: merge and publish. A no-op on a mirror. */
  report(patch: Partial<OperatorUi>): void
}

const NOOP: UiSync = { mirror: false, ui: EMPTY_UI, report: () => {} }
export const UiSyncCtx = createContext<UiSync>(NOOP)
/** Outside OperatingSurface (a panel mounted alone in a test) this is a harmless no-op. */
export const useUiSync = () => useContext(UiSyncCtx)

const DEBOUNCE_MS = 120

export function useUiSyncSource(mirror: boolean, initial: Partial<OperatorUi>): UiSync & { touch(): void } {
  const leader = useMemo(() => Math.random().toString(36).slice(2, 10), [])
  const [ui, setUi] = useState<OperatorUi>({ ...EMPTY_UI, ...initial, leader })
  const latest = useRef(ui)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flush = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void fetch('/api/operator/ui', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(latest.current) }).catch(() => {})
    }, DEBOUNCE_MS)
  }, [])

  const report = useCallback(
    (patch: Partial<OperatorUi>) => {
      if (mirror) return
      latest.current = { ...latest.current, ...patch, leader }
      setUi(latest.current)
      flush()
    },
    [mirror, leader, flush],
  )

  useEffect(() => {
    if (!mirror) {
      // Announce this page's state on load: a reload of the laptop page should
      // put the TV back where the laptop is, not where it was.
      flush()
      return () => clearTimeout(timer.current)
    }
    if (typeof EventSource === 'undefined') return
    // EventSource reconnects by itself when the venue Wi-Fi drops; the mirror
    // keeps drawing the last state meanwhile, never an error.
    const source = new EventSource('/api/operator/ui/events')
    source.onmessage = (m: MessageEvent) => {
      try {
        const next = JSON.parse(String(m.data)) as Partial<OperatorUi>
        setUi({ ...EMPTY_UI, ...next })
      } catch {
        // ignore a malformed line
      }
    }
    return () => source.close()
  }, [mirror, flush])

  // Any press on an operator page re-publishes its whole state: that is what
  // makes "the most recent page to interact" the leader.
  const touch = useCallback(() => {
    if (!mirror) flush()
  }, [mirror, flush])

  return { mirror, ui, report, touch }
}
