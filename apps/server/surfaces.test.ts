import { describe, expect, it } from 'vitest'
import { createStageParser, layoutReport, type RenderStreamLine, type StageEvent, type SurfacesLine } from '@hubble/stage'
import { loadRecording } from '@hubble/stage/testing'
import { ANSWER_ID, createSurfaceManager, type AnswerState } from './surfaces.ts'

/**
 * The answer surface follows the render lines the hub accepted.
 * Label: recording (recorded model answers, parsed and replayed line by line).
 * Oracle: layoutReport's panel boxes for the finished answer, unioned with
 * plain min/max in the test, not the manager's own union.
 */
const parse = (text: string): StageEvent[] => {
  const p = createStageParser()
  return [...p.push(text), ...p.end()]
}
function linesOf(name: string, renderId: string) {
  const rec = loadRecording(name)
  const events = parse(rec.text)
  const lines: RenderStreamLine[] = [
    { kind: 'start', renderId, intent: name, model: 'aixia-labs', t: 0, scene: rec.scene ?? undefined },
    ...events.map((event, i): RenderStreamLine => ({ kind: 'event', renderId, t: i + 1, event })),
    { kind: 'done', renderId, t: events.length + 1, answer: rec.text, firstContentMs: 1 },
  ]
  const boxes = layoutReport(events, rec.scene!).panels.map((p) => p.placed)
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const want = { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y }
  return { lines, want }
}
const managed = () => {
  const published: SurfacesLine[] = []
  return { published, m: createSurfaceManager({ publish: (l) => published.push(l) }) }
}
const answerOf = (m: ReturnType<typeof createSurfaceManager>) => m.list().find((s) => s.id === ANSWER_ID)

describe('the answer surface', () => {
  it.each(['scene-crowded', 'scene-linear-center', 'scene-projectile'])('%s: covers exactly where its panels were verified', (name) => {
    const { m } = managed()
    const { lines, want } = linesOf(name, 'r1')
    for (const l of lines) m.onRenderLine(l)
    // Break caught: hit-testing a box that is not where the answer is drawn.
    expect(answerOf(m)?.box).toEqual(want)
    expect(answerOf(m)?.kind).toBe('answer')
  })

  it('publishes on real changes only, not once per streamed event', () => {
    // Break caught: hundreds of identical surfaces lines per answer flooding every display.
    const { m, published } = managed()
    const { lines } = linesOf('scene-crowded', 'r1')
    for (const l of lines) m.onRenderLine(l)
    expect(published.length).toBeLessThan(lines.length / 4)
    expect(published.map((p) => p.rev)).toEqual(published.map((_, i) => i + 1))
  })

  it('a new render replaces the answer and forgets the previous move', () => {
    const { m } = managed()
    for (const l of linesOf('scene-crowded', 'r1').lines) m.onRenderLine(l)
    m.move(ANSWER_ID, { dx: 40, dy: 30 })
    expect((answerOf(m)?.state as AnswerState).offset).not.toEqual({ x: 0, y: 0 })
    const second = linesOf('scene-linear-center', 'r2')
    for (const l of second.lines) m.onRenderLine(l)
    expect(m.list().filter((s) => s.kind === 'answer')).toHaveLength(1)
    expect(answerOf(m)?.state).toEqual({ renderId: 'r2', offset: { x: 0, y: 0 } })
    expect(answerOf(m)?.box).toEqual(second.want)
  })

  it('moving the answer shifts its offset by the distance actually moved, after the clamp', () => {
    // Break caught: panels shifted by the asked distance while the window
    // stopped at the table edge, so the drawing and the hit box disagree.
    const { m } = managed()
    const { lines, want } = linesOf('scene-linear-center', 'r1')
    for (const l of lines) m.onRenderLine(l)
    m.move(ANSWER_ID, { dx: -10_000, dy: 0 })
    const a = answerOf(m)!
    expect(a.box.x).toBe(0)
    expect((a.state as AnswerState).offset).toEqual({ x: -want.x, y: 0 })
  })

  it('ignores lines from a render other than the one it started', () => {
    const { m } = managed()
    const first = linesOf('scene-crowded', 'r1').lines
    m.onRenderLine(first[0])
    const stray = linesOf('scene-projectile', 'other').lines.slice(1)
    for (const l of stray) m.onRenderLine(l)
    expect(answerOf(m)?.box).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })

  it('dismiss closes the answer surface, and late events of that render do not bring it back', () => {
    const { m } = managed()
    const { lines } = linesOf('scene-crowded', 'r1')
    for (const l of lines.slice(0, 20)) m.onRenderLine(l)
    m.close(ANSWER_ID)
    for (const l of lines.slice(20)) m.onRenderLine(l)
    expect(answerOf(m)).toBeUndefined()
  })
})

describe('review #38 regressions', () => {
  it('a move made while the answer is still being written stays consistent once its panels arrive', () => {
    // Review finding 2: move {dy:300} on the empty answer while the model
    // thinks, then the panels arrive and the box is clamped, but the offset
    // stayed 300, so StageView drew the answer below its hit box and off the table.
    const { m } = managed()
    const { lines, want } = linesOf('scene-linear-left', 'r1')
    m.onRenderLine(lines[0])
    m.move(ANSWER_ID, { dx: 0, dy: 300 })
    for (const l of lines.slice(1)) m.onRenderLine(l)
    const a = answerOf(m)!
    const off = (a.state as AnswerState).offset
    // Drawn top = laid-out top + offset must be the box's top, and on the table.
    expect(want.y + off.y).toBe(a.box.y)
    expect(a.box.y + a.box.h).toBeLessThanOrEqual(1080)
  })

  it('clamps against the projector the answer was laid out for, not a fixed 1920x1080', () => {
    // Review finding 3. Label: mechanical mutation of scene-linear-left: the
    // scene's pixel sizes and the Panel's w halved, mm per px doubled.
    const rec = loadRecording('scene-linear-left')
    const s = rec.scene!
    const scene = {
      surface: { widthPx: s.surface.widthPx / 2, heightPx: s.surface.heightPx / 2, mmPerPx: s.surface.mmPerPx * 2 },
      objects: s.objects.map((o) => ({ ...o, box: { x: o.box.x / 2, y: o.box.y / 2, w: o.box.w / 2, h: o.box.h / 2 } })),
    }
    const text = rec.text.replace(/\bw=\{(\d+)\}/g, (_, n) => `w={${Number(n) / 2}}`)
    const events = parse(text)
    expect(layoutReport(events, scene).ok).toBe(true) // still a verified answer
    const boxes = layoutReport(events, scene).panels.map((p) => p.placed)
    const want = { x: Math.min(...boxes.map((b) => b.x)), y: Math.min(...boxes.map((b) => b.y)) }
    const { m } = managed()
    m.onRenderLine({ kind: 'start', renderId: 'r', intent: 'x', model: 'm', t: 0, scene })
    for (const [i, event] of events.entries()) m.onRenderLine({ kind: 'event', renderId: 'r', t: i, event })
    expect(answerOf(m)!.box).toMatchObject(want)
    m.move(ANSWER_ID, { dx: 10_000, dy: 10_000 })
    const a = answerOf(m)!
    expect(a.box.x + a.box.w).toBeLessThanOrEqual(960)
    expect(a.box.y + a.box.h).toBeLessThanOrEqual(540)
  })

  it('closing the answer surface dismisses the answer itself', () => {
    // Review finding 1: closing only the surface left the answer's events in
    // the hub, and the displays kept drawing it.
    let dismissed = 0
    const m = createSurfaceManager({ publish: () => {}, onCloseAnswer: () => dismissed++ })
    for (const l of linesOf('scene-crowded', 'r1').lines) m.onRenderLine(l)
    m.close(ANSWER_ID)
    expect(dismissed).toBe(1)
    expect(answerOf(m)).toBeUndefined()
  })
})

describe('the answer box after every streamed event, not only at the end', () => {
  // Review #38 round 2: a text event can change a panel's estimated height
  // (words wrap) and so the union of panels; skipping text events left the
  // published box stale for a few events in 3 of these 5 recordings, while
  // every final box still came out right. Label: recording. Oracle:
  // layoutReport on the events so far, unioned with plain min/max here.
  const counts: Record<string, number> = { 'scene-crowded': 60, 'scene-linear-center': 36, 'scene-projectile': 72, 'scene-quadratic-graph': 64, 'scene-linear-left': 63 }
  it.each(Object.keys(counts))('%s: the published box is the panels so far after each event', (name) => {
    const rec = loadRecording(name)
    const events = parse(rec.text)
    expect(events.length).toBe(counts[name]) // pinned: a changed corpus must fail loudly
    const { m } = managed()
    m.onRenderLine({ kind: 'start', renderId: 'r', intent: name, model: 'm', t: 0, scene: rec.scene! })
    const stale: number[] = []
    for (const [i, event] of events.entries()) {
      m.onRenderLine({ kind: 'event', renderId: 'r', t: i, event })
      const boxes = layoutReport(events.slice(0, i + 1), rec.scene!).panels.map((p) => p.placed)
      if (!boxes.length) continue
      const x = Math.min(...boxes.map((b) => b.x))
      const y = Math.min(...boxes.map((b) => b.y))
      const want = { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y }
      const got = answerOf(m)!.box
      if (got.x !== want.x || got.y !== want.y || got.w !== want.w || got.h !== want.h) stale.push(i)
    }
    expect(stale).toEqual([])
  })
})

describe('web surfaces in the set (#31)', () => {
  // Label: schema-derived (states shaped as the web host reports them).
  const ready = { url: 'https://en.wikipedia.org/wiki/B', title: 'B', status: 'ready' as const }

  it('the browser state reaches only a web surface, and never re-opens a closed one', () => {
    const { m, published } = managed()
    const { lines } = linesOf('scene-linear-center', 'r1')
    for (const l of lines) m.onRenderLine(l)
    const answerState = answerOf(m)!.state
    // Break caught: a stray id (a bug, or a host report keyed wrong)
    // overwriting the answer's offset with a web page's state.
    expect(m.updateWeb(ANSWER_ID, ready)).toBe(false)
    expect(answerOf(m)!.state).toBe(answerState)
    m.openWeb('web-1', 'https://en.wikipedia.org/wiki/A', { widthMm: 480, heightMm: 300 })
    m.close('web-1')
    const n = published.length
    // Break caught: a slow page reporting after its surface closed and
    // putting it back on the table.
    expect(m.updateWeb('web-1', ready)).toBe(false)
    expect(m.list().some((s) => s.id === 'web-1')).toBe(false)
    expect(published).toHaveLength(n)
  })

  it('publishes a state change once, and nothing for a report that changed nothing', () => {
    const { m, published } = managed()
    m.openWeb('web-1', 'https://en.wikipedia.org/wiki/A', { widthMm: 480, heightMm: 300 })
    expect(m.updateWeb('web-1', ready)).toBe(true)
    const n = published.length
    // Break caught: every input op (the host reports after each) flooding
    // every display with an identical surface line.
    expect(m.updateWeb('web-1', ready)).toBe(false)
    expect(published).toHaveLength(n)
    expect(m.list().find((s) => s.id === 'web-1')!.state).toEqual({ ...ready, stream: '/api/web/web-1/stream' })
  })
})

describe('drawings (draw_svg)', () => {
  // Fixture: schema-derived (draw_svg inputs). Oracle: mm ÷ mm/px, written here.
  const mk = () => createSurfaceManager({ publish: () => {} })
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>'

  it('opens at its physical size, centred on the table unless placed', () => {
    const m = mk()
    const b = m.bounds()
    const { id, box } = m.openDrawing({ svg, widthMm: 200, heightMm: 100 })
    // Break caught: a drawing sized in px or at a fixed size, so "a 600 mm
    // star" and "a 120 mm circle" came out the same.
    expect(box.w).toBeCloseTo(200 / b.mmPerPx, 6)
    expect(box.h).toBeCloseTo(100 / b.mmPerPx, 6)
    expect(box.x + box.w / 2).toBeCloseTo(b.widthPx / 2, 6)
    expect(box.y + box.h / 2).toBeCloseTo(b.heightPx / 2, 6)
    expect(m.list().find((s) => s.id === id)).toMatchObject({ kind: 'drawing', state: { svg, title: '' } })
  })

  it('is placed with its centre at the given table mm, and clamped onto the table', () => {
    const m = mk()
    const b = m.bounds()
    const placed = m.openDrawing({ svg, widthMm: 120, heightMm: 120, xMm: 1043, yMm: 443 })
    // Break caught: xMm/yMm read as the top-left (the circle beside the cup).
    expect((placed.box.x + placed.box.w / 2) * b.mmPerPx).toBeCloseTo(1043, 6)
    expect((placed.box.y + placed.box.h / 2) * b.mmPerPx).toBeCloseTo(443, 6)
    // Break caught: a drawing half off the projection, where no hand can grab it back.
    const edge = m.openDrawing({ svg, widthMm: 300, heightMm: 300, xMm: 0, yMm: 0 }).box
    expect(edge.x).toBeGreaterThanOrEqual(0)
    expect(edge.y).toBeGreaterThanOrEqual(0)
  })

  it('every drawing is its own surface, and each closes on its own', () => {
    const m = mk()
    const a = m.openDrawing({ svg, widthMm: 100, heightMm: 100 }).id
    const c = m.openDrawing({ svg, widthMm: 100, heightMm: 100 }).id
    // Break caught: a second drawing replacing the first ("a star, then a moon").
    expect(a).not.toBe(c)
    expect(m.list().filter((s) => s.kind === 'drawing')).toHaveLength(2)
    m.close(a)
    expect(m.list().map((s) => s.id)).toEqual([c])
  })
})
