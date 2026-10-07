import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SURFACE, pxFromMm, type Box, type OverlayShape, type RenderRequest, type Scene, type Surface } from '@hubble/stage'
import { MAX_PICKS } from '../worksheet/state.ts'
import { loadWorksheetTasks, taskText, type WorksheetTask } from '../worksheet/tasks.ts'
import { IPAD_ID, ipadBox } from './ipadPlacement.ts'

/**
 * The main server's side of the iPad worksheet (hubble#60).
 *
 * Three jobs, one owner each:
 * - **the process:** the operator page's checkbox starts and stops
 *   apps/worksheet/server.ts as a child process (the owner: "just a checkbox
 *   … launch [it] and host it for us so we can open it");
 * - **what the iPad shows:** owned by the worksheet server. This file only
 *   asks it, and remembers its last answer;
 * - **the scene:** every render gets the iPad as a real-size `tablet`
 *   object labelled with the exact task, so the brain answers the task the
 *   person sees, laid out beside the iPad and never on it.
 *
 * Why the brain gets text and no photo: the owner's verdict on site was that
 * aixia-labs can't read small print even from a 4K crop. The text comes from
 * our own committed manifest (via apps/worksheet/tasks.ts, the same reader the
 * iPad page's server uses), never from the worksheet server's HTTP answer, so
 * it is trusted and keeps its maths intact. Client labels can't (plainLabel
 * cuts them to 40 chars of letters and digits).
 */

/** What the main server remembers of the worksheet server's last answer. */
export interface WorksheetShown {
  /** The first problem; kept for readers from before #88 (Setup's picker, the status light). */
  taskId: string
  /** Every problem on the iPad, sorted by number (#88). */
  taskIds: string[]
  /** Each problem's number, from the worksheet state (same index); stable while shown (review of #93). */
  numbers: number[]
  textMm: number
  /** The worksheet state's revision: an answer older than the one kept is dropped (review of #93). -1 from an older server. */
  rev: number
}

export interface WorksheetStatus {
  on: boolean
  /** The address to open on the iPad, with the laptop's current LAN IP. */
  url: string | null
  shown: WorksheetShown | null
  ruler: boolean
  error?: string
  tasks: { id: string; task: string }[]
  /** How many problems one sheet takes: the worksheet state's own cap, so the menu can't drift from it (#88). */
  maxPicks: number
}

// The worksheet server is on this laptop and answers in a few ms. A second
// is a hung process, and nothing the operator clicks should wait past it.
const DEADLINE_MS = 1000
// Spawning tsx and loading express takes ~0.5-1.5 s on the demo laptop.
const READY_MS = 8000

const parseShown = (raw: unknown): WorksheetShown | null => {
  const r = raw as { taskId?: unknown; taskIds?: unknown; numbers?: unknown; textMm?: unknown; rev?: unknown } | null
  if (typeof r?.taskId !== 'string' || typeof r.textMm !== 'number') return null
  const rev = typeof r.rev === 'number' ? r.rev : -1
  // A worksheet server from before #88 sends no taskIds: its one task is the
  // whole sheet. One that sends a malformed list is not trusted at all,
  // rather than half-read: the brain must be told exactly what the iPad shows.
  if (r.taskIds === undefined) return { taskId: r.taskId, taskIds: [r.taskId], numbers: [1], textMm: r.textMm, rev }
  if (!Array.isArray(r.taskIds) || r.taskIds.length === 0 || !r.taskIds.every((x) => typeof x === 'string')) return null
  // No numbers (a server from before the #93 review): position, as it was then.
  const numbers = Array.isArray(r.numbers) && r.numbers.length === r.taskIds.length && r.numbers.every((n) => Number.isInteger(n)) ? (r.numbers as number[]) : r.taskIds.map((_, i) => i + 1)
  return { taskId: r.taskId, taskIds: r.taskIds as string[], numbers, textMm: r.textMm, rev }
}

/**
 * The iPad as the brain reads it: one line of the scene list in the prompt
 * (describeScene prints the label verbatim, no length cap), so no newlines.
 *
 * One problem keeps the pre-#88 wording exactly. Several carry the worksheet
 * state's numbers ("problem 2: …"), the same numbers the page draws in the
 * margin, gaps included, which is what makes "solve problem 2" answer the right one. The
 * table agent never sees this: it forwards the user's words as the render's
 * intent, and the render sees the numbers (plan ruling, #88). " ; " between
 * problems because " | " already joins a problem's lines and " ; " never
 * appears in a task.
 */
export function ipadLabel(picked: WorksheetTask[], numbers: number[] = picked.map((_, i) => i + 1)): string {
  if (picked.length === 1) return `iPad worksheet showing the task: ${taskText(picked[0]!)}`
  return `iPad worksheet showing ${picked.length} numbered problems: ${picked.map((t, i) => `problem ${numbers[i]}: ${taskText(t)}`).join(' ; ')}`
}

/** One HTTP call to the worksheet server; every failure is a message, never a throw. */
async function call(url: string, init?: RequestInit): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(DEADLINE_MS) })
    const body = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, error: (body as { error?: string } | null)?.error ?? `worksheet answered ${r.status}` }
    return { ok: true, body }
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === 'TimeoutError' ? `worksheet did not answer in ${DEADLINE_MS} ms` : 'worksheet server unreachable' }
  }
}

export interface WorksheetProcess {
  /** Resolves once the server answers; rejects with a reason when it never does. */
  start(): Promise<void>
  stop(): Promise<void>
  /** Told when the server dies without being stopped, so a crash can't keep steering answers. */
  onDeath?(cb: () => void): void
}

/**
 * The real process: `node tsx apps/worksheet/server.ts`, the same way the
 * main server itself runs. tsx's CLI is resolved from node_modules rather
 * than found on PATH, so it works the same from `npm run dev`, a test, or a
 * shell with no npx.
 */
export function spawnWorksheet(port: number): WorksheetProcess {
  const entry = fileURLToPath(new URL('../worksheet/server.ts', import.meta.url))
  const tsx = createRequire(import.meta.url).resolve('tsx/cli')
  const base = `http://127.0.0.1:${port}`
  let child: ChildProcess | null = null
  let stopping = false
  let died: () => void = () => {}
  // A clean exit of this server takes the child with it here; every other
  // way it dies (tsx watch's SIGTERM on each save, a crash) is covered by
  // the child itself, which exits when its stdin pipe from us ends
  // (WORKSHEET_EXIT_WITH_PARENT in apps/worksheet/server.ts).
  const kill = () => child?.kill()
  process.once('exit', kill)

  const answers = async () => (await call(`${base}/api/state`)).ok
  return {
    async start() {
      // Already up (a main server restarted under it, or started by hand):
      // adopt it rather than fail on a taken port.
      if (await answers()) return
      stopping = false
      const c = spawn(process.execPath, [tsx, entry], { env: { ...process.env, WORKSHEET_PORT: String(port), WORKSHEET_EXIT_WITH_PARENT: '1' }, stdio: ['pipe', 'inherit', 'inherit'] })
      child = c
      // Without a listener, a failed spawn (EAGAIN, EMFILE) is an uncaught
      // 'error' that takes the whole main server down mid-demo.
      c.on('error', (e) => console.error(`[worksheet] ${e.message}`))
      c.once('exit', () => {
        if (child === c) child = null
        if (!stopping) died()
      })
      const until = Date.now() + READY_MS
      while (Date.now() < until) {
        if (!child) throw new Error('worksheet server exited on start (is the port taken?)')
        if (await answers()) return
        await new Promise((r) => setTimeout(r, 150))
      }
      kill()
      throw new Error(`worksheet server not up after ${READY_MS / 1000} s`)
    },
    async stop() {
      stopping = true
      if (child) {
        const c = child
        // A deadline, like every call here: if SIGTERM doesn't end it in a
        // second, SIGKILL does, and the operator's click returns either way.
        await new Promise<void>((r) => {
          const hard = setTimeout(() => {
            c.kill('SIGKILL')
            r()
          }, DEADLINE_MS)
          c.once('exit', () => {
            clearTimeout(hard)
            r()
          })
          c.kill()
        })
        return
      }
      // An adopted server has no handle here; it stops itself on a loopback quit.
      await call(`${base}/api/quit`, { method: 'POST' })
    },
    onDeath(cb) {
      died = cb
    },
  }
}

export interface WorksheetDeps {
  /** Where the worksheet server answers, from this laptop. */
  base: string
  /** Where the iPad opens it: the laptop's LAN address and the port. Null when not on a network. */
  publicUrl: () => string | null
  process: WorksheetProcess
  /** The runtime's ruler light (only the runtime writes overlays). */
  setRuler(box: Box | null): void
  surface?: Surface
  tasks?: WorksheetTask[]
}

export function createWorksheet(d: WorksheetDeps) {
  const tasks = d.tasks ?? loadWorksheetTasks()
  const surface = d.surface ?? DEFAULT_SURFACE
  let on = false
  let starting: Promise<void> | null = null
  // The worksheet server's last answer, kept so a render can read it without
  // awaiting anything. Why no per-render fetch: renderToTable opens its slot
  // in arrival order (latest request wins), and an await before that could
  // let a later request overtake an earlier one. The main server is the only
  // writer the worksheet server has (the operator page goes through here),
  // so its last answer is current.
  let shown: WorksheetShown | null = null
  let ruler = false
  let error: string | undefined
  // Bumped by every untick, so a slow start that an untick overtook can't
  // switch the worksheet back on when it finally answers (review round 1).
  // Not by a tick: two ticks during one cold start (the menu's first two
  // ticks) both want it on, and bumping on each made the first return off,
  // a 502 that dropped the operator's picks (review of #93).
  let generation = 0

  // A worksheet server that dies on its own stops steering answers at once:
  // without this, renders kept describing a task on an iPad showing a dead
  // page, and the operator's box stayed ticked (review round 1).
  d.process.onDeath?.(() => {
    if (!on) return
    on = false
    shown = null
    error = 'the worksheet server stopped; tick the box to start it again'
    api.setRuler(false)
  })

  /**
   * Keeps an answer only if it is at least as new as the one kept. Two
   * overlapping changes can answer out of order (A held, B answered, A
   * arrives last), and keeping A told the brain an older sheet than the iPad
   * shows (review of #93). The state's revision decides, not arrival order.
   */
  const remember = (body: unknown) => {
    const next = parseShown(body)
    if (!next) {
      shown = null
      error = 'worksheet answered something unexpected'
      return
    }
    if (shown && next.rev >= 0 && next.rev < shown.rev) return
    shown = next
  }

  const api = {
    status(): WorksheetStatus {
      return { on, url: on ? d.publicUrl() : null, shown, ruler, error, tasks: tasks.map((t) => ({ id: t.id, task: taskText(t) })), maxPicks: MAX_PICKS }
    },

    async setOn(want: boolean): Promise<WorksheetStatus> {
      error = undefined
      const mine = want ? generation : ++generation
      if (want && !on) {
        starting ??= d.process.start().finally(() => (starting = null))
        try {
          await starting
          if (mine !== generation) return api.status()
          on = true
          const r = await call(`${d.base}/api/state`)
          if (r.ok) remember(r.body)
          else error = r.error
        } catch (e) {
          error = e instanceof Error ? e.message : 'worksheet failed to start'
        }
      } else if (!want && (on || starting)) {
        const wasStarting = starting
        on = false
        shown = null
        api.setRuler(false)
        // Unticked mid-start: let the start finish, then stop what it started.
        await wasStarting?.catch(() => {})
        await d.process.stop()
      }
      return api.status()
    },

    /** Changes what the iPad shows, through its owner. The owner's answer is what we remember. */
    async show(patch: { taskId?: unknown; taskIds?: unknown; textMm?: unknown }): Promise<{ ok: boolean; status: WorksheetStatus }> {
      if (!on) return { ok: false, status: { ...api.status(), error: 'worksheet is off' } }
      const r = await call(`${d.base}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      if (!r.ok) return { ok: false, status: { ...api.status(), error: r.error } }
      error = undefined
      remember(r.body)
      return { ok: true, status: api.status() }
    },

    setRuler(want: boolean) {
      ruler = want && on
      d.setRuler(ruler ? ipadBox(undefined, surface) : null)
    },

    /**
     * The iPad's shown problems as {n, text}: the camera task reader's
     * fallback (#86) when the camera read fails or the models disagree. The
     * same manifest text and numbers withIpad gives the brain, so the
     * fallback can't disagree with what the render is told.
     */
    shownTasks(): { n: number; text: string }[] {
      const picked = on && shown ? shown.taskIds.map((id) => tasks.find((t) => t.id === id)) : []
      if (picked.length === 0 || picked.some((t) => !t)) return []
      return picked.map((t, i) => ({ n: shown!.numbers[i] ?? i + 1, text: taskText(t!) }))
    },

    /**
     * The request as the brain should see it: with the iPad in its scene when
     * the worksheet is on. Synchronous on purpose (see `shown` above).
     *
     * The server's iPad replaces any tablet the client sent, keeping only
     * its box (the bench's simulator places the iPad; ipadPlacement.ts
     * decides). Label and kind are always ours: a client can't make the brain
     * answer a task the iPad isn't showing.
     */
    /**
     * The problems on the iPad by their shown numbers, for the table agent's
     * view of the table (tableAgent.ts). Same lookup rule as withIpad: every
     * one or none, so the agent never sees a renumbered sheet.
     */
    problems(): { number: number; text: string }[] {
      const picked = on && shown ? shown.taskIds.map((id) => tasks.find((t) => t.id === id)) : []
      if (picked.length === 0 || picked.some((t) => !t)) return []
      return picked.map((t, i) => ({ number: shown!.numbers[i]!, text: taskText(t!) }))
    },

    withIpad(request: RenderRequest): RenderRequest {
      // Looked up in our own manifest, every one or none: a sheet with a
      // problem we have no text for is not described at all, rather than
      // renumbered around the gap (the brain's "problem 3" would then be the
      // iPad's problem 4).
      const picked = on && shown ? shown.taskIds.map((id) => tasks.find((t) => t.id === id)) : []
      if (picked.length === 0 || picked.some((t) => !t)) return request
      const numbers = shown!.numbers
      const scene: Scene = request.scene ?? { surface, objects: [] }
      const box = ipadBox(scene, scene.surface)
      const ipad = { id: IPAD_ID, kind: 'tablet' as const, label: ipadLabel(picked as WorksheetTask[], numbers), box }
      return { ...request, scene: { ...scene, objects: [...scene.objects.filter((o) => o.id !== IPAD_ID && o.kind !== 'tablet'), ipad] } }
    },
  }
  return api
}

export type Worksheet = ReturnType<typeof createWorksheet>

/**
 * A 10 cm ruler of light beside the iPad, to hold against the iPad's own
 * 10 cm ruler: if they differ, `DEFAULT_SURFACE.mmPerPx` is wrong (and on
 * site it is suspect: the real projector is 1920 × 1200, the default assumes
 * 1080). Drawn as filled polygons because that is all the overlay layer
 * draws: a 1.5 mm bar along the iPad's left side, 15 mm out from it, with a
 * tick every cm.
 */
export function rulerShapes(box: Box, surface: Surface, color = '#ffffff'): OverlayShape[] {
  const px = (mm: number) => pxFromMm(surface, mm)
  const len = px(100)
  // Out from the iPad's left edge; if that is off the table, the right side.
  // Its longest ticks (6 mm) included: checking the bar alone let them run off the table.
  const left = box.x - px(15) - px(1.5) - px(6) >= 0
  const x0 = left ? box.x - px(15) - px(1.5) : box.x + box.w + px(15)
  const y0 = box.y + (box.h - len) / 2
  const rect = (x: number, y: number, w: number, h: number): OverlayShape => ({ color, points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] })
  const shapes = [rect(x0, y0, px(1.5), len)]
  for (let cm = 0; cm <= 10; cm++) {
    const t = cm % 5 === 0 ? px(6) : px(3.5)
    shapes.push(rect(left ? x0 - t : x0 + px(1.5), y0 + px(cm * 10) - px(0.5), t, px(1)))
  }
  return shapes
}
