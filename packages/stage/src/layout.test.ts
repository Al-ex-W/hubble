import { describe, expect, it } from 'vitest'
import { DEFAULT_SURFACE, OBJECT_SIZE_MM, pxFromMm, type Box, type Scene } from './scene.ts'
import { clearances, placePanel, resolveEndpoint } from './layout.ts'

/**
 * Scene: an A4 notebook at real size on the default surface (schema-derived
 * from the room spec; the room itself is not recordable until 6 Oct).
 */
const s = DEFAULT_SURFACE
const { edge: EDGE_MARGIN, object: OBJECT_GAP } = clearances(s)
const notebook = { x: 200, y: 330, w: pxFromMm(s, OBJECT_SIZE_MM.notebook.w), h: pxFromMm(s, OBJECT_SIZE_MM.notebook.h) }
const scene: Scene = { surface: s, objects: [{ id: 'notebook', kind: 'notebook', box: notebook }] }
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const inside = (b: Box) =>
  b.x >= EDGE_MARGIN && b.y >= EDGE_MARGIN && b.x + b.w <= s.widthPx - EDGE_MARGIN && b.y + b.h <= s.heightPx - EDGE_MARGIN

describe('placePanel', () => {
  it('honours a valid request exactly', () => {
    // Break caught: the guard "improving" a position the model chose on purpose.
    const p = placePanel({ x: 900, y: 200, w: 560 }, scene, [], 300)
    expect(p).toEqual({ x: 900, y: 200, w: 560, h: 300, status: 'as-asked' })
  })

  it('puts a panel beside the object it is near', () => {
    const p = placePanel({ near: 'notebook', side: 'right', w: 560 }, scene, [], 300)
    expect(p.x).toBe(notebook.x + notebook.w + OBJECT_GAP)
    expect(p.y).toBe(notebook.y)
    expect(overlaps(p, notebook)).toBe(false)
  })

  it('moves a panel off the notebook to the nearest clear spot', () => {
    // Break caught: projecting the answer onto the page the user is reading.
    const p = placePanel({ x: 250, y: 400, w: 560 }, scene, [], 300)
    expect(overlaps(p, notebook)).toBe(false)
    expect(p.status).toBe('moved')
    expect(inside(p)).toBe(true)
  })

  it('keeps a panel on the surface', () => {
    const p = placePanel({ x: 1800, y: 1000, w: 560 }, scene, [], 300)
    expect(inside(p)).toBe(true)
  })

  it('says so explicitly when the table has no room left', () => {
    // A full-height panel as wide as the table cannot avoid the notebook
    // anywhere. Break caught: this came back as an ordinary "adjusted"
    // placement lying on the notebook, indistinguishable from a fine move,
    // so no caller could tell that the guard had failed.
    const p = placePanel({ near: 'notebook', w: 1792 }, scene, [], 2000)
    expect(p.status).toBe('no-room')
    expect(overlaps(p, notebook)).toBe(true)
  })

  it('does not stack a second panel on the first', () => {
    const a = placePanel({ x: 900, y: 200, w: 560 }, scene, [], 300)
    const b = placePanel({ x: 900, y: 200, w: 560 }, scene, [a], 300)
    expect(overlaps(a, b)).toBe(false)
  })
})

describe('resolveEndpoint', () => {
  it('resolves object points, panels and raw coordinates, and refuses unknown ids', () => {
    expect(resolveEndpoint('notebook@0.5,0.25', scene, new Map())).toEqual({
      kind: 'point',
      point: { x: notebook.x + 0.5 * notebook.w, y: notebook.y + 0.25 * notebook.h },
    })
    expect(resolveEndpoint('#steps', scene, new Map([['steps', { x: 1, y: 2, w: 3, h: 4 }]]))).toEqual({ kind: 'box', box: { x: 1, y: 2, w: 3, h: 4 } })
    expect(resolveEndpoint('900, 400', scene, new Map())).toEqual({ kind: 'point', point: { x: 900, y: 400 } })
    // Break caught: an arrow to (0,0) when the model names something absent.
    expect(resolveEndpoint('laptop', scene, new Map())).toBeNull()
    // Break caught: "1..2" matched the number pattern and resolved to NaN.
    expect(resolveEndpoint('1..2,3', scene, new Map())).toBeNull()
    expect(resolveEndpoint('notebook@0..5,0.25', scene, new Map())).toBeNull()
    // A point off the projected surface is not on the table either.
    expect(resolveEndpoint(`${s.widthPx + 1},400`, scene, new Map())).toBeNull()
    expect(resolveEndpoint('notebook@40,0.5', scene, new Map())).toBeNull()
  })
})
