import { tool } from 'ai'
import { z } from 'zod'
import type { Scene } from '@hubble/stage'
import type { Library } from './assets.ts'
import { clearTableOf, startLessonAct } from './operator.ts'
import type { Runtime } from './runtime.ts'
import { MAX_MOVE_PX, SURFACE_ID } from './surfaces.ts'
import { SONGS } from './lesson/lesson.ts'
import { openDrawingOnTable } from './drawing.ts'
import { tableToolDescriptions, tableToolInputs } from '@hubble/brain'

/**
 * TEMPORARY tools over Julius's brain/runtime, until the owner's own versions
 * exist. Owner, 7 Oct 2026: "keep the renderer that julius uses, and lets just
 * make temporary agent tools for puppert master to call what julius could do
 * with brain." Nothing here is a second implementation: each tool is a thin
 * wrapper over the function behind one of Julius's HTTP routes or his table
 * agent's tools (tableAgent.ts), so when he adds to a route the puppet master
 * gets it. PARITY with his table agent's tool set (checked 7 Oct):
 *   render_answer  -> show_answer   (+ the conversation's earlier answers as history, scene, image)
 *   open_asset     -> open_asset
 *   open_web       -> open_web
 *   draw_svg       -> draw_svg       (the same checked path, drawing.ts openDrawingOnTable)
 *   show_keyboard  -> open_keyboard
 *   close_surface  -> close_surface
 *   start_lesson / set_act -> start_lesson, set_act (both through operator.setAct)
 * Ours alone: inspect_table, move/raise_surface, close_keyboard, stop_lesson,
 * clear_table (all already routes or runtime calls Julius's UI uses).
 *
 * The puppet master's hands on the Julius table.
 *
 * The agent (puppetMaster.ts) depends on `PuppetTable`, a narrow interface,
 * and never on the runtime, hub or brain. Why: (1) studioServer.ts must run
 * with no table at all (no room, no brain submodules), and the table tools
 * simply do not exist there; (2) tests drive the agent with a fake table, so
 * the tool contract is checked without Chromium, a projector or a model.
 *
 * Every method either does its thing or THROWS an Error whose message is
 * written for the model: the tool loop turns a throw into a tool error the
 * model reads and reacts to (tell the person, try something else), and the
 * turn goes on. Nothing here may crash a turn.
 *
 * Operations are derived from what the existing routes really do
 * (runtimeRoutes.ts /api/surfaces/:id/:op, keyboard and lesson routes,
 * index.ts /api/surfaces/asset, webRoutes.ts, operator.ts clear/act), through
 * the same functions and validation, not copies of them.
 */
export interface TableSnapshot {
  act: string
  mode: string
  lesson: string | null
  keyboardOpen: boolean
  surfaces: { id: string; kind: string; label?: string; box: { x: number; y: number; w: number; h: number }; focused: boolean }[]
  /** What open_asset may name: the library's ids and what each shows. */
  assets: { id: string; kind: string; title: string }[]
  songs: string[]
  /** Hostnames open_web may show (exact match). */
  webAllow: string[]
  /** False when no model is configured for table answers: show_answer will fail. */
  brain: boolean
}

/** One earlier answer of the conversation, as the brain's RenderRequest.history wants it. */
export interface AnswerTurn { intent: string; answer: string }

/**
 * What a show_answer render needs from the conversation, beyond the question.
 * Julius's table agent builds exactly this in its render_answer (tableAgent.ts:
 * history of earlier {intent, answer}, the turn's image and scene). Without
 * `history` a follow-up like "explain the last step" reaches the brain as a
 * question about nothing.
 */
export interface ShowContext {
  history?: AnswerTurn[]
  scene?: Scene
  /** A notebook photo as a data URL (already validated by the turn route). */
  image?: string
}

/** The conversation's table-facing state for one turn: owned by the session, mutated by show_answer. */
export interface TableTurn extends ShowContext {
  history: AnswerTurn[]
}

/** How many earlier answers a render gets: the same cap index.ts's keyboard path and askTable always used. */
export const ANSWER_HISTORY = 6

export interface PuppetTable {
  inspect(): TableSnapshot
  /** Ask the brain for one answer on the table. Resolves when it is finished; throws if it cannot be shown. */
  showAnswer(intent: string, signal: AbortSignal, ctx?: ShowContext): Promise<{ answer: string }>
  /** Julius's act switch (operator.setAct): 'math' stops the lesson, 'lesson' clears the table and starts a song. */
  setAct(act: 'math' | 'lesson', song?: string): void
  /** The scene policy of /api/render (index.ts sanitizeScene); absent where no table exists. */
  cleanScene?(raw: unknown): Scene | undefined
  openAsset(id: string): Promise<{ surface: string }> | { surface: string }
  openWeb(url: string): Promise<{ surface: string }>
  /** A free-form drawing (draw_svg's input). Throws, with the reason, when the drawing is refused. */
  drawSvg(input: unknown): { surface: string }
  /** False when the surface did not move (pinned, or already at the edge). */
  moveSurface(id: string, dx: number, dy: number): boolean
  raiseSurface(id: string): void
  closeSurface(id: string): void
  openKeyboard(): void
  closeKeyboard(): void
  startLesson(song: string): void
  stopLesson(): void
  clearTable(): void
  /**
   * Read the page on the table (camera, else the iPad's problem), without
   * rendering anything. Optional: studio and tests may have no camera.
   * solvePage.ts readForSolve is the one implementation.
   */
  readPage?(): Promise<{ source: 'camera' | 'ipad' | 'none'; text: string; problems: { n: number; text: string }[]; note?: string }>
}

/** The outcome of one brain render, as index.ts's renderToTable reports it. */
export type AnswerOutcome = { ok: true; answer: string } | { ok: false; error: string }

export function createPuppetTable(d: {
  runtime: Runtime
  /** The hub's dismiss (clears the answer on every display). */
  dismiss: () => void
  library: Library
  webAllow: readonly string[]
  /** webRoutes.open: the allow-list verdict and the surface are the route's own. */
  openWeb: (url: string) => Promise<{ id: string } | { status: number; error: string }>
  /** index.ts's one path onto the table; undefined when no brain is configured. */
  ask?: (intent: string, signal: AbortSignal, ctx: ShowContext) => Promise<AnswerOutcome>
  /** operator.setAct: the ONE act switch, shared with POST /api/operator/act and Julius's own agent. */
  setAct: (act: unknown, song?: unknown) => { status: number; error?: string }
  cleanScene?: (raw: unknown) => Scene | undefined
  readPage?: PuppetTable['readPage']
}): PuppetTable {
  const { runtime } = d
  // Same checks as POST /api/surfaces/:id/:op, in the same order: shape
  // first, then existence (a gesture or a model aimed at a surface that just
  // closed must hear "no surface", not silently succeed).
  const existing = (id: string) => {
    if (!SURFACE_ID.test(id)) throw new Error(`"${id}" is not a surface id. Call inspect_table for the ids on the table.`)
    if (!runtime.surfaces.list().some((s) => s.id === id)) throw new Error(`There is no surface "${id}" on the table (it may have just closed). Call inspect_table.`)
    return id
  }
  return {
    inspect() {
      const st = runtime.state()
      return {
        act: st.act,
        mode: st.mode,
        lesson: st.lesson?.song ?? null,
        keyboardOpen: Boolean(runtime.keyboard.state()),
        surfaces: runtime.surfaces.list().map((s) => ({ id: s.id, kind: s.kind, label: typeof s.state.title === 'string' ? s.state.title : undefined, box: s.box, focused: s.focused })),
        assets: d.library.list().map((a) => ({ id: a.id, kind: a.kind, title: a.title })),
        songs: Object.keys(SONGS),
        webAllow: [...d.webAllow],
        brain: Boolean(d.ask),
      }
    },
    cleanScene: d.cleanScene,
    readPage: d.readPage,
    setAct(act, song) {
      const r = d.setAct(act, song)
      if (r.error) throw new Error(`The table refused the act switch: ${r.error}.`)
    },
    async showAnswer(intent, signal, ctx = {}) {
      if (!d.ask) throw new Error('The table brain is not configured (no model key on the server), so no answer can be put on the table. Tell the person, and answer by speaking instead.')
      let outcome: AnswerOutcome
      try {
        outcome = await d.ask(intent, signal, ctx)
      } catch (e) {
        throw new Error(`The table brain failed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}. Tell the person, or answer by speaking.`)
      }
      if (!outcome.ok) throw new Error(`The table could not show an answer: ${outcome.error}. Tell the person, or answer by speaking.`)
      return { answer: outcome.answer }
    },
    openAsset(id) {
      // Looked up by id in the manifest, like POST /api/surfaces/asset: the
      // model never supplies a path or a url.
      const a = d.library.get(id)
      if (!a) throw new Error(`No asset "${id}". Choose one of: ${d.library.list().map((x) => x.id).join(', ') || '(the library is empty)'}.`)
      runtime.surfaces.openAsset(a)
      return { surface: `asset-${a.id}` }
    },
    async openWeb(url) {
      const opened = await d.openWeb(url)
      if ('error' in opened) {
        if (opened.status === 403) throw new Error(`The host of that address is not allowed on the table. Allowed hosts: ${d.webAllow.join(', ')}.`)
        throw new Error(`The table could not open that page: ${opened.error}.`)
      }
      return { surface: opened.id }
    },
    drawSvg(input) {
      const r = openDrawingOnTable(runtime.surfaces, input)
      if (!r.ok) throw new Error(`The drawing was refused: ${r.error}. Fix it and draw again.`)
      return { surface: r.id }
    },
    moveSurface(id, dx, dy) {
      existing(id)
      if (![dx, dy].every((n) => Number.isFinite(n) && Math.abs(n) <= MAX_MOVE_PX)) throw new Error(`dx and dy are surface pixels, at most ${MAX_MOVE_PX} either way.`)
      return runtime.surfaces.move(id, { dx, dy })
    },
    raiseSurface: (id) => void runtime.surfaces.raise(existing(id)),
    closeSurface: (id) => void runtime.surfaces.close(existing(id)),
    openKeyboard: () => void runtime.keyboard.open(),
    closeKeyboard: () => void runtime.keyboard.close(),
    startLesson(song) {
      if (!startLessonAct(runtime, d.dismiss, song)) throw new Error(`Unknown song "${song}". Choose one of: ${Object.keys(SONGS).join(', ')}.`)
    },
    stopLesson: () => runtime.stopLesson(),
    clearTable: () => clearTableOf(runtime, d.dismiss),
  }
}

/**
 * The tool definitions over a PuppetTable. `ordered` is the agent's serial
 * queue: table writes, canvas writes and speech all follow the model's call
 * order, so "say 'opening it' then open_asset" never opens before the person
 * has heard it. Note what is absent on purpose: no tool takes stage JSX. The
 * model asks (show_answer) and the brain, with its layout verification, draws
 * (AGENTS.md rule 4: the model directs, our code guarantees).
 */
export function tableTools(table: PuppetTable, ordered: <T>(name: string, run: () => T | Promise<T>) => Promise<T>, signal: AbortSignal, turn: TableTurn = { history: [] }) {
  const id = z.string().min(1).max(64)
  return {
    inspect_table: tool({
      description: 'Read the Julius table: surfaces on it (ids, kinds, positions), the current act, lesson, keyboard, the asset library, songs and allowed web hosts. Call before moving or closing anything.',
      inputSchema: z.object({}),
      execute: () => ordered('inspect_table', () => table.inspect()),
    }),
    show_answer: tool({
      description: 'Put a worked answer on the table (maths, a graph, an explanation) by asking the table brain. Give the question as the person would ask it. You never write the layout yourself. May take several seconds; say something short first if it helps.',
      inputSchema: z.object({ intent: z.string().trim().min(1).max(2000) }),
      execute: ({ intent }) => ordered('show_answer', async () => {
        // A COPY of the history, taken now: the brain call is slow and the
        // array is the session's, which this very tool grows afterwards.
        const shown = await table.showAnswer(intent, signal, { history: turn.history.slice(-ANSWER_HISTORY), scene: turn.scene, image: turn.image })
        // Recorded only after the answer really reached the table (a throw
        // above skips this): a failed render must not become "the last
        // answer" a follow-up then asks about. In place, because the session
        // owns the array and the next turn must see it.
        turn.history.push({ intent, answer: shown.answer })
        if (turn.history.length > ANSWER_HISTORY) turn.history.splice(0, turn.history.length - ANSWER_HISTORY)
        return { shown: true, ...shown }
      }),
    }),
    read_page: tool({
      description: "Read the maths problem on the person's page or iPad through the room camera (falls back to the iPad's shown problem). Returns the text and its source. Renders nothing: pass the text on to show_answer.",
      inputSchema: z.object({}),
      execute: () => ordered('read_page', async () => {
        if (!table.readPage) throw new Error('This table has no camera reader. Ask the person to type the problem.')
        const r = await table.readPage()
        // An empty read is a result, not an error: the model should tell the
        // person to type the problem, which the note says in their words.
        return r.text ? { source: r.source, text: r.text, problems: r.problems } : { source: 'none', text: '', note: r.note ?? "couldn't read the page — ask the person to type it" }
      }),
    }),
    open_asset: tool({
      description: 'Show a picture, video or page from the asset library on the table. Ids come from inspect_table.',
      inputSchema: z.object({ id }),
      execute: ({ id }) => ordered('open_asset', async () => ({ opened: true, ...(await table.openAsset(id)) })),
    }),
    open_web: tool({
      description: 'Show a web page on the table. Only allow-listed hosts (see inspect_table) work; anything else is refused.',
      inputSchema: z.object({ url: z.string().url().max(2000) }),
      execute: ({ url }) => ordered('open_web', async () => ({ opened: true, ...(await table.openWeb(url)) })),
    }),
    draw_svg: tool({
      // The table agent's own schema (one owner of the size bounds), so the
      // puppet master can't ask for a drawing the table agent couldn't.
      description: tableToolDescriptions.draw_svg + ' Rules: bright strokes and fills on a transparent background (black is no light), a viewBox, no script, foreignObject, image, links or external url().',
      inputSchema: tableToolInputs.draw_svg,
      execute: (input) => ordered('draw_svg', () => ({ drawn: true, ...table.drawSvg(input) })),
    }),
    move_surface: tool({
      description: 'Move a surface on the table by dx, dy surface pixels (positive is right and down).',
      inputSchema: z.object({ id, dx: z.number().finite(), dy: z.number().finite() }),
      execute: ({ id, dx, dy }) => ordered('move_surface', () => ({ moved: table.moveSurface(id, dx, dy) })),
    }),
    raise_surface: tool({
      description: 'Bring a surface to the front.',
      inputSchema: z.object({ id }),
      execute: ({ id }) => ordered('raise_surface', () => { table.raiseSurface(id); return { raised: id } }),
    }),
    close_surface: tool({
      description: 'Close one surface (the answer, an asset, a web page, the keyboard).',
      inputSchema: z.object({ id }),
      execute: ({ id }) => ordered('close_surface', () => { table.closeSurface(id); return { closed: id } }),
    }),
    open_keyboard: tool({
      description: 'Open the projected typing keyboard on the table.',
      inputSchema: z.object({}),
      execute: () => ordered('open_keyboard', () => { table.openKeyboard(); return { opened: true } }),
    }),
    close_keyboard: tool({
      description: 'Close the projected typing keyboard.',
      inputSchema: z.object({}),
      execute: () => ordered('close_keyboard', () => { table.closeKeyboard(); return { closed: true } }),
    }),
    start_lesson: tool({
      description: 'Start the piano lesson: the maths answer leaves the table and the next key lights up on the real keyboard. Songs come from inspect_table.',
      inputSchema: z.object({ song: z.string().min(1).max(64) }),
      execute: ({ song }) => ordered('start_lesson', () => { table.startLesson(song); return { started: song } }),
    }),
    set_act: tool({
      description: "Switch the table's act: 'math' (worked answers; ends any lesson) or 'lesson' (clears the table and starts a piano song; songs from inspect_table, default ode-to-joy).",
      inputSchema: z.object({ act: z.enum(['math', 'lesson']), song: z.string().min(1).max(64).optional() }),
      execute: ({ act, song }) => ordered('set_act', () => { table.setAct(act, song); return { act } }),
    }),
    stop_lesson: tool({
      description: 'End the piano lesson and go back to the maths act.',
      inputSchema: z.object({}),
      execute: () => ordered('stop_lesson', () => { table.stopLesson(); return { stopped: true } }),
    }),
    clear_table: tool({
      description: 'Close everything on the table (answer, assets, pages, keyboard). Only when the person asks to clear or start over.',
      inputSchema: z.object({}),
      execute: () => ordered('clear_table', () => { table.clearTable(); return { cleared: true } }),
    }),
  }
}
