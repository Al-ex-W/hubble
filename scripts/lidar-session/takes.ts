/**
 * The guided lidar takes of docs/plans/2026-10-07-lidar-touch.md (R0b–R6), as
 * timelines of spoken/printed cues.
 *
 * Why cues with timestamps at all: a take labelled "taps" by the operator says
 * what was *asked*, not what happened. The cue log gives every instructed action
 * a time on the recorder's own monotonic clock (the same clock as each frame's
 * `receivedAtMonoMs`), so a test can ask "one down near each cue?" without using
 * the touch code as its own oracle. The phone video (clap cue first) is the
 * independent truth of what the person really did; the cues are the protocol.
 *
 * Why fixed rhythms rather than "press Enter when done": one person stands at the
 * table with their hands busy, and the 20-minute hardware window has no room for
 * back-and-forth. A rhythm also makes takes comparable between windows.
 *
 * Marks: nine tape marks in a 3×3 grid over the projection, inset ~15 cm, numbered
 * in reading order as seen by the person at the FRONT edge: 1–3 is the far row
 * (by the lidar on the back edge, per SPEC §2), 7–9 the near row. Mark 2 is the
 * one closest to the lidar, 8 the farthest.
 */

export interface Cue {
  /** Offset from the take's start (after the clap), ms. */
  atMs: number
  /** What the person at the table is told; printed and optionally spoken. */
  say: string
  /** Machine-readable instruction, what tests and the census key on. */
  action: 'clap' | 'clear' | 'tap' | 'hold' | 'release' | 'drag' | 'hover' | 'palm' | 'forearm' | 'two-fingers' | 'two-hands' | 'walk' | 'card' | 'end'
  mark?: number
  /** Card/finger height above the table for hover and beam probes, mm. */
  heightMm?: number
  /** Distance from the lidar along the table for beam probes, mm. */
  distanceMm?: number
}

export interface Take {
  id: string
  /** The scene in words, copied into the manifest: what a later reader needs to trust it. */
  scene: string
  cues: Cue[]
}

/** Builder: cues placed one after another, each with how long it lasts. */
function sequence(steps: (Omit<Cue, 'atMs'> & { ms: number })[]): Cue[] {
  let at = 0
  const out: Cue[] = []
  for (const { ms, ...cue } of steps) {
    out.push({ atMs: at, ...cue })
    at += ms
  }
  out.push({ atMs: at, say: 'Done. Hands off.', action: 'end' })
  return out
}

// The clap opens every take: one sharp event visible in the phone video and
// (if it crosses the beam) in the scans, so video time can be aligned to the
// cue clock afterwards. 3 s leaves time to walk back after pressing start.
const clap = { say: 'Clap once above the table, then hands off.', action: 'clap' as const, ms: 3000 }

const taps = (mark: number) => [
  { say: `Mark ${mark}. Get ready.`, action: 'clear' as const, mark, ms: 1500 },
  // 1 s apart: slower than a person's natural double-tap so each tap is its
  // own down/up at 10 rotations/s, fast enough to keep the take short.
  ...[1, 2, 3].map(() => ({ say: 'Tap.', action: 'tap' as const, mark, ms: 1000 })),
]

export const TAKES: Record<string, Take> = {
  R0b: {
    id: 'R0b',
    scene: 'Beam-height probe: a stiff card held level at 10–50 mm above the table, at 400/800/1200/1400 mm from the lidar along the centre line. Nothing else on the table.',
    // Heights step up from the table: the first height at which the card is
    // seen is the beam height there, read offline from the scans. Four
    // distances show the tilt (datasheet 0–1.5°: the research puts the plane at
    // 30–67 mm, and tilted down it meets the table near 1.15 m, which 1.2 and
    // 1.4 m are there to catch).
    cues: sequence([
      clap,
      ...[400, 800, 1200, 1400].flatMap((distanceMm) => [
        { say: `Card at ${distanceMm / 10} centimetres from the lidar.`, action: 'clear' as const, distanceMm, ms: 3000 },
        ...[10, 20, 30, 40, 50].map((heightMm) => ({ say: `${heightMm / 10} centimetres.`, action: 'card' as const, distanceMm, heightMm, ms: 2000 })),
      ]),
    ]),
  },
  R1: {
    id: 'R1',
    scene: 'Empty table: nothing on it. Nobody touching or leaning on the table.',
    cues: sequence([clap, { say: 'Stay clear of the table.', action: 'clear', ms: 30000 }]),
  },
  R2: {
    id: 'R2',
    scene: 'The demo objects on the table (MiniLab, iPad, notebook) where they stand in the show; nobody touching. Also baseline drift since R1.',
    cues: sequence([clap, { say: 'Stay clear of the table.', action: 'clear', ms: 30000 }]),
  },
  R3: {
    id: 'R3',
    scene: 'People standing and walking at all four edges, hands never on or over the table.',
    cues: sequence([clap, { say: 'Walk around the table. Do not touch it.', action: 'walk', ms: 20000 }]),
  },
  R4: {
    id: 'R4',
    scene: 'Guided taps: index finger, three taps on each of the nine tape marks, one second apart.',
    cues: sequence([clap, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(taps)]),
  },
  R5: {
    id: 'R5',
    scene: 'Press and hold two seconds on marks 2, 5 and 8; then one slow drag from mark 4 to mark 6.',
    cues: sequence([
      clap,
      ...[2, 5, 8].flatMap((mark) => [
        { say: `Mark ${mark}. Get ready.`, action: 'clear' as const, mark, ms: 1500 },
        { say: 'Press and hold.', action: 'hold' as const, mark, ms: 2000 },
        { say: 'Lift.', action: 'release' as const, mark, ms: 1500 },
      ]),
      { say: 'Finger on mark 4.', action: 'clear', mark: 4, ms: 1500 },
      { say: 'Slowly drag to mark 6.', action: 'drag', mark: 4, ms: 4000 },
      { say: 'Lift.', action: 'release', mark: 6, ms: 1500 },
    ]),
  },
  R6: {
    id: 'R6',
    scene: 'Negatives and shapes on mark 5: finger hovering 20/50/100 mm above it (ruler), flat palm resting, forearm along the near edge, two fingers 5 cm apart, two hands on marks 4 and 6.',
    cues: sequence([
      clap,
      ...[20, 50, 100].flatMap((heightMm) => [
        { say: `Finger ${heightMm / 10} centimetres above mark 5, use the ruler.`, action: 'clear' as const, mark: 5, heightMm, ms: 2500 },
        { say: 'Hold still.', action: 'hover' as const, mark: 5, heightMm, ms: 3000 },
      ]),
      { say: 'Flat palm on mark 5.', action: 'clear', mark: 5, ms: 2000 },
      { say: 'Rest it.', action: 'palm', mark: 5, ms: 3000 },
      { say: 'Forearm along the near edge.', action: 'clear', ms: 2000 },
      { say: 'Rest it.', action: 'forearm', ms: 3000 },
      { say: 'Two fingers on mark 5, five centimetres apart.', action: 'clear', mark: 5, ms: 2500 },
      { say: 'Hold.', action: 'two-fingers', mark: 5, ms: 3000 },
      { say: 'One finger on mark 4, one on mark 6.', action: 'clear', ms: 2500 },
      { say: 'Hold.', action: 'two-hands', ms: 3000 },
    ]),
  },
}

export const durationMs = (take: Take) => take.cues[take.cues.length - 1].atMs
