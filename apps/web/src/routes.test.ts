import { describe, expect, it } from 'vitest'
import { pageFor } from './routes.ts'

describe('pageFor', () => {
  it('shows the bench only at the root, and nothing at an unknown path', () => {
    // Break caught: unknown paths falling through to the bench again. A room
    // display pointed at a path nobody serves then shows a full bench, and the
    // bench's own room panel frames that bench, whose default scene overwrites
    // the real bench's in the emulator (review of #61).
    expect(pageFor('/')).toBe('bench')
    expect(pageFor('/table')).toBe('table')
    expect(pageFor('/operator')).toBe('to-bench')
    // Break caught: the spatial workbench going blank once routing moved to
    // routes.ts (#67), which shows nothing at any path it doesn't name.
    expect(pageFor('/spatial')).toBe('spatial')
    // Break caught: the iPad camera page blank (#91); the iPad on its stand
    // would show nothing and send nothing, with no error to read.
    expect(pageFor('/ipad-camera')).toBe('ipad-camera')
    // (/hubble is NOT here: on alex/aixia-sim it is the owner's orb, asserted below.)
    expect(pageFor('/tabel')).toBe('none')
    // Break caught: the overall view (all three screens + touch sim) not routed, or matching by prefix.
    expect(pageFor('/overall')).toBe('overall')
    expect(pageFor('/overall/x')).toBe('none')
  })

  it('serves the owner-branch orb and Studio at their own named paths only', () => {
    // Break caught: the merge dropping /hubble, /studio or /studio/projector
    // (they were routed by main.tsx's pathname checks before routes.ts owned
    // routing), or a prefix match letting /studiox through.
    expect(pageFor('/hubble')).toBe('hubble')
    expect(pageFor('/studio')).toBe('studio')
    expect(pageFor('/studio/projector')).toBe('studio-projector')
    expect(pageFor('/studiox')).toBe('none')
    // Break caught: /lab dropped from routes.ts (blank page) or matched by prefix (/labs).
    expect(pageFor('/lab')).toBe('lab')
    expect(pageFor('/labs')).toBe('none')
  })

  it('serves the TV page at /tv only', () => {
    // Break caught: /tv missing (the room TVs show a blank page) or prefix-matched (/tvx).
    expect(pageFor('/tv')).toBe('tv')
    expect(pageFor('/tvx')).toBe('none')
    // Break caught: TV 2's data wall blank (apps/server/displays.ts points tv-2 at /datawall).
    expect(pageFor('/datawall')).toBe('datawall')
  })

  it('sends the old /operator page to the bench, which carries the show controls now', () => {
    // Break caught: /operator going blank after the merge (#66). It is the
    // address on the show laptop's bookmarks and in older docs; blank there
    // reads as "the show controls are gone" seconds before an act.
    expect(pageFor('/operator')).toBe('to-bench')
  })
})
