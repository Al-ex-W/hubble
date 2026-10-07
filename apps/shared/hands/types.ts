/**
 * The one frame format every hand source produces: the live landmarker
 * (landmarker.ts) and the hands lab's recordings (fixtures/), so a recorded
 * take replays through exactly the code the camera feeds. Ported from
 * experiments/hands/src/types.ts (#28).
 *
 * Landmarks are MediaPipe's 21 hand points in IMAGE PIXELS (not its 0..1
 * normalised coordinates), so the camera→table homography is an ordinary
 * pixel homography and recordings from different camera resolutions mix.
 */

export type Pt = { x: number; y: number }

export interface Hand {
  handedness: 'Left' | 'Right'
  score: number
  /** 21 points, MediaPipe order: 0 wrist, 1-4 thumb, 5-8 index, 9-12 middle, 13-16 ring, 17-20 pinky. */
  lm: [number, number][]
}

export interface Frame {
  t: number // ms since the take started
  hands: Hand[]
}

/** What should have happened. Simulated takes know it exactly; recorded takes take it from the prompt. */
export interface Truth {
  /** The word each swipe stroke meant, in order. */
  words?: string[]
  /** Messages that should be sent, in order. */
  sent?: string[]
  wakes?: number
  /** Exact pen-down count when it matters (idle and hover takes: 0). */
  penDowns?: number
  drags?: { flick: boolean }[]
}

export interface TraceMeta {
  source: 'simulated' | 'recorded'
  scenario: string
  /** Free text: the prompt shown, or the simulator's script. */
  label: string
  camera: { w: number; h: number }
  /** Image px of the 4 calibration points, in keyboardCorners() order (calibration.ts). */
  calibration: Pt[]
  /** Which printout: its scale relative to the 44 mm table keyboard. */
  sheet: { name: string; scale: number }
  truth: Truth
  /** Simulated only: noise parameters and whether they were fitted from recordings. */
  noise?: { fitted: boolean; [k: string]: unknown }
  seed?: number
}

export interface Trace {
  meta: TraceMeta
  frames: Frame[]
}
