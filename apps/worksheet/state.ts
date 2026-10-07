import type { WorksheetTask } from './tasks.ts'

/**
 * What the iPad shows, and the only place that decides it.
 *
 * Deliberately no position: where the iPad lies on the table is a spatial
 * fact, owned by the spatial service (H41; until it exists,
 * apps/server/ipadPlacement.ts). Keeping it out of here is what stops two
 * places deciding where things are on the table.
 */
export interface WorksheetView {
  /**
   * The problems on the iPad, sorted by their number (`numbers`, same index).
   */
  taskIds: string[]
  tasks: WorksheetTask[]
  /**
   * Each problem's number, decided here and nowhere else: the iPad draws it,
   * the brain is told it ("problem 2: …"), the menu shows it.
   *
   * A number stays with its problem for as long as that problem is shown,
   * whatever else is ticked or unticked; gaps are fine (1, 3). Why: someone
   * at the stand said "problem 2" out loud, and the operator unticking
   * problem 1 must not quietly make "problem 2" mean another one (review of
   * #93, H46's ruling). Before that review the number was the tick order, so
   * unticking 1 renumbered everything after it. A newly ticked problem takes
   * the lowest free number, which keeps numbers within 1–MAX_PICKS.
   */
  numbers: number[]
  /**
   * Bumped on every change. The main server keeps the newest view it has
   * seen and drops older answers that arrive late, so two overlapping
   * changes can't leave the brain told an older sheet than the iPad shows
   * (review of #93: response A held, B applied, A arrives last).
   */
  rev: number
  /**
   * The lowest-numbered problem, kept for readers from before #88 (one task
   * per sheet): an older client still reads a sensible task. Always
   * taskIds[0], never set on its own, so the two can't disagree.
   */
  taskId: string
  task: WorksheetTask
  /** The task's font size (its em) on the iPad, in real mm. */
  textMm: number
}

export type WorksheetPatch = { taskId?: unknown; taskIds?: unknown; textMm?: unknown }

/**
 * At most 4 problems on one sheet. The owner asked for "a couple", the brief
 * for 2–4. The worst four (the three 3-line tasks and a 2-line one, 11 lines)
 * at the default 8 mm text take about 142 mm of the ~180 mm between the
 * title and the ruler on the iPad's 227 mm tall screen; a fifth pushes 8 mm
 * text off it. The page also shrinks text to fit (ipad.js), but that is the
 * safety net, not the plan (plan ruling, #88).
 */
export const MAX_PICKS = 4

/**
 * 4–20 mm: below 4 mm the task is smaller than print, and people at the stand
 * have to read it from a step away; above 20 mm (glyphs about 10 mm wide) even
 * a short equation like "5(2x - 3) = 4x + 9" no longer fits on one line of the
 * iPad's 158 mm wide screen and starts to wrap. 8 mm reads like a clearly
 * handwritten notebook line.
 */
export const TEXT_MM = { min: 4, max: 20, default: 8 } as const

export function createWorksheetState(tasks: WorksheetTask[]) {
  if (tasks.length === 0) throw new Error('worksheet: no tasks in the manifest')
  const listeners = new Set<(v: WorksheetView) => void>()
  /**
   * The new sheet, numbered against the current one: problems still shown
   * keep their numbers, new ones take the lowest free numbers in the order
   * sent, and the result is sorted by number (the iPad's top-to-bottom).
   */
  const sheet = (picked: WorksheetTask[], was: Pick<WorksheetView, 'taskIds' | 'numbers'> | null) => {
    const kept = new Map<string, number>()
    if (was) was.taskIds.forEach((id, i) => kept.set(id, was.numbers[i]!))
    const used = new Set(picked.flatMap((t) => (kept.has(t.id) ? [kept.get(t.id)!] : [])))
    const numbered = picked.map((t) => {
      let n = kept.get(t.id)
      if (n === undefined) {
        n = 1
        while (used.has(n)) n++
        used.add(n)
      }
      return { t, n }
    })
    numbered.sort((a, b) => a.n - b.n)
    const ts = numbered.map((x) => x.t)
    return { taskIds: ts.map((t) => t.id), tasks: ts, numbers: numbered.map((x) => x.n), taskId: ts[0]!.id, task: ts[0]! }
  }
  let view: WorksheetView = { ...sheet([tasks[0]!], null), textMm: TEXT_MM.default, rev: 0 }
  const unknown = () => `unknown task; one of ${tasks.map((x) => x.id).join(', ')}`

  return {
    get: () => view,
    /**
     * All-or-nothing: a patch with one bad field changes nothing, so the
     * operator never ends up with half a change on the iPad and an error on
     * the laptop.
     */
    set(p: WorksheetPatch): { ok: true; view: WorksheetView } | { ok: false; error: string } {
      let next = view
      // Both at once is two answers to one question (which problems?), so it
      // is refused rather than one silently winning.
      if (p.taskId !== undefined && p.taskIds !== undefined) return { ok: false, error: 'send taskId or taskIds, not both' }
      // `taskId` is the pre-#88 shape (Setup's picker still sends it): one
      // problem, the same as a one-element taskIds.
      const ids = p.taskId !== undefined ? [p.taskId] : p.taskIds
      if (ids !== undefined) {
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_PICKS) return { ok: false, error: `taskIds must list 1–${MAX_PICKS} tasks` }
        // A duplicate would number one problem twice: "problem 3" would be
        // problem 1 again, and the brain would be told so.
        if (new Set(ids).size !== ids.length) return { ok: false, error: 'a task is listed twice' }
        const picked = ids.map((id) => tasks.find((x) => x.id === id))
        if (picked.some((t) => !t)) return { ok: false, error: unknown() }
        next = { ...next, ...sheet(picked as WorksheetTask[], view) }
      }
      if (p.textMm !== undefined) {
        if (typeof p.textMm !== 'number' || !Number.isFinite(p.textMm) || p.textMm < TEXT_MM.min || p.textMm > TEXT_MM.max) return { ok: false, error: `textMm must be ${TEXT_MM.min}–${TEXT_MM.max}` }
        next = { ...next, textMm: p.textMm }
      }
      if (next !== view) {
        view = { ...next, rev: view.rev + 1 }
        for (const l of listeners) l(view)
      }
      return { ok: true, view }
    },
    onChange(l: (v: WorksheetView) => void) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
}
