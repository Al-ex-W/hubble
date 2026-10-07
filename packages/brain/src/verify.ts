import {
  PANEL_MM,
  clearances,
  catalogFor,
  createStageParser,
  layoutReport,
  offSurface,
  overlapFraction,
  placePanel,
  pxFromMm,
  type Box,
  type LayoutReport,
  type PanelRequest,
  type Scene,
  type StageEvent,
} from '@hubble/stage'
import { jevNoul, type JevConfig } from './jev.ts'

/**
 * The brain's verification: is this answer allowed onto the table?
 *
 * Deterministic checks first (parse drops, the layout report). Then,
 * optionally, Jev judges the one thing geometry cannot: whether the main
 * panel sits by the object the request is about. The result is written for
 * the model, because it is what the repair agent reads.
 */
export interface Verdict {
  ok: boolean
  events: StageEvent[]
  report: LayoutReport
  /** Problems as the agent sees them, each actionable. */
  problems: string[]
  /** Jev's probability that placement fits the request, when asked. */
  jev?: number
}

/**
 * Parsed with the catalog for this table (catalogFor): with a library, Asset
 * may name exactly the library's ids, and any other id is dropped here, so a
 * verified answer can never ask a display for an asset the server lacks.
 * Without a scene (fixed notice texts) it is the base catalog.
 */
export function parseAnswer(text: string, scene?: Scene): StageEvent[] {
  const p = createStageParser(catalogFor(scene))
  return [...p.push(text), ...p.end()]
}

/**
 * A spot that is actually clear, trying narrower widths when the asked width
 * has no room. Recorded failure (2026-10-05): handing the agent the guard's
 * fallback, which still overlapped the notebook, sent it in circles for three
 * edits. A hint must be valid or not be given.
 *
 * "Clear" is judged on the box the content will really occupy: `placePanel`
 * clamps the height to the table, so content taller than the table used to
 * get a hint that only fit because its bottom had been cut off. `taken` holds
 * every other panel that stays where it is (earlier *and* later ones), plus
 * hints already handed out, so two hints never point at the same spot.
 */
function clearSpot(req: PanelRequest, scene: Scene, taken: Box[], h: number, w0: number): Box | null {
  const { surface } = scene
  const { edge } = clearances(surface)
  const clear = (b: Box) =>
    offSurface(b, surface, edge) === 0 &&
    scene.objects.every((o) => overlapFraction(b, o.box) === 0) &&
    taken.every((t) => overlapFraction(b, t) === 0)
  const minW = pxFromMm(surface, PANEL_MM.min)
  for (let w = w0; w >= minW; w -= 40) {
    // Narrower panels wrap text onto more lines; scale the height estimate
    // with the width so the hint isn't optimistic.
    const hw = Math.round(h * Math.max(1, w0 / w))
    // Narrowing only makes it taller, so once it can't fit it never will.
    if (hw > surface.heightPx - 2 * edge) return null
    const placed = placePanel({ ...req, w }, scene, taken, hw)
    const b = { x: placed.x, y: placed.y, w: placed.w, h: hw }
    if (clear(b)) return b
  }
  return null
}

export async function verifyAnswer(text: string, scene: Scene, intent: string, jev?: JevConfig, signal?: AbortSignal): Promise<Verdict> {
  const events = parseAnswer(text, scene)
  const report = layoutReport(events, scene)
  const problems: string[] = []

  // An answer must say something, completely. Recorded and reviewed cases
  // that used to pass: an empty reply, a bare "Sorry" (stray text, which the
  // parser drops silently), and an answer cut off inside a Panel (the parser
  // closes the frames itself, so the layout looked fine). Each would clear
  // the table and show nothing, or half an answer.
  const end = events.find((e) => e.type === 'end')
  if (end?.type !== 'end' || end.reason !== 'complete')
    problems.push('the answer is cut off: an element was never closed; add the missing closing tags')
  // Any whole piece counts (a Piano or a Mark has no body but is drawn);
  // prose counts only once a real word has arrived.
  const visible = events.some((e) => e.type === 'piece' || (e.type === 'text' && e.text.trim() !== ''))
  if (!visible) problems.push('the answer shows nothing on the table: its content must be inside <Canvas>')

  for (const d of events) {
    // Unclosed or unknown pieces never render; tell the model which.
    if (d.type === 'drop' && d.reason !== 'stray-text') problems.push(`[${d.reason}] ${d.detail}`)
  }
  const subjectOf = (p: (typeof report.panels)[number]) => (p.name ? `#${p.name}` : `panel ${p.node}`)
  const errorsOf = (p: (typeof report.panels)[number]) =>
    report.problems.filter((q) => q.severity === 'error' && (q.subject === subjectOf(p) || (p.implicit && q.subject.startsWith('the answer'))))
  // Every panel that already verifies stays put, so all of them (not just the
  // ones written before the failing panel) are off limits for a hint. Their
  // *asked* box, not `placed`: the guard's placement of a later panel already
  // dodges the failing panel's current spot, so `placed` points away from
  // exactly where the hint would go, and once the repair lands the panel is
  // drawn where it asked.
  const taken: Box[] = report.panels.filter((p) => errorsOf(p).length === 0).map((p) => p.asked)
  for (const p of report.panels) {
    const mine = errorsOf(p)
    if (mine.length === 0) continue
    // Hand the agent a concrete, verified-clear spot; models repair far more
    // reliably from a target than from a description of the problem.
    const hint = clearSpot(p.request, scene, taken, p.asked.h, p.asked.w)
    const who = p.name ? `Panel id="${p.name}"` : p.implicit ? 'the content written directly in Canvas (wrap it in a Panel)' : `the Panel at x=${Math.round(p.asked.x)} y=${Math.round(p.asked.y)}`
    for (const q of mine) problems.push(`${who}: ${q.code}: ${q.detail}`)
    if (hint) {
      taken.push(hint)
      problems.push(`  a valid spot for it: x={${Math.round(hint.x)}} y={${Math.round(hint.y)}} w={${Math.round(hint.w)}} (height follows the content, about ${Math.round(hint.h)} px; panels have no h attribute)`)
    } else {
      taken.push(p.placed)
      problems.push(`  there is no free spot this size: shorten its content (fewer or shorter steps) or move another panel to make room`)
    }
  }
  for (const q of report.problems)
    if (q.severity === 'error' && !q.subject.startsWith('#') && !q.subject.startsWith('panel ') && !q.subject.startsWith('the answer'))
      problems.push(`${q.subject}: ${q.code}: ${q.detail}`)

  let jevScore: number | undefined
  if (problems.length === 0 && jev && scene.objects.length > 0 && report.panels.length > 0) {
    const v = await jevNoul(
      jev,
      {
        request: intent,
        objects: scene.objects.map((o) => ({ id: o.id, box: `x ${Math.round(o.box.x)}-${Math.round(o.box.x + o.box.w)}, y ${Math.round(o.box.y)}-${Math.round(o.box.y + o.box.h)}` })),
        panels: report.panels.map((p) => ({ id: p.name ?? p.node, box: `x ${Math.round(p.placed.x)}-${Math.round(p.placed.x + p.placed.w)}, y ${Math.round(p.placed.y)}-${Math.round(p.placed.y + p.placed.h)}`, nearest: p.nearest?.id, side: p.nearest?.side })),
      },
      'If the request is about an object on the table, is the main answer panel placed directly beside that object? Answer yes if the request is not about any object.',
      signal,
    )
    if (v !== null) {
      jevScore = v
      // Measured: 0.76 for a correct placement vs 0.20 for a wrong one, so
      // only a clear "no" counts; the 0.4-0.6 band is treated as unsure.
      if (v < 0.4) problems.push('placement: the main panel is not beside the object the request is about; move it next to that object')
    }
  }
  return { ok: problems.length === 0, events, report, problems, jev: jevScore }
}
