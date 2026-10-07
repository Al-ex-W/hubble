import { describe, expect, it } from 'vitest'
import { createStageParser } from './parser.ts'
import { layoutReport, resolvePanels } from './report.ts'
import { intersection } from './geometry.ts'
import { listRecordings, loadRecording } from './testing.ts'
import type { Scene } from './scene.ts'

/**
 * Fixtures: the scene-aware recordings (label: recording), where aixia-labs
 * placed panels itself against a known table. Cases marked "mutation" change
 * one attribute of a recording; no layout is typed by hand.
 */
const parse = (text: string) => {
  const p = createStageParser()
  return [...p.push(text), ...p.end()]
}
const SCENE = listRecordings().filter((n) => n.startsWith('scene-'))
const clean = loadRecording('scene-linear-left') // recorded with a clean report

describe('layoutReport over recorded layouts', () => {
  it('reads every scene-aware recording', () => {
    expect(SCENE.length).toBe(12)
  })

  it.each(SCENE)('%s: every covers-object problem is a real overlap', (name) => {
    // Independent oracle: plain rectangle intersection of the asked box and
    // the object box, not the report's own overlap function.
    const rec = loadRecording(name)
    const r = layoutReport(parse(rec.text), rec.scene!)
    for (const p of r.problems.filter((q) => q.code === 'covers-object')) {
      const panel = r.panels.find((x) => (x.name ? `#${x.name}` : `panel ${x.node}`) === p.subject)!
      const obj = rec.scene!.objects.find((o) => p.detail.includes(`"${o.id}"`))!
      expect(intersection(panel.asked, obj.box)).not.toBeNull()
    }
    expect(r.ok).toBe(!r.problems.some((q) => q.severity === 'error'))
  })

  /**
   * What the report says about each recording, pinned. Each entry was read
   * against the recording when pinned (2026-10-05): crowded and projectile
   * really put a panel on the notebook, integral really points an Arrow at
   * a panel id it never gave, pythagoras really stacks its panels. (The
   * plate and piano recordings were deleted with those kinds, #17.) `placed` is the guard's verdict per panel, so turning
   * off collision avoidance (not only the problem codes) fails here too.
   * Before this, the corpus test only checked that reported overlaps were
   * real, so deleting a whole check still passed. When a recording is added
   * or removed, update this table by reading the new report, not by copying
   * whatever it prints.
   */
  const PINNED: Record<string, { problems: string[]; placed: string[] }> = {
    'scene-crowded': { problems: ['covers-object #steps', 'off-surface #steps'], placed: ['moved'] },
    'scene-empty-compare': { problems: ['off-surface panel e11'], placed: ['as-asked', 'moved'] },
    'scene-empty-pythagoras': { problems: ['overlaps-panel panel e2', 'overlaps-panel panel e7', 'reading-order panels'], placed: ['as-asked', 'moved', 'moved', 'as-asked'] },
    'scene-integral': { problems: ['unresolved-ref Arrow e8'], placed: ['as-asked'] },
    'scene-linear-center': { problems: [], placed: ['as-asked'] },
    'scene-linear-left': { problems: [], placed: ['as-asked'] },
    'scene-linear-right-edge': { problems: [], placed: ['as-asked'] },
    'scene-optimize': { problems: ['overlaps-panel panel e12'], placed: ['as-asked', 'moved'] },
    'scene-planets': { problems: [], placed: ['as-asked'] },
    'scene-projectile': { problems: ['off-surface #steps', 'covers-object #graph', 'reading-order panels'], placed: ['moved', 'no-room'] },
    'scene-quadratic-graph': { problems: [], placed: ['as-asked', 'as-asked'] },
    'scene-study-tips': { problems: [], placed: ['as-asked'] },
  }

  it('pins a diagnosis for every scene recording', () => {
    expect(Object.keys(PINNED).sort()).toEqual([...SCENE].sort())
  })

  it.each(SCENE)('%s: reports exactly the pinned problems and placements', (name) => {
    const rec = loadRecording(name)
    const r = layoutReport(parse(rec.text), rec.scene!)
    expect({ problems: r.problems.map((p) => `${p.code} ${p.subject}`), placed: r.panels.map((p) => p.placed.status) }).toEqual(PINNED[name])
  })

  it('passes the recorded clean layout', () => {
    expect(layoutReport(parse(clean.text), clean.scene!).problems).toEqual([])
  })
})

describe('layoutReport catches what must not render (mutations of a clean recording)', () => {
  const report = (text: string) => layoutReport(parse(text), clean.scene!)
  const codes = (text: string) => report(text).problems.map((p) => p.code)

  it('a panel placed on the notebook', () => {
    const t = clean.text.replace('near="notebook" side="right"', 'x={300} y={400}')
    expect(t).not.toBe(clean.text)
    // Break caught: projecting the answer onto the page the user is reading.
    expect(codes(t)).toContain('covers-object')
    expect(report(t).ok).toBe(false)
  })

  it('a panel off the edge of the table', () => {
    const t = clean.text.replace('near="notebook" side="right"', 'x={1700} y={300}')
    expect(codes(t)).toContain('off-surface')
  })

  it('a panel beside an object that is not there', () => {
    const t = clean.text.replace('near="notebook"', 'near="laptop"')
    expect(codes(t)).toContain('unresolved-ref')
  })

  it('an arrow from a panel nobody named', () => {
    // Recorded failure, 3 of 16 scene recordings: from="#steps" with no Panel id="steps".
    const t = clean.text.replace(/ id="[^"]*"/, '')
    expect(codes(t)).toContain('unresolved-ref')
  })

  it('a panel narrower than reads well', () => {
    // Break caught: the asked width was clamped to the readable minimum
    // before it was judged, so too-narrow could never fire.
    const t = clean.text.replace('w={560}', 'w={250}')
    expect(t).not.toBe(clean.text)
    expect(codes(t)).toContain('too-narrow')
  })

  it('a panel wider than the table', () => {
    // At x=30 the clamped width (1792 px) still fits; what the model asked
    // for (1900 px) runs off the far edge. Break caught: judging the clamped
    // width reported a layout the model never wrote, and passed it.
    const t = clean.text.replace('near="notebook" side="right" w={560}', 'x={30} y={30} w={1900}')
    expect(t).not.toBe(clean.text)
    expect(codes(t)).toContain('off-surface')
  })

  it.each([
    ['a malformed number', '9..00,700'],
    ['a point off the table', '9000,700'],
    ['a negative point', '-20,700'],
  ])('an arrow to %s', (_what, to) => {
    // Recorded coordinate arrow (scene-empty-pythagoras), one endpoint
    // mutated. Break caught: "9..00" parsed to NaN and the off-table point
    // resolved, so the arrow passed the report and drew to nowhere.
    const rec = loadRecording('scene-empty-pythagoras')
    const t = rec.text.replace('from="900,700"', `from="${to}"`)
    expect(t).not.toBe(rec.text)
    const r = layoutReport(parse(t), rec.scene!)
    expect(r.problems.filter((p) => p.code === 'unresolved-ref' && p.subject.startsWith('Arrow'))).toHaveLength(1)
  })

  it('an arrow to a malformed point on an object', () => {
    const t = clean.text.replace(/to="notebook@([\d.]+),/, 'to="notebook@$1.5,')
    expect(t).not.toBe(clean.text)
    expect(codes(t)).toContain('unresolved-ref')
  })

  it('two panels on top of each other', () => {
    const t = clean.text.replace('</Canvas>', '<Panel x={603} y={384} w={560}><Heading>Again</Heading></Panel></Canvas>')
    expect(codes(t)).toContain('overlaps-panel')
  })
})

describe('layoutReport is physical, not tied to one projector resolution', () => {
  // Mutation: the same table seen by a projector with twice the pixels (half
  // the mm per pixel). Every recorded scene object and every pixel attribute
  // the model wrote is doubled, so physically nothing moved. Break caught:
  // margins, gaps and panel padding in fixed pixels, which made the same
  // answer read differently (and pass or fail differently) on another
  // projector while the type, already in mm, scaled.
  const K = 2
  const scaleScene = (sc: Scene): Scene => ({
    surface: { widthPx: sc.surface.widthPx * K, heightPx: sc.surface.heightPx * K, mmPerPx: sc.surface.mmPerPx / K },
    objects: sc.objects.map((o) => ({ ...o, box: { x: o.box.x * K, y: o.box.y * K, w: o.box.w * K, h: o.box.h * K } })),
  })
  const scaleText = (t: string) =>
    t
      .replace(/\b(x|y|w)=\{(-?\d+(?:\.\d+)?)\}/g, (_m, k: string, v: string) => `${k}={${Number(v) * K}}`)
      .replace(/\b(from|to)="(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)"/g, (_m, k: string, a: string, b: string) => `${k}="${Number(a) * K},${Number(b) * K}"`)

  it.each(SCENE)('%s: same problems and the same placement, scaled', (name) => {
    const rec = loadRecording(name)
    const base = layoutReport(parse(rec.text), rec.scene!)
    const big = layoutReport(parse(scaleText(rec.text)), scaleScene(rec.scene!))
    expect(big.problems.map((p) => `${p.code} ${p.subject}`)).toEqual(base.problems.map((p) => `${p.code} ${p.subject}`))
    expect(big.panels.length).toBe(base.panels.length)
    big.panels.forEach((p, i) => {
      const b = base.panels[i]
      for (const k of ['x', 'y', 'w', 'h'] as const) {
        // Height estimates round to whole pixels on each surface.
        expect(Math.abs(p.placed[k] - b.placed[k] * K), `${k} of panel ${i}`).toBeLessThanOrEqual(K)
        expect(Math.abs(p.asked[k] - b.asked[k] * K), `${k} of panel ${i}`).toBeLessThanOrEqual(K)
      }
      expect(p.placed.status).toBe(b.placed.status)
    })
  })
})

describe('resolvePanels: the one geometry for report, renderer and hit-testing', () => {
  const rec = loadRecording('scene-optimize') // two panels: #steps beside the notebook, a plot panel at x 980
  const events = parse(rec.text)
  const base = resolvePanels(events, rec.scene!)

  it('is what layoutReport judged', () => {
    expect(layoutReport(events, rec.scene!).panels).toEqual(base)
  })

  it('ignores a panel measured shorter than its estimate', () => {
    // A panel is short while its words are still appearing; letting that
    // shrink the box would shift later panels as each word lands.
    const measured = Object.fromEntries(base.map((p) => [p.node, p.height - 100]))
    expect(resolvePanels(events, rec.scene!, measured)).toEqual(base)
  })

  it('re-checks collisions when a panel grows past its estimate', () => {
    // scene-empty-compare: a comparison panel at y 90 with a second panel
    // below it at y 670. Grown by 150 px the first reaches the second.
    const cmp = loadRecording('scene-empty-compare')
    const ev = parse(cmp.text)
    const [first, second] = resolvePanels(ev, cmp.scene!)
    expect(intersection({ ...first.placed, h: first.height + 150 }, second.placed)).not.toBeNull()
    const grown = resolvePanels(ev, cmp.scene!, { [first.node]: first.height + 150 })
    expect(grown[0].placed.h).toBe(first.height + 150)
    // The later panel moves off the grown one rather than drawing over it.
    expect(intersection(grown[0].placed, grown[1].placed)).toBeNull()
  })

  it('caps a panel taller than the table at the table (overflow policy)', () => {
    const [first] = base
    const huge = resolvePanels(events, rec.scene!, { [first.node]: 5000 })
    expect(huge[0].placed.y).toBeGreaterThanOrEqual(30)
    expect(huge[0].placed.y + huge[0].placed.h).toBeLessThanOrEqual(rec.scene!.surface.heightPx - 30)
  })
})
