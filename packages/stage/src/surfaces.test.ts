import { describe, expect, it } from 'vitest'
import type { Surface } from './scene.ts'
import { closeSurface, hitTest, moveSurface, openSurface, raiseSurface, updateSurface, type SurfaceSet, type TableSurface } from './surfaces.ts'

/**
 * Label: synthetic. The oracle is plain rectangle maths written out here
 * (corner sums and comparisons), never the module's own clamp or hit helpers.
 */
const T: Surface = { widthPx: 1000, heightPx: 600, mmPerPx: 1 }
const spec = (id: string, x: number, y: number, w = 100, h = 80, kind: TableSurface['kind'] = 'asset') => ({ id, kind, box: { x, y, w, h }, pinned: false, state: {} })
const byId = (set: SurfaceSet, id: string) => set.find((s) => s.id === id)!

describe('openSurface', () => {
  it('puts a new surface on top and gives it the focus', () => {
    // Break caught: a new window opening underneath what is already there.
    let set: SurfaceSet = []
    set = openSurface(set, spec('a', 10, 10), T)
    set = openSurface(set, spec('b', 20, 20), T)
    expect(byId(set, 'b').z).toBeGreaterThan(byId(set, 'a').z)
    expect(set.filter((s) => s.focused).map((s) => s.id)).toEqual(['b'])
  })

  it('replaces a surface with the same id instead of adding a second one', () => {
    // Break caught: two "answer" surfaces after a second render.
    let set: SurfaceSet = openSurface([], spec('answer', 0, 0, 100, 100, 'answer'), T)
    set = openSurface(set, spec('answer', 50, 50, 100, 100, 'answer'), T)
    expect(set).toHaveLength(1)
    expect(byId(set, 'answer').box).toEqual({ x: 50, y: 50, w: 100, h: 100 })
  })

  it('clamps a box that would open off the table back fully onto it', () => {
    const s = byId(openSurface([], spec('a', 950, 580, 100, 80), T), 'a')
    // Right edge 1000 - 100 = 900, bottom 600 - 80 = 520.
    expect(s.box).toEqual({ x: 900, y: 520, w: 100, h: 80 })
  })
})

describe('moveSurface', () => {
  const base = openSurface([], spec('a', 100, 100, 200, 100), T)
  it('moves by the delta', () => {
    expect(byId(moveSurface(base, 'a', { dx: 30, dy: -40 }, T), 'a').box).toEqual({ x: 130, y: 60, w: 200, h: 100 })
  })
  it('stops at every edge of the table', () => {
    // Break caught: a surface dragged off the projection where no hand can grab it back.
    expect(byId(moveSurface(base, 'a', { dx: -500, dy: 0 }, T), 'a').box.x).toBe(0)
    expect(byId(moveSurface(base, 'a', { dx: 0, dy: -500 }, T), 'a').box.y).toBe(0)
    expect(byId(moveSurface(base, 'a', { dx: 5000, dy: 0 }, T), 'a').box.x).toBe(1000 - 200)
    expect(byId(moveSurface(base, 'a', { dx: 0, dy: 5000 }, T), 'a').box.y).toBe(600 - 100)
  })
  it('does not move a pinned surface', () => {
    const pinned = updateSurface(base, 'a', { pinned: true }, T)
    expect(byId(moveSurface(pinned, 'a', { dx: 30, dy: 30 }, T), 'a').box).toEqual({ x: 100, y: 100, w: 200, h: 100 })
  })
  it('ignores an unknown id and returns the same set', () => {
    expect(moveSurface(base, 'nope', { dx: 1, dy: 1 }, T)).toBe(base)
  })
})

describe('updateSurface', () => {
  it('clamps a new box fully onto the table, like open and move', () => {
    // Review #38: removing this clamp left every test green. Break caught: an
    // answer whose panels grew past the edge published with a box off the table.
    const set = openSurface([], spec('a', 10, 10, 100, 80), T)
    expect(byId(updateSurface(set, 'a', { box: { x: 980, y: -50, w: 100, h: 80 } }, T), 'a').box).toEqual({ x: 900, y: 0, w: 100, h: 80 })
  })
})

describe('raiseSurface and closeSurface', () => {
  const set = [spec('a', 0, 0), spec('b', 50, 50), spec('c', 90, 90)].reduce<SurfaceSet>((s, x) => openSurface(s, x, T), [])
  it('raises to the top and moves the focus there', () => {
    const r = raiseSurface(set, 'a')
    const maxOthers = Math.max(byId(r, 'b').z, byId(r, 'c').z)
    expect(byId(r, 'a').z).toBeGreaterThan(maxOthers)
    expect(r.filter((s) => s.focused).map((s) => s.id)).toEqual(['a'])
  })
  it('closes one surface and leaves the rest', () => {
    expect(closeSurface(set, 'b').map((s) => s.id).sort()).toEqual(['a', 'c'])
  })
  it('never mutates the set it was given', () => {
    const before = JSON.stringify(set)
    raiseSurface(set, 'a')
    closeSurface(set, 'b')
    moveSurface(set, 'c', { dx: 5, dy: 5 }, T)
    expect(JSON.stringify(set)).toBe(before)
  })
})

describe('hitTest', () => {
  // a: 0..100 x 0..80, b: 50..150 x 50..130 (on top), c: 400..500 x 400..480.
  const set = [spec('a', 0, 0), spec('b', 50, 50), spec('c', 400, 400)].reduce<SurfaceSet>((s, x) => openSurface(s, x, T), [])
  it('returns the topmost surface under the point', () => {
    // (60, 60) is inside a and b; b was opened later so it is on top.
    expect(hitTest(set, { x: 60, y: 60 })).toBe('b')
    expect(hitTest(raiseSurface(set, 'a'), { x: 60, y: 60 })).toBe('a')
  })
  it('counts the edges as inside and misses outside', () => {
    expect(hitTest(set, { x: 0, y: 0 })).toBe('a')
    expect(hitTest(set, { x: 500, y: 480 })).toBe('c')
    expect(hitTest(set, { x: 300, y: 300 })).toBeNull()
  })
})

describe('instance: which opening of a surface this is', () => {
  it('moves, raises and updates keep it; a re-open after a close, or over itself, gets a new one', () => {
    // Break caught (manager verification of #49): a hand that grabbed an
    // asset, held while it was closed and reopened, flicked the NEW asset
    // away, because ids are reused. Anything holding a surface holds this.
    let set: SurfaceSet = openSurface([], spec('a', 100, 100, 200, 100), T)
    set = openSurface(set, spec('b', 300, 300), T)
    const first = byId(set, 'a').instance
    set = moveSurface(set, 'a', { dx: 10, dy: 0 }, T)
    set = raiseSurface(set, 'a')
    set = updateSurface(set, 'a', { state: { x: 1 } }, T)
    expect(byId(set, 'a').instance).toBe(first)
    set = closeSurface(set, 'a')
    set = openSurface(set, spec('a', 100, 100, 200, 100), T)
    const reopened = byId(set, 'a').instance
    expect(reopened).not.toBe(first)
    // Re-opened over itself (every new answer): new too.
    set = openSurface(set, spec('a', 100, 100, 200, 100), T)
    expect(byId(set, 'a').instance).not.toBe(reopened)
    // Never reused, even once the set is empty again.
    const seen = new Set([first, reopened, byId(set, 'a').instance, byId(set, 'b').instance])
    const again = byId(openSurface([], spec('a', 0, 0), T), 'a').instance
    expect(seen.has(again)).toBe(false)
  })
})
