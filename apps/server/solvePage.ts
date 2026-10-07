import type { Express } from 'express'
import { z } from 'zod'
import type { TaskRead, TaskReader } from './readTask.ts'

/**
 * "Solve the page": read what lies on the table and ask for its answer, in
 * one press (owner, 7 Oct: "how do we use the math reading detection now and
 * make it solve the thing on the screen?"). Plan: docs/plans/2026-10-07-solve-page.md.
 *
 * This file is the ONE owner of "which text gets solved": the HTTP route
 * (the step runner's Run button, the CLI, the room's buttons) and the puppet
 * master's read_page tool both call `readForSolve`, so a spoken "solve this"
 * and a pressed Run can never pick different problems from the same read.
 *
 * Why it doesn't read the page itself: readTask.ts owns the camera, the crop,
 * the two models, their hedging and the trust rule (both agree). Here we only
 * add the time budget and the choice of text.
 */

/**
 * The whole read must be done in 8 s, or the operator stands in silence in
 * front of the audience (owner's brief). readTask hedges each model at 4 s but
 * its deadline is 15 s; past 8 s we stop waiting and use the iPad's problem.
 * The read keeps running in the background and its result still lands in
 * `reader.last()`, so the next press (or a follow-up render) can use it.
 */
export const SOLVE_READ_BUDGET_MS = 8000

/** Where the solved text came from. `ipad` is the worksheet's shown problem (our manifest), the fallback. */
export type SolveSource = 'camera' | 'ipad' | 'none'

export interface SolvePick {
  source: SolveSource
  /** The problem text to solve ('' when none). */
  text: string
  /** The intent sent on: "Solve: <text>", or '' when nothing could be read. */
  intent: string
  problems: { n: number; text: string }[]
  /** Why the camera read was not used, for the operator ("the two models disagree…"). */
  note?: string
}

export const NOTHING_READ = "couldn't read the page — ask by typing"

/**
 * Pick the text from a read. A trusted camera read wins; any other source is
 * already readTask's worksheet fallback (or none). `n` picks one problem by its
 * printed number; without it every problem goes (a page with one problem is
 * the common case, and "all of them" lets the brain lay several out side by side).
 */
export function pickProblem(read: Pick<TaskRead, 'source' | 'tasks' | 'error'> | null, worksheet: () => { n: number; text: string }[], n?: number): SolvePick {
  const fromRead = read && read.source !== 'none' && read.tasks.length ? read : null
  const source: SolveSource = fromRead ? (fromRead.source === 'camera' ? 'camera' : 'ipad') : 'none'
  let problems = fromRead ? fromRead.tasks.map((t) => ({ n: t.n, text: t.text })) : []
  // No read at all (timed out): ask the worksheet directly, the same fallback readTask would have used.
  let src = source
  if (!problems.length) {
    problems = worksheet()
    if (problems.length) src = 'ipad'
  }
  const note = read?.error
  if (!problems.length) return { source: 'none', text: '', intent: '', problems: [], note: note ?? NOTHING_READ }
  const chosen = n !== undefined ? problems.filter((p) => p.n === n) : problems
  // Asked for a number the page doesn't have: solve the first rather than nothing;
  // the response's `problems` shows the operator what was there.
  const use = chosen.length ? chosen : problems.slice(0, 1)
  // The worksheet joins an instruction and its maths with " | " (readTask's
  // parser does the same for continuation lines); a person reads that as one sentence.
  const clean = (t: string) => t.replace(/\s*\|\s*/g, ' ').trim()
  const text = use.length === 1 ? clean(use[0]!.text) : use.map((p) => `${p.n}: ${clean(p.text)}`).join(' ; ')
  return { source: src, text, intent: `Solve: ${text}`, problems, ...(note && { note }) }
}

export interface SolveDeps {
  reader: TaskReader
  worksheetTasks: () => { n: number; text: string }[]
  budgetMs?: number
}

/** Read the page within the budget and pick the text. Never throws. */
export async function readForSolve(d: SolveDeps, n?: number): Promise<SolvePick & { ms: number }> {
  const t0 = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), d.budgetMs ?? SOLVE_READ_BUDGET_MS)))
  let read: TaskRead | null
  try {
    read = await Promise.race([d.reader.read().catch(() => null), timeout])
  } finally {
    clearTimeout(timer)
  }
  const pick = pickProblem(read ?? { source: 'none', tasks: [], error: `the camera read took over ${(d.budgetMs ?? SOLVE_READ_BUDGET_MS) / 1000} s` }, d.worksheetTasks, n)
  return { ...pick, ms: Date.now() - t0 }
}

/** Where the intent goes once picked: the puppet master if a page listens, else the table brain. */
export type Deliver = (intent: string) => 'puppet' | 'table' | 'none'

const Body = z.object({ n: z.number().int().min(1).max(99).optional() }).default({})

/**
 * POST /api/solve-page {n?} → { source, text, intent, problems, delivered, ms, note? }.
 * Answers as soon as the read is picked and handed on; the answer renders after.
 * A press while one is still reading is refused with 409 (the debounce: the
 * step runner's Run may be double-tapped, and two "Solve:" turns would race
 * each other onto the table).
 */
export function mountSolvePage(app: Express, d: SolveDeps & { deliver: Deliver }) {
  let busy = false
  app.post('/api/solve-page', async (req, res) => {
    const body = Body.safeParse(req.body ?? {})
    if (!body.success) return void res.status(400).json({ error: 'body is { n?: problem number }' })
    if (busy) return void res.status(409).json({ error: 'a solve is already reading the page' })
    busy = true
    try {
      const pick = await readForSolve(d, body.data.n)
      const delivered = pick.intent ? d.deliver(pick.intent) : 'none'
      res.json({ ...pick, delivered })
    } finally {
      busy = false
    }
  })
}
