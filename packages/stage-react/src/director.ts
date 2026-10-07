import type { Attrs, StageEvent } from '@hubble/stage'

/**
 * The director decides *when* each finished piece appears.
 *
 * Recorded answers arrive whole in about a second (0.34–1.34 s), far faster
 * than anyone can read. So the stream's timing is not the show's timing: the
 * director places every unit (a frame, a word, an equation) on a timeline,
 * never earlier than it arrived and never before the previous unit has had its
 * moment. That is what turns a one-second burst into something that looks
 * written for you.
 *
 * Pure and clock-free: callers pass `now`, so replays and tests are exact.
 */

export interface StageNode {
  id: string
  tag: string
  attrs: Attrs
  parent: string | null
  children: string[]
  /** Whole pieces: their complete body (TeX for Math, the label for Button). */
  body: string
  /** words elements: each word with its own reveal time. */
  words: { text: string; revealAt: number }[]
  /** When it becomes visible, in the caller's clock. */
  revealAt: number
  /** How long its entrance animation runs. */
  duration: number
}

export interface DirectorState {
  nodes: Map<string, StageNode>
  roots: string[]
  /** When the last scheduled unit has finished its entrance. */
  settlesAt: number
}

export interface Director {
  push(events: readonly StageEvent[], now: number): void
  readonly state: DirectorState
}

/** Entrance length, and how long the next unit waits after this one starts. */
interface Beat {
  duration: number
  pace: number
}

// Tuned by eye on the bench (/). The ratios matter more than the values: the
// canvas lands before anything is written into it, equations take time
// proportional to their length (a pen is slower on longer lines), and words
// flow quickly enough to read as speech-paced rather than typed.
function beatFor(tag: string, body: string): Beat {
  switch (tag) {
    case 'Canvas':
      // The root is the table itself; only its panels have an entrance.
      return { duration: 0, pace: 0 }
    case 'Panel':
      return { duration: 700, pace: 450 }
    case 'Equations': {
      const duration = Math.min(3600, Math.max(900, 400 + 40 * body.length))
      return { duration, pace: duration * 0.85 }
    }
    case 'Plot':
      return { duration: 1600, pace: 1100 }
    case 'Mark':
    case 'Arrow':
      return { duration: 700, pace: 420 }
    case 'Heading':
      return { duration: 600, pace: 420 }
    case 'Step':
      return { duration: 320, pace: 160 }
    case 'Math': {
      const duration = Math.min(2400, Math.max(700, 350 + 45 * body.length))
      return { duration, pace: duration * 0.8 }
    }
    case 'Button':
      return { duration: 420, pace: 300 }
    case 'Highlight':
      return { duration: 700, pace: 350 }
    default:
      // Structural containers (Steps, List) and words containers (Text,
      // Item) have no entrance of their own; their content does.
      return { duration: 0, pace: 0 }
  }
}

const WORD: Beat = { duration: 280, pace: 70 }

export function createDirector({ speed = 1 }: { speed?: number } = {}): Director {
  const scale = 1 / Math.max(0.05, speed)
  const state: DirectorState = { nodes: new Map(), roots: [], settlesAt: 0 }
  // The earliest time the next unit may start.
  let cursor = Number.NEGATIVE_INFINITY

  const schedule = (arrival: number, beat: Beat) => {
    const start = Math.max(arrival, cursor)
    cursor = start + beat.pace * scale
    state.settlesAt = Math.max(state.settlesAt, start + beat.duration * scale)
    return start
  }

  const attach = (node: StageNode) => {
    state.nodes.set(node.id, node)
    if (node.parent === null) state.roots.push(node.id)
    else state.nodes.get(node.parent)?.children.push(node.id)
  }

  return {
    state,
    push(events, now) {
      for (const e of events) {
        switch (e.type) {
          case 'open': {
            const beat = beatFor(e.tag, '')
            const revealAt = schedule(now, beat)
            attach({ id: e.id, tag: e.tag, attrs: e.attrs, parent: e.parent, children: [], body: '', words: [], revealAt, duration: beat.duration * scale })
            break
          }
          case 'piece': {
            if (e.tag === 'Pause') {
              // A pause is pure timing: it pushes everything after it back,
              // and has nothing to draw.
              const ms = typeof e.attrs.ms === 'number' ? e.attrs.ms : 0
              cursor = Math.max(cursor, now) + ms * scale
              break
            }
            const beat = beatFor(e.tag, e.body)
            const revealAt = schedule(now, beat)
            attach({ id: e.id, tag: e.tag, attrs: e.attrs, parent: e.parent, children: [], body: e.body, words: [], revealAt, duration: beat.duration * scale })
            break
          }
          case 'text': {
            const node = state.nodes.get(e.id)
            if (node) node.words.push({ text: e.text, revealAt: schedule(now, WORD) })
            break
          }
          // close/drop/end change nothing on screen: a closed element simply
          // stops receiving children, and drops are never drawn.
          default:
            break
        }
      }
    },
  }
}
