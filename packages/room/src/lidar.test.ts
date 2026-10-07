import { describe, expect, it } from 'vitest'
import { buildBaseline, blobs, createTouchTracker, type Pose } from './lidar.ts'
import { simulateScan, type SimShape } from './simulate.ts'

/**
 * Label: synthetic. Scans come from the C1 model in simulate.ts (datasheet
 * noise, resolution, pitch, occlusion) until the room is recorded on Tuesday.
 * The room in these tests is the spec's: a 1.5 m table, lidar at the middle of
 * the back edge looking into the table, TV stands and a person beyond it.
 */
const pose: Pose = { x: 750, y: 5, rotation: 0 }
const surroundings: SimShape[] = [
  { kind: 'rect', x: -650, y: 600, w: 60, h: 300, heightMm: 900 }, // TV stand, left
  { kind: 'rect', x: 2090, y: 600, w: 60, h: 300, heightMm: 900 }, // TV stand, right
  { kind: 'rect', x: 600, y: 1650, w: 300, h: 250, heightMm: 1700 }, // the user, beyond the front edge
]
// A finger pressing the cloth, rising to the hand: the beam meets it somewhere
// up to ~90 mm. Modelled as a column that tall. Recorded finding: with the
// C1 tilted up 1.5°, the beam is ~67 mm above the cloth at the user's edge,
// so a 60 mm finger model went undetected there — on site, measure the beam
// height at the far edge with a card and ask for the lidar to be levelled.
const finger = (x: number, y: number): SimShape => ({ kind: 'circle', x, y, r: 9, heightMm: 90 })

function empty(pitchDeg: number, n = 30) {
  return Array.from({ length: n }, (_, i) => simulateScan(surroundings, { pose, pitchDeg, seed: i + 1 }))
}

describe('lidar touches against an empty-table baseline', () => {
  for (const pitchDeg of [0, 1.5, -0.6]) {
    it(`finds a fingertip near and far with ${pitchDeg}° pitch, and nothing on an empty table`, () => {
      const base = buildBaseline(empty(pitchDeg))
      // Empty table: no phantom touches from stands, people or the cloth.
      for (let i = 0; i < 10; i++) expect(blobs(simulateScan(surroundings, { pose, pitchDeg, seed: 100 + i }), pose, base)).toEqual([])
      for (const [x, y] of [
        [750, 300],
        [300, 900],
        [1200, 1400], // the user's edge: farthest from the lidar, ~19 mm point spacing
      ]) {
        const found = blobs(simulateScan([...surroundings, finger(x, y)], { pose, pitchDeg, seed: 9 }), pose, base)
        expect(found.length).toBe(1)
        // Break caught: touches more than the C1's accuracy away from the finger.
        expect(Math.hypot(found[0].x - x, found[0].y - y)).toBeLessThan(45)
      }
    })
  }

  it('turns blobs into down/move/up, ignoring a single noisy return', () => {
    const base = buildBaseline(empty(0))
    const track = createTouchTracker()
    const phases: string[] = []
    const scan = (shapes: SimShape[], seed: number) => blobs(simulateScan([...surroundings, ...shapes], { pose, seed }), pose, base)
    phases.push(...track.update(scan([finger(700, 700)], 1)).map((t) => t.phase)) // seen once: not yet a touch
    phases.push(...track.update(scan([finger(702, 700)], 2)).map((t) => t.phase)) // confirmed: down
    phases.push(...track.update(scan([finger(720, 705)], 3)).map((t) => t.phase)) // move
    phases.push(...track.update(scan([], 4)).map((t) => t.phase)) // one miss: still down
    phases.push(...track.update(scan([], 5)).map((t) => t.phase)) // second miss: up
    expect(phases).toEqual(['down', 'move', 'up'])
  })
})

describe('lidar and a physical keyboard (integration, synthetic)', () => {
  // A full-size keyboard at the user's edge: ~45 x 14 cm, ~30 mm tall.
  const keyboard: SimShape = { kind: 'rect', x: 525, y: 1240, w: 450, h: 140, heightMm: 30 }
  const scene = [...surroundings, keyboard]
  // The keyboard is on the table before calibration, so it is part of the empty-table baseline.
  const base = buildBaseline(Array.from({ length: 30 }, (_, i) => simulateScan(scene, { pose, seed: i + 1 })))

  it('cannot see fingers swiping across the keys: the keyboard hides them', () => {
    const track = createTouchTracker()
    let touches = 0
    // A swipe across the top row, finger tip on the keys (beam ~30 mm hits the keyboard's back edge first).
    for (let i = 0; i < 12; i++) {
      const f: SimShape = { kind: 'circle', x: 560 + i * 32, y: 1275, r: 9, heightMm: 90 }
      touches += track.update(blobs(simulateScan([...scene, f], { pose, seed: 200 + i }), pose, base)).length
    }
    // Recorded design consequence (#9): swipes come from the camera
    // fingertip; the lidar can only confirm contact on the open cloth.
    expect(touches).toBe(0)
  })

  it('still tracks a finger dragging across the open cloth next to the keyboard', () => {
    const track = createTouchTracker()
    const all: { id: number; x: number; y: number; phase: string }[] = []
    for (let i = 0; i < 12; i++) {
      const f: SimShape = { kind: 'circle', x: 200 + i * 25, y: 1100, r: 9, heightMm: 90 }
      all.push(...track.update(blobs(simulateScan([...scene, f], { pose, seed: 300 + i }), pose, base)))
    }
    // Exactly one touch: no phantom from the keyboard's edge flickering in the noise.
    expect(new Set(all.map((t) => t.id)).size).toBe(1)
    const path = all.filter((t) => t.phase !== 'up')
    expect(path.length).toBeGreaterThanOrEqual(10)
    // The tracked stroke follows the real one within the C1's accuracy, and moves forward.
    for (const p of path) expect(Math.abs(p.y - 1100)).toBeLessThan(45)
    expect(path.at(-1)!.x - path[0].x).toBeGreaterThan(200)
  })
})
