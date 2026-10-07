import { describe, expect, it } from 'vitest'
import { createFeed, differ, spatialFacts } from './feed.ts'

describe('activity feed', () => {
  // Catches: lines appended in arrival order. The operator poll lands up to 2 s
  // after a stage event that happened later, so two sources must merge by time.
  it('merges two sources into one time-ordered log', () => {
    const f = createFeed()
    f.push('stage', 'answer started', 1000)
    f.push('stage', 'answer done', 3000)
    f.push('operator', 'act: lesson', 2000) // the late poll
    f.push('input', 'MIDI key 60 down', 4000)
    expect(f.lines().map((l) => [l.channel, l.at])).toEqual([
      ['stage', 1000],
      ['operator', 2000],
      ['stage', 3000],
      ['input', 4000],
    ])
  })

  // Catches: an unbounded log growing for the whole demo day.
  it('keeps only the newest lines', () => {
    const f = createFeed(3)
    for (let i = 0; i < 5; i++) f.push('input', `k${i}`, i)
    expect(f.lines().map((l) => l.text)).toEqual(['k2', 'k3', 'k4'])
  })

  // Catches: spatial logging every frame instead of only changes.
  it('logs spatial facts only when they change', () => {
    const out: string[] = []
    const log = differ((t) => out.push(t))
    const frame = { touchEnabled: false, reason: 'no baseline', camera: { source: 'room', state: 'receiving', sources: [{ id: 'room', fps: 29 }] }, lidar: { health: { state: 'receiving' }, baseline: { state: 'none' }, touches: [] }, calibration: { revision: 2 }, calibrated: true }
    log(spatialFacts(frame))
    const first = out.length
    log(spatialFacts({ ...frame, camera: { ...frame.camera, sources: [{ id: 'room', fps: 31 }] } }))
    expect(out.length).toBe(first)
    log(spatialFacts({ ...frame, touchEnabled: true }))
    expect(out.slice(first)).toEqual(['touch: enabled'])
  })
})
