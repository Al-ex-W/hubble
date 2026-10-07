import type { Express } from 'express'
import type { RenderRequest, Scene } from '@hubble/stage'
import { createTableAgent, type ActionContext, type AnswerTurn, type TableActions, type TableAgent, type TableState } from '@hubble/brain'
import type { LanguageModel } from 'ai'
import type { Runtime } from './runtime.ts'
import type { Library } from './assets.ts'
import { SONGS } from './lesson/lesson.ts'
import { openDrawingOnTable } from './drawing.ts'

/**
 * The app side of the table agent (#54): what the agent sees of the table and
 * what its tools do here. The agent itself (the conversation, the model loop)
 * lives in @hubble/brain, the one owner of model calls; this file only maps
 * its tools onto operations the HTTP routes already use, so a tool can never
 * do something the matching route would refuse:
 *   render_answer → index.ts renderToTable (the verified brain pipeline)
 *   open_asset    → the asset library + runtime.surfaces.openAsset (as POST /api/surfaces/asset)
 *   open_web      → webRoutes.open (the allow-list, as POST /api/surfaces/web)
 *   draw_svg      → drawing.ts openDrawingOnTable (as POST /api/surfaces/drawing)
 *   show_keyboard → runtime.keyboard.open (as POST /api/keyboard/open)
 *   close_surface → runtime.surfaces.close (as POST /api/surfaces/:id/close)
 *   start_lesson / set_act → operator setAct (as POST /api/operator/act)
 */

/** Per-turn data from the input: the bench's notebook photo and scene. */
export interface TurnContext {
  image?: string
  scene?: Scene
}

export interface TableAgentAppDeps {
  model: LanguageModel
  runtime: Runtime
  library: Library
  webHosts: readonly string[]
  /** Run one render on the table; resolves with the answer text ('' if it failed or was superseded). */
  renderAnswer(request: RenderRequest): Promise<string>
  openWeb(url: unknown): Promise<{ id: string } | { status: number; error: string }>
  setAct(act: unknown, song?: unknown): { status: number; error?: string }
  /** The iPad worksheet's problems by shown number; empty when it is off (worksheet.ts problems). */
  ipadProblems?: () => { number: number; text: string }[]
  onError?: (err: unknown) => void
}

export function createAppTableAgent(d: TableAgentAppDeps): TableAgent {
  const state = (): TableState => {
    const r = d.runtime.state()
    // The surface set's live scale, read every turn: a render or calibration
    // can change it, and the surface manager sizes boxes by it. A scale
    // captured once (DEFAULT_SURFACE) told the model a 200 mm asset was
    // 156 mm wide after a 1 mm/px surface arrived (review #55).
    const mmPerPx = d.runtime.surfaces.bounds().mmPerPx
    // The iPad worksheet, as the agent must see it. Without this the agent
    // knew nothing of the iPad, so "Solve problem 2" (rehearsal, 7 Oct,
    // fresh conversation) opened the library's worksheet PHOTO and asked
    // the brain for that photo's task 2, steering the answer away from the
    // iPad's x² - 5x + 6 = 0. One entry per problem rather than one iPad
    // entry: the prompt cuts each title at 120 characters, which dropped
    // the second problem of a two-problem label. And while the iPad shows
    // problems, the photo isn't offered at all: two worksheets on one
    // table make "problem 2" ambiguous, and the iPad is the one in the demo.
    const ipad = d.ipadProblems?.() ?? []
    const ipadBox = { xMm: 0, yMm: 0, wMm: 0, hMm: 0 }
    return {
      act: r.act,
      lesson: r.lesson ? { song: r.lesson.song, index: r.lesson.index, total: r.lesson.total } : null,
      surfaces: [
        ...ipad.map((p) => ({ id: `ipad-problem-${p.number}`, kind: 'iPad worksheet problem', title: `problem ${p.number}: ${p.text}`, ...ipadBox })),
        ...d.runtime.surfaces.list().map((s) => {
          const st = (s.state ?? {}) as { title?: unknown }
          return { id: s.id, kind: s.kind, title: typeof st.title === 'string' && st.title ? st.title : undefined, xMm: s.box.x * mmPerPx, yMm: s.box.y * mmPerPx, wMm: s.box.w * mmPerPx, hMm: s.box.h * mmPerPx }
        }),
      ],
      assets: d.library
        .list()
        .filter((a) => ipad.length === 0 || a.id !== 'worksheet')
        .map((a) => ({ id: a.id, kind: a.kind, title: a.title })),
      webHosts: [...d.webHosts],
      songs: Object.entries(SONGS).map(([id, s]) => ({ id, title: s.title })),
      // What the camera last saw (a cup, the notebook, the MiniLab), in table
      // mm like the surfaces: draw_svg places drawings by it ("a circle
      // around my cup"). Empty without a camera, and then the prompt says
      // nothing about objects at all.
      objects: d.runtime.seen().map((o) => ({ id: o.id, kind: o.kind, label: o.label, xMm: o.box.x * mmPerPx, yMm: o.box.y * mmPerPx, wMm: o.box.w * mmPerPx, hMm: o.box.h * mmPerPx })),
    }
  }

  const ok = { ok: true }
  const actions: TableActions = {
    async render_answer(input, ctx: ActionContext) {
      const turn = (ctx.context ?? {}) as TurnContext
      const request: RenderRequest = {
        intent: String(input.intent ?? ''),
        // The agent's own record of what it rendered, so a follow-up from any
        // input knows the earlier answers (#51: the bench sent none).
        history: ctx.history.map((h: AnswerTurn) => ({ intent: h.intent, answer: h.answer })),
        image: turn.image,
        scene: turn.scene,
        model: 'aixia-labs',
        thinking: false,
      }
      const answer = await d.renderAnswer(request)
      return answer ? { ok: true, answer } : { ok: false, error: 'the answer did not render' }
    },
    open_asset(input) {
      const a = d.library.get(String(input.id ?? ''))
      if (!a) return { ok: false, error: `no such asset; ids: ${d.library.list().map((x) => x.id).join(', ')}` }
      d.runtime.surfaces.openAsset(a)
      return ok
    },
    async open_web(input) {
      const r = await d.openWeb(input.url)
      return 'error' in r ? { ok: false, error: r.status === 403 ? (d.webHosts.includes('*') ? 'not allowed: local and private network addresses are never shown' : `host not allowed; allowed: ${d.webHosts.join(', ')}`) : r.error } : { ok: true, id: r.id }
    },
    draw_svg(input) {
      return openDrawingOnTable(d.runtime.surfaces, input)
    },
    show_keyboard() {
      d.runtime.keyboard.open()
      return ok
    },
    close_surface(input) {
      const id = String(input.id ?? '')
      if (!d.runtime.surfaces.list().some((s) => s.id === id)) return { ok: false, error: `nothing on the table is called ${JSON.stringify(id)}` }
      d.runtime.surfaces.close(id)
      return ok
    },
    start_lesson(input) {
      const r = d.setAct('lesson', input.song)
      return r.error ? { ok: false, error: r.error } : ok
    },
    set_act(input) {
      const r = d.setAct(input.act)
      return r.error ? { ok: false, error: r.error } : ok
    },
  }

  return createTableAgent({ model: d.model, state, actions, onError: d.onError })
}

const FROM = new Set(['keyboard', 'chat', 'operator', 'voice'])

/** POST /api/agent/turn and GET /api/agent/history. */
export function mountTableAgent(app: Express, agent: TableAgent | null, sanitize: (scene: unknown) => Scene | undefined) {
  app.post('/api/agent/turn', async (req, res) => {
    if (!agent) return void res.status(503).json({ error: 'llm-not-configured' })
    const b = (req.body ?? {}) as { text?: unknown; from?: unknown; image?: unknown; scene?: unknown }
    if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 2000) return void res.status(400).json({ error: 'expected { text }' })
    const from = typeof b.from === 'string' && FROM.has(b.from) ? (b.from as 'chat') : 'chat'
    // Same image policy as /api/render: notebook photos as data URLs only
    // (any other string would be fetched by our server as an image source).
    const image = typeof b.image === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(b.image) ? b.image : undefined
    const context: TurnContext = { image, scene: sanitize(b.scene) }
    res.json(await agent.turn({ from, text: b.text.trim(), context }))
  })
  app.get('/api/agent/history', (_req, res) => res.json(agent ? agent.history() : []))
}
