import type { RenderStreamLine, Scene, StageEvent } from '@hubble/stage'

/** What the projector is showing. */
export interface TableState {
  renderId: string
  /**
   * StageView restarts its animation when this changes. It is not just the
   * render id: a "repeat" tap re-sends the same render, which must play again
   * from the top rather than be ignored as already shown.
   */
  key: string
  events: StageEvent[]
  /** Comes with each render, so marks land on the objects the model was told about. */
  scene?: Scene
}

export const IDLE: TableState = { renderId: 'idle', key: 'idle', events: [] }

/**
 * Fold one SSE line into what the table shows. A `start` replaces everything,
 * and lines from any other render are dropped: the server already sends only
 * the active render, but render ids are what make that hold even across a
 * reconnect that lands mid-handover, so the table never mixes two answers.
 */
export function applyTableLine(state: TableState, line: RenderStreamLine, seq: number): TableState {
  if (line.kind === 'start') return { renderId: line.renderId, key: `${line.renderId}:${seq}`, events: [], scene: line.scene }
  if (line.renderId !== state.renderId) return state
  if (line.kind === 'event') return { ...state, events: [...state.events, line.event] }
  return state
}
