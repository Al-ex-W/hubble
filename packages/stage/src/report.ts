import type { AssetInfo } from './assets.ts'
import type { Attrs, StageEvent } from './protocol.ts'
import { DEFAULT_SURFACE, PANEL_MM, mmFromPx, pxFromMm, typeScale, type Box, type Scene, type Surface } from './scene.ts'
import { clearances, findObject, implicitPanelRequest, objectRect, placePanel, requestedBox, resolveEndpoint, type PanelRequest, type Placement } from './layout.ts'
import { gap, nearestObject, offSurface, overlapFraction, readingOrder, sideOf, type Side } from './geometry.ts'

/**
 * The layout report: everything spatial about one answer, measured.
 *
 * This is what the brain's loop reads to decide whether an answer may be
 * rendered, and what it feeds back to the model when it may not. It judges
 * the box the model *asked for*, not what the guard would quietly fix, so
 * the model learns its own mistake and a corrected answer needs no fixing.
 */

export interface TreeNode {
  id: string
  tag: string
  attrs: Attrs
  body: string
  text: string
  children: TreeNode[]
}

/** Rebuilds the element tree from finished events (no timing involved). */
export function buildTree(events: readonly StageEvent[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>()
  const roots: TreeNode[] = []
  const attach = (n: TreeNode, parent: string | null) => {
    nodes.set(n.id, n)
    if (parent === null) roots.push(n)
    else nodes.get(parent)?.children.push(n)
  }
  for (const e of events) {
    if (e.type === 'open') attach({ id: e.id, tag: e.tag, attrs: e.attrs, body: '', text: '', children: [] }, e.parent)
    else if (e.type === 'piece') attach({ id: e.id, tag: e.tag, attrs: e.attrs, body: e.body, text: '', children: [] }, e.parent)
    else if (e.type === 'text') {
      const n = nodes.get(e.id)
      if (n) n.text += e.text
    }
  }
  return roots
}

// ---- height estimate -------------------------------------------------------
// The server has no browser to measure with, so heights are estimated from
// the type scale and line wrapping. Constants mirror stage-react's styles.css
// (panel padding, gaps, line heights); the estimate is checked against real
// measured heights in the bench.
//
// The chrome (padding, gaps, indents) is physical, like the type: it was
// fixed pixels while the text scaled in mm, so on a projector with more
// pixels the estimate kept the old padding around bigger text. The values are
// the styles.css pixels converted once at DEFAULT_SURFACE, so the estimate is
// unchanged there. styles.css itself still says px; until the renderer reads
// these (one shared panel geometry, Juliusolsson05/hubble#17) the two only
// agree on the default surface.
const mm = (px: number) => mmFromPx(DEFAULT_SURFACE, px)
export const PANEL_CHROME_MM = {
  padTop: mm(26),
  padBottom: mm(30),
  padSide: mm(30),
  /** Between direct children of a panel. */
  gap: mm(16),
  /** Between steps or list items, and between children of a Column. */
  listGap: mm(14),
  /** Between children inside one step. */
  stepGap: mm(8),
  /** A step's number column plus its gap. */
  stepIndent: mm(52),
  /** A list item's bullet indent. */
  itemIndent: mm(26),
  columnGap: mm(28),
  noteInset: mm(60),
  notePadV: mm(24),
  tableRowPad: mm(16),
  equationsPad: mm(8),
  plotCaptionGap: mm(6),
  buttonPad: mm(24 + 4),
  stepMin: mm(32),
} as const

function chrome(surface: Surface) {
  return Object.fromEntries(Object.entries(PANEL_CHROME_MM).map(([k, v]) => [k, pxFromMm(surface, v)])) as Record<keyof typeof PANEL_CHROME_MM, number>
}

const CHAR_EM = 0.52

function linesOf(text: string, fontPx: number, widthPx: number): number {
  const perLine = Math.max(1, Math.floor(widthPx / (fontPx * CHAR_EM)))
  return Math.max(1, Math.ceil(text.trim().length / perLine))
}

function mathHeight(tex: string, mathPx: number): number {
  const tall = /\\frac|\\dfrac|\\sum|\\int|\\lim|\\sqrt/.test(tex)
  return mathPx * (tall ? 2.3 : 1.45)
}

export function estimateHeight(node: TreeNode, widthPx: number, surface: Surface, assets: readonly AssetInfo[] = []): number {
  const t = typeScale(surface)
  const c = chrome(surface)
  const kids = (gapPx: number, w = widthPx) =>
    node.children.reduce((sum, k, i) => sum + estimateHeight(k, w, surface, assets) + (i ? gapPx : 0), 0)
  switch (node.tag) {
    case 'Heading':
      return linesOf(node.body, t.heading, widthPx) * t.heading * 1.25
    case 'Text':
    case 'Item':
      return linesOf(node.text, t.body, widthPx - (node.tag === 'Item' ? c.itemIndent : 0)) * t.body * 1.3
    case 'Note':
      return linesOf(node.text, t.body * 0.9, widthPx - c.noteInset) * t.body * 0.9 * 1.3 + c.notePadV
    case 'Math':
      return mathHeight(node.body, t.math)
    case 'Equations':
      return node.body.split(/\\\\/).reduce((s, row) => s + mathHeight(row, t.math), 0) + c.equationsPad
    case 'Steps':
    case 'List':
      return kids(c.listGap)
    case 'Step':
      return Math.max(c.stepMin, kids(c.stepGap, widthPx - c.stepIndent))
    case 'Table':
      return node.children.length * (t.body * 0.9 * 1.3 + c.tableRowPad)
    case 'Columns': {
      const n = Math.max(1, node.children.length)
      const w = (widthPx - c.columnGap * (n - 1)) / n
      return Math.max(0, ...node.children.map((k) => estimateHeight(k, w, surface, assets)))
    }
    case 'Column':
      return kids(c.listGap)
    case 'Plot':
      return widthPx * (380 / 600) + (node.attrs.label ? t.small * 1.4 + c.plotCaptionGap : 0)
    case 'Button':
      return t.body + c.buttonPad
    case 'Asset': {
      // Drawn at the panel's width with the library's aspect (AssetView), so
      // the guard reserves its real height. An id the library doesn't have
      // never parsed in the first place; 0 is only a safe default.
      const a = assets.find((x) => x.id === node.attrs.id)
      return a ? Math.round(widthPx * a.aspect) : 0
    }
    default:
      return 0
  }
}

export function estimatePanelHeight(children: TreeNode[], panelWidth: number, surface: Surface, assets: readonly AssetInfo[] = []): number {
  const c = chrome(surface)
  const inner = panelWidth - 2 * c.padSide
  const content = children.reduce((s, k, i) => s + estimateHeight(k, inner, surface, assets) + (i ? c.gap : 0), 0)
  return Math.round(c.padTop + c.padBottom + content)
}

// ---- the report ------------------------------------------------------------

export type ProblemCode =
  | 'covers-object'
  | 'overlaps-panel'
  | 'off-surface'
  | 'too-narrow'
  | 'far-from-target'
  | 'unresolved-ref'
  | 'mark-outside-object'
  | 'reading-order'

export interface Problem {
  code: ProblemCode
  /** `error` blocks rendering; `warn` is reported but allowed. */
  severity: 'error' | 'warn'
  /** The panel name (its id attribute) or element id the problem is about. */
  subject: string
  detail: string
}

export interface PanelFact {
  /** Element id from the parser (the Canvas's own id for the implicit panel). */
  node: string
  /** The model's own name for it (Panel id attribute), if any. */
  name?: string
  implicit: boolean
  request: PanelRequest
  /** The flow content inside the panel. */
  children: TreeNode[]
  /** The height everything is placed with: the estimate, or the measured height when that is taller. */
  height: number
  /** What the model asked for, unguarded, at `height`. */
  asked: Box
  /** Where the renderer puts it, and whether the guard could. */
  placed: Placement
  nearest: { id: string; gapPx: number; side: Side } | null
}

export interface LayoutReport {
  panels: PanelFact[]
  problems: Problem[]
  /** True when nothing blocks rendering. */
  ok: boolean
}

const FAR_MM = 150
const OFF_SURFACE_TOLERANCE_MM = mmFromPx(DEFAULT_SURFACE, 4)

/**
 * Canvas children that are drawn on the table itself, not in the Canvas's
 * implicit panel. Exported because StageView splits a Canvas's children by the
 * same rule. It used to keep an identical copy; had the two drifted, the
 * report would verify a layout in which a tag sat in the implicit panel while
 * the renderer drew it on the table (or the other way round). One set, so
 * "what goes in the implicit panel" has one owner.
 *
 * Deliberately not catalog.ts's SPATIAL, which lacks Highlight: see the comment
 * there (changing that list changes the prompt).
 */
export const SPATIAL_TAGS: ReadonlySet<string> = new Set(['Panel', 'Label', 'Arrow', 'Mark', 'Highlight'])

/**
 * The one resolved panel geometry: the brain's report, the renderer and the
 * answer surface's box (apps/server/surfaces.ts, the box hitTest in
 * surfaces.ts then hits) all come from this, so a panel is drawn exactly where
 * the report said it would be, and a tap lands on the box that was verified.
 *
 * Before (#17) the report placed panels with an estimated height while the
 * renderer placed them with a fixed 320 px and then slid them after measuring,
 * so a verified layout could still render overlapping or in another spot.
 *
 * Pure in (events, scene, measured): no placement is remembered between calls,
 * so there is nothing to mutate during a React render.
 *
 * @param measured real heights in surface px by panel `node`, from the
 *   renderer. Only growth *beyond* the estimate is used: while a panel is
 *   still revealing it is shorter than its estimate, and letting that shrink
 *   the box would make every later panel shift as words appear. When content
 *   outgrows the estimate, placement re-runs with the real height, so the
 *   collision check sees the panel as it really is (it may then move to the
 *   nearest clear spot; overlapping is worse than moving). Overflow policy: a
 *   panel taller than the table is capped at the table height by `placePanel`
 *   and the renderer clips the rest; the report already flags that as
 *   `off-surface`, so a verified answer never gets there.
 */
export function resolvePanels(events: readonly StageEvent[], scene: Scene, measured: Readonly<Record<string, number>> = {}): PanelFact[] {
  const { surface } = scene
  const panels: PanelFact[] = []
  for (const root of buildTree(events)) {
    if (root.tag !== 'Canvas') continue
    const flow = root.children.filter((c) => !SPATIAL_TAGS.has(c.tag))
    const entries: { node: TreeNode; children: TreeNode[]; implicit: boolean }[] = []
    if (flow.length) entries.push({ node: root, children: flow, implicit: true })
    for (const c of root.children) if (c.tag === 'Panel') entries.push({ node: c, children: c.children, implicit: false })

    // Panels avoid only the panels of their own Canvas, in written order: an
    // earlier panel never moves because a later one arrived.
    const taken: Box[] = []
    for (const { node, children, implicit } of entries) {
      const a = node.attrs
      const request: PanelRequest = implicit
        ? implicitPanelRequest(a, scene)
        : { x: a.x as number | undefined, y: a.y as number | undefined, w: a.w as number | undefined, near: a.near as string | undefined, side: a.side as PanelRequest['side'] }
      const wGuess = requestedBox(request, scene, 0).w
      const height = Math.max(estimatePanelHeight(children, wGuess, surface, scene.assets), Math.round(measured[node.id] ?? 0))
      const asked = requestedBox(request, scene, height)
      const placed = placePanel(request, scene, taken, height)
      taken.push(placed)
      const near = nearestObject(asked, scene.objects)
      panels.push({
        node: node.id,
        name: implicit ? undefined : typeof a.id === 'string' ? a.id : undefined,
        implicit,
        request,
        children,
        height,
        asked,
        placed,
        nearest: near ? { id: near.object.id, gapPx: Math.round(near.gap), side: sideOf(asked, near.object.box) } : null,
      })
    }
  }
  return panels
}

export function layoutReport(events: readonly StageEvent[], scene: Scene): LayoutReport {
  const { surface } = scene
  const problems: Problem[] = []
  const panels = resolvePanels(events, scene)
  const named = new Map<string, Box>()
  const minW = pxFromMm(surface, PANEL_MM.min)
  const cm = (px: number) => `${Math.round((px * surface.mmPerPx) / 10)} cm`

  for (const root of buildTree(events).filter((r) => r.tag === 'Canvas')) {
    const mine = panels.filter((p) => p.node === root.id || root.children.some((c) => c.id === p.node))
    for (const p of mine) {
      const { request, asked, height: h } = p
      const subject = p.name ? `#${p.name}` : p.implicit ? 'the answer (no Panel)' : `panel ${p.node}`
      if (p.name) named.set(p.name, p.placed)

      if (request.near && !findObject(scene, request.near))
        problems.push({ code: 'unresolved-ref', severity: 'error', subject, detail: `near="${request.near}" is not on the table (objects: ${scene.objects.map((o) => o.id).join(', ') || 'none'})` })
      for (const o of scene.objects) {
        const f = overlapFraction(asked, o.box)
        if (f > 0)
          problems.push({ code: 'covers-object', severity: 'error', subject, detail: `covers ${Math.round(f * 100)}% of itself over "${o.id}" (x ${Math.round(o.box.x)}-${Math.round(o.box.x + o.box.w)}, y ${Math.round(o.box.y)}-${Math.round(o.box.y + o.box.h)})` })
      }
      // Judged against the same edge clearance the guard keeps; a sliver of
      // under a few millimetres is rounding, not a mistake worth a repair.
      const out = offSurface(asked, surface, clearances(surface).edge)
      if (out > pxFromMm(surface, OFF_SURFACE_TOLERANCE_MM))
        problems.push({ code: 'off-surface', severity: 'error', subject, detail: `runs ${Math.round(out)} px past the table edge at x ${Math.round(asked.x)}-${Math.round(asked.x + asked.w)}, y ${Math.round(asked.y)}-${Math.round(asked.y + asked.h)} (estimated height ${h} px; table ${surface.widthPx}x${surface.heightPx})` })
      if (asked.w < minW - 1) problems.push({ code: 'too-narrow', severity: 'warn', subject, detail: `${Math.round(asked.w)} px (${cm(asked.w)}) is below the readable ${Math.round(minW)} px` })
      const target = findObject(scene, request.near)
      if (target && gap(asked, target.box) > pxFromMm(surface, FAR_MM))
        problems.push({ code: 'far-from-target', severity: 'error', subject, detail: `is ${cm(gap(asked, target.box))} from "${target.id}" it should sit beside` })
    }

    // Panels on top of each other, as asked (within one Canvas, like placement).
    for (let i = 0; i < mine.length; i++)
      for (let j = i + 1; j < mine.length; j++) {
        const f = overlapFraction(mine[j].asked, mine[i].asked)
        if (f > 0.02)
          problems.push({ code: 'overlaps-panel', severity: 'error', subject: mine[j].name ? `#${mine[j].name}` : `panel ${mine[j].node}`, detail: `overlaps ${mine[i].name ? `#${mine[i].name}` : `panel ${mine[i].node}`} by ${Math.round(f * 100)}%` })
      }

    // Written order vs the order a person reads them on the table.
    if (mine.length > 1) {
      const written = mine.map((p) => p.node)
      const read = readingOrder(mine.map((p) => ({ id: p.node, box: p.asked })))
      if (written.join() !== read.join())
        problems.push({ code: 'reading-order', severity: 'warn', subject: 'panels', detail: `written order ${written.join(' → ')} reads on the table as ${read.join(' → ')}` })
    }

    // References from marks and arrows.
    const walk = (n: TreeNode) => {
      if (n.tag === 'Mark' || n.tag === 'Highlight') {
        const o = findObject(scene, String(n.attrs.target ?? ''))
        if (!o) problems.push({ code: 'unresolved-ref', severity: 'error', subject: `Mark ${n.id}`, detail: `target="${String(n.attrs.target)}" is not on the table` })
        else if (n.tag === 'Mark') {
          const r = objectRect(o, n.attrs.u as number, n.attrs.v as number, n.attrs.w as number, n.attrs.h as number)
          if (overlapFraction(r, o.box) < 0.6)
            problems.push({ code: 'mark-outside-object', severity: 'warn', subject: `Mark ${n.id}`, detail: `mostly outside "${o.id}" (u ${String(n.attrs.u ?? 0.5)}, v ${String(n.attrs.v ?? 0.5)})` })
        }
      }
      if (n.tag === 'Label' && n.attrs.target && !findObject(scene, String(n.attrs.target)))
        problems.push({ code: 'unresolved-ref', severity: 'error', subject: `Label ${n.id}`, detail: `target="${String(n.attrs.target)}" is not on the table` })
      n.children.forEach(walk)
    }
    walk(root)
    const walkArrows = (n: TreeNode) => {
      if (n.tag === 'Arrow')
        for (const end of ['from', 'to'] as const)
          if (!resolveEndpoint(String(n.attrs[end] ?? ''), scene, named))
            problems.push({ code: 'unresolved-ref', severity: 'error', subject: `Arrow ${n.id}`, detail: `${end}="${String(n.attrs[end])}" names nothing on the table` })
      n.children.forEach(walkArrows)
    }
    walkArrows(root)
  }

  return { panels, problems, ok: !problems.some((p) => p.severity === 'error') }
}
