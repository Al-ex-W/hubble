import express, { type ErrorRequestHandler } from 'express'
import { z } from 'zod'
import { DEFAULT_SURFACE, type RenderRequest, type RenderStreamLine, type Scene, type ObjectKind } from '@hubble/stage'
import { DEFAULT_WEB_ALLOW, loadConfig, readiness, type ServerConfig } from './config.ts'
import { createBrain, aiquModel } from '@hubble/brain'
import type { LanguageModel } from 'ai'
import { createLegacyRoom, createLiveRoom, createPiRoom, pool as devicePool, type DevicePool, type RoomInfo } from '@hubble/room'
import { createStageHub } from './hub.ts'
import { openDrawingOnTable } from './drawing.ts'
import { createRuntime, type Runtime, type WebInput } from './runtime.ts'
import { mountRuntime } from './runtimeRoutes.ts'
import { ANSWER_ID } from './surfaces.ts'
import { loadLibrary, type Library } from './assets.ts'
import { createInputs } from './inputs.ts'
import { createSpatialService, type SpatialService } from './spatial/service.ts'
import { mountSpatial } from './spatial/routes.ts'
import { mountSimLidar } from './spatial/simRoutes.ts'
import { createLidarSim, simPoseFrom, type LidarSim } from './spatial/lidarSim.ts'
import { mountOverall } from './overall.ts'
import { createWebHost, type WebHost } from './web.ts'
import { createWebRoutes } from './webRoutes.ts'
import { withSurfaces } from './surfaceGestures.ts'
import { createCameraStreams, mountRoomCamera } from './roomCamera.ts'
import { mountHandsMirror } from './handsMirror.ts'
import { mountOperator, type RenderBrain } from './operator.ts'
import { createKeybedClient } from './keybed.ts'
import { mountStudio } from './studio.ts'
import { mountPuppetLab } from './puppetLab.ts'
import { mountProjectorMode } from './projectorMode.ts'
import { mountOperatorUi } from './operatorUi.ts'
import { displaysFromConfig } from './displays.ts'
import { readFileSync } from 'node:fs'
import { createPuppetTable, type AnswerOutcome, type ShowContext } from './puppetTable.ts'
import { createPuppetInputChannel } from './puppetInput.ts'
import { createAppTableAgent, mountTableAgent } from './tableAgent.ts'
import type { TableAgent } from '@hubble/brain'
import { createWorksheet, spawnWorksheet, type Worksheet } from './worksheet.ts'
import { createTaskReader, mountReadTask, pageRegion } from './readTask.ts'
import { mountSolvePage, readForSolve } from './solvePage.ts'
import { ipadBox } from './ipadPlacement.ts'
import { WEB_PORT, webOrigin } from './runtime.ts'

/**
 * The API surface. Keys never leave this process.
 *
 *   GET  /api/health        -> which optional keys are present (llm, jev)
 *   POST /api/render        -> NDJSON stream of one table answer (RenderStreamLine per line)
 *   POST /api/action        -> 202; a button tapped on the table (next | repeat | dismiss)
 *   GET  /api/stage/events  -> SSE of the active render (snapshot first), for table displays
 *   POST /api/surfaces/web, GET /api/web/:id/stream, POST /api/web/:id/:op -> web surfaces (webRoutes.ts)
 *   /api/operator/*         -> the operator panel: acts, reset, fallbacks, status, the iPad worksheet (operator.ts)
 *   POST /api/agent/turn    -> one turn of the table agent (#54): it decides what goes on the table, via tools (tableAgent.ts)
 *   GET  /api/agent/history -> its recent turns, for the bench
 */
type Brain = ReturnType<typeof createBrain>

export function createApp(
  config = loadConfig(),
  deps: { devices?: DevicePool; brain?: Brain; agentModel?: LanguageModel | null; library?: Library; runtime?: (channels: Pick<ReturnType<typeof createStageHub>, 'overlay' | 'surfaces' | 'touch'> & { spatial: SpatialService; dismissAnswer: () => void; ask: (request: RenderRequest) => boolean; webInput?: WebInput }) => Runtime; room?: import('@hubble/room').Room; web?: (onState: Parameters<typeof createWebHost>[0]['onState']) => WebHost; worksheet?: (setRuler: Runtime['setRuler']) => Worksheet } = {},
) {
  const app = express()
  const hub = createStageHub()
  // The room camera's shared streams (#84): one upstream per ROI for every
  // page, opened through the device pool. Created before the runtime so
  // `cameraFrame` can read a live stream's newest frame instead of pulling a
  // separate full 1080p still every 2 s. Undefined without a camera URL.
  const streams = config.roomCameraUrl ? createCameraStreams(config.roomCameraUrl, { pool: deps.devices ?? devicePool }) : undefined
  // Created once the runtime, brain and routes it drives exist (below); the
  // keyboard's SEND (ask) only runs later, so it reads this when it fires.
  let agent: TableAgent | null = null
  let forgetConversation = () => {}
  // The runtime owns product state around answers (act, lesson, lights,
  // displays, and the surface set); it reaches displays only through the
  // hub's overlay and surface channels.
  // `ask` is the projected keyboard's SEND (#29): the runtime owns what was
  // typed, this file owns the one path onto the table. It carries the turn
  // on the table as history, like the table's "next" button below, so a
  // typed "explain step 2" knows which answer it is about. (A closure: the
  // brain and renderToTable are defined below, and it only runs later.)
  //
  // THE ONE SEAM for typed text (7 Oct 2026, owner: "pinch typing will be
  // updated, but what's written there will be fed to puppet master"). SEND from
  // the pen keyboard and from pinch typing both end here (pinch: input/
  // keyboardInput.ts -> keyboard.stroke -> this ask), so one switch moves both.
  // Default: publish the text for the landing page, which turns it into a
  // puppet-master turn (usePuppetAssistant followTableInput); a browser must
  // drive it because the puppet's speech waits for a browser to ack playback.
  // Julius's table agent and direct render below stay in the file, reachable
  // with HUBBLE_TYPED_INPUT=julius, so his merges keep applying cleanly and the
  // old path can be switched back on if the landing page is not the demo.
  // Only the text travels: his scene (camera objects) is not sent on, since
  // the puppet master's show_answer builds its own from the live table.
  // UNVERIFIED in this checkout (index.ts needs @hubble/brain/room); the
  // channel itself is tested in puppetInput.test.ts.
  const puppetInput = createPuppetInputChannel()
  const typedInputToJulius = process.env.HUBBLE_TYPED_INPUT === 'julius'
  const ask = (request: RenderRequest) => {
    // Merge of #99 (7 Oct): only when a landing page is listening. Without
    // one (no browser on /), the puppet master can't run the turn, and its
    // 10 s hold would silently drop the SEND on the demo table; the table
    // agent below answers instead.
    if (!typedInputToJulius && puppetInput.hasListener()) {
      puppetInput.publish(request.intent, 'keyboard')
      return true
    }
    if (!brain) return false
    // With the table agent (#54), SEND is a turn in its one conversation: it
    // may answer, or open the diagram, or start the lesson, and it knows what
    // was said before from any input. Without it (no model key, or turned
    // off), the old direct path below.
    if (agent) {
      void agent.turn({ from: 'keyboard', text: request.intent, context: { scene: request.scene } }).catch((err) => console.error(`[agent] ${redact(err, config)}`))
      return true
    }
    const current = hub.active()
    const history = current?.answer ? [...(current.request.history ?? []), { intent: current.request.intent, answer: current.answer }].slice(-6) : undefined
    void renderToTable(brain, { ...request, history }, () => {})
    return true
  }
  // Web surfaces (#31). The browser starts lazily on the first open, so a
  // server that never shows a webpage never launches Chromium. Its state
  // reports go into the surface set, and every surface line goes back to it
  // so a closed surface closes its page (webRoutes.ts owns that wiring).
  // config.webAllow is optional only so hand-built test configs can omit it;
  // loadConfig always fills it, so this is the same default, not a second one.
  const webAllow = config.webAllow ?? DEFAULT_WEB_ALLOW
  const onWebState = (id: string, st: Parameters<NonNullable<Parameters<typeof createWebHost>[0]['onState']>>[1]) => webRoutes.onState(id, st)
  const web = deps.web?.(onWebState) ?? createWebHost({ allow: webAllow, onState: onWebState })
  const webRoutes = createWebRoutes(web, webAllow)
  const spatial = createSpatialService({ lidarUrl: config.lidarUrl, registrationFile: config.spatialRegistrationFile, anchorsFile: config.spatialAnchorsFile })
  const channels = {
    spatial,
    overlay: hub.overlay,
    touch: hub.touch,
    surfaces: (line: Parameters<typeof hub.surfaces>[0]) => {
      hub.surfaces(line)
      webRoutes.followSurfaces(line)
    },
    dismissAnswer: hub.dismiss,
    ask,
    // The runtime's calibration and look() read the live shared stream's newest
    // frame (#84), with the same 300 ms fallback as /api/camera/frame. Without
    // a manager (no camera URL) this is absent and the runtime uses the room
    // client's camera (the emulator) exactly as before.
    ...(streams && { cameraFrame: () => streams.frame('') }),
  }
  // The pages' input for the runtime: a tap clicks, a drag scrolls, the
  // keyboard's SEND types (web browsing, 7 Oct). The same host the routes
  // drive, so a click from the table and one from the bench queue together.
  const webInput = { click: web.click, scroll: web.scroll, type: web.type, key: web.key }
  const runtime = deps.runtime?.({ ...channels, webInput }) ?? createRuntime({ ...channels, webInput })
  // Whoever opens a page (the route, the agent's open_web), it becomes the
  // keyboard's target: "open Amazon", then type, without a tap in between.
  webRoutes.onOpen((id) => runtime.focusWeb(id))
  // The iPad worksheet (#60): off until the operator ticks its checkbox.
  // Optional so tests (and a server run without it) never spawn a process.
  const worksheet = deps.worksheet?.((box) => runtime.setRuler(box))
  // The camera task reader (#86): reads the real page from one camera still
  // when Setup's "Read page" is pressed. The still goes through the shared
  // stream's pool fetch (hardware window enforced there) or, without a camera
  // URL, the room client's camera (the emulator). Region: a paper/notebook
  // the scene places, else the iPad (readTask.ts pageRegion).
  const taskReader = createTaskReader({
    frame: () => (streams ? streams.frame('') : deps.room ? deps.room.cameraFrame() : Promise.reject(new Error('no room camera configured'))),
    calibration: () => {
      const c = spatial.calibration.cameraFor('room')
      return c ? { h: c.h, width: c.width, height: c.height } : null
    },
    region: (scene) => pageRegion(scene, (s) => ipadBox(s, s?.surface ?? runtime.surfaces.bounds())),
    surface: () => runtime.surfaces.bounds(),
    llm: config.llm.apiKey ? { baseUrl: config.llm.baseUrl, apiKey: config.llm.apiKey } : null,
    worksheetTasks: () => worksheet?.shownTasks() ?? [],
  })
  mountReadTask(app, taskReader)
  const solveDeps = { reader: taskReader, worksheetTasks: () => worksheet?.shownTasks() ?? [] }
  // The brain owns every model call and the verify-and-repair loop; this
  // server only validates input and relays lines.
  const brain =
    deps.brain ??
    (config.llm.apiKey
      ? createBrain({
          llm: { baseUrl: config.llm.baseUrl, apiKey: config.llm.apiKey, model: config.llm.model },
          jev: config.jevApiKey ? { apiKey: config.jevApiKey } : undefined,
          onError: (err) => console.error(`[render] ${redact(err, config)}`),
        })
      : undefined)
  // The asset library (#30): the server alone decides what the table can
  // show; every render's scene gets it, and only its files are served.
  const library = deps.library ?? loadLibrary()
  // Notebook photos arrive as data URLs; a downscaled JPEG is well under this.
  app.use(express.json({ limit: '15mb' }))
  // The puppet master's hands on this table: the same runtime, hub, render
  // path, library and web allow-list as every route below (puppetTable.ts).
  // Studio-only (studioServer.ts) mounts without it and has no table tools.
  const table = createPuppetTable({
    runtime,
    dismiss: hub.dismiss,
    library,
    webAllow,
    openWeb: (url) => webRoutes.open(url),
    ask: brain ? (intent, signal, ctx) => askTable(brain, intent, signal, ctx) : undefined,
    // The ONE act switch is operator.setAct (mounted below); read when a tool fires.
    setAct: (act, song) => operator.setAct(act, song),
    cleanScene: (raw) => {
      const parsed = RenderBody.shape.scene.safeParse(raw)
      return parsed.success ? sanitizeScene(parsed.data) : undefined
    },
    // read_page: the same budgeted read and pick as POST /api/solve-page (solvePage.ts owns both).
    readPage: () => readForSolve(solveDeps),
  })
  // "Solve the page" (plan 2026-10-07-solve-page.md): the step runner's Run,
  // the CLI and the room buttons. The intent goes where typed text goes on
  // this branch: the puppet master when a page on / listens (it then calls
  // show_answer itself), else straight to the table brain, so a press works
  // with no browser open. The render is not awaited: the route answers with
  // what was read, and the answer streams onto the table after.
  mountSolvePage(app, {
    ...solveDeps,
    // Straight to the table, never through the puppet master's browser turn
    // (7 Oct 15:12, live: the read was right but nothing rendered, because the
    // turn needs the operator's tab to run it and that tab was starved of
    // connections). The server-side render is what drew it at 15:17.
    deliver: (intent) => {
      if (!brain) return 'none'
      void askTable(brain, intent, new AbortController().signal).then((o) => {
        if (!o.ok) console.error(`[solve-page] ${o.error}`)
      })
      return 'table'
    },
  })
  mountStudio(app, config, undefined, undefined, { table, input: puppetInput })
  mountPuppetLab(app, config)
  mountProjectorMode(app)
  // TV 1's control-panel mirror follows the operator's page (operatorUi.ts).
  mountOperatorUi(app)

  // Browser startup errors (apps/web/index.html's beacon): the only way to see
  // the iPad Safari console from the laptop without a cable debugger. Text only,
  // capped, never echoed back.
  app.post('/api/client-log', express.text({ type: '*/*', limit: '8kb' }), (req, res) => {
    console.log(`[client] ${String(req.body ?? '').slice(0, 2000)}`)
    res.status(204).end()
  })

  // TV 2's pitch video (apps/web/src/pitch): which YouTube video, read from
  // room.config.json on each request so a new link needs no restart.
  app.get('/api/pitch', (_req, res) => {
    let youtube: string | null = null
    try {
      const c = JSON.parse(readFileSync(new URL('../../room.config.json', import.meta.url), 'utf8')) as { pitch?: { youtube?: unknown } }
      if (typeof c.pitch?.youtube === 'string' && c.pitch.youtube.trim()) youtube = c.pitch.youtube.trim()
    } catch {
      // no config: the page says what to set
    }
    res.json({ youtube })
  })

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, config: readiness() })
  })

  // What we hold on the room's devices right now, and whether the hardware
  // window is open (#73): the device pool's read-only snapshot, for the
  // operating surface. Origins and owner labels only, never paths or
  // queries (room tokens and the Hue user live there).
  //
  // The pool counts subscribers only for shared WebSockets; the camera
  // manager's HTTP streams share one upstream per ROI (#84), and only it
  // knows how many clients ride each. So its counts are merged in here by the
  // owner label the manager handed the pool, rather than editing the pool's
  // snapshot shape in the submodule for one caller.
  app.get('/api/devices', (_req, res) => {
    const snap = (deps.devices ?? devicePool).snapshot()
    const counts = streams?.subscriberCounts() ?? {}
    if (streams) for (const c of snap.connections) if (c.kind === 'http' && c.owner in counts) c.subscribers = counts[c.owner]
    res.json(snap)
  })

  app.post('/api/render', async (req, res) => {
    // The whole body is checked against one schema before anything reads it.
    // Before, fields were picked one by one, so `scene.objects: [null]`
    // threw inside this async handler (Express 4 doesn't catch that: an
    // unhandled rejection), and `history` went through untyped, where a
    // content array could carry an image URL for the SDK to download.
    const parsed = RenderBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'bad-request', detail: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) })
      return
    }
    if (!brain) {
      res.status(503).json({ error: 'llm-not-configured' })
      return
    }
    const body = parsed.data
    const request: RenderRequest = {
      intent: body.intent,
      image: body.image,
      // An empty answer is a render that failed; as history it would teach
      // the model that saying nothing is a valid reply.
      history: body.history?.filter((h) => h.answer.trim() !== '').slice(-6),
      // No default here: a request that names no model gets
      // config.llm.model (HUBBLE_LLM_MODEL) inside the brain. Hard-coding
      // 'aixia-labs' here, in swipeKeyboard.ts and in operator.ts made that
      // env var a silent no-op.
      model: body.model,
      thinking: body.thinking === true,
      scene: withLibrary(sanitizeScene(body.scene), library),
    }
    // The client leaving (closed tab, the bench's stop button) aborts the
    // model calls; otherwise every abandoned request keeps spending until its
    // deadline. `res` 'close' fires on disconnect and also after a normal
    // end, so only an unfinished response counts. (`req` 'close' fires as
    // soon as the body has been read, which is too early to mean anything.)
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) abort.abort()
    })
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' })
    try {
      await renderToTable(
        brain,
        request,
        (line) => {
          if (!res.writableEnded) res.write(`${JSON.stringify(line)}\n`)
        },
        abort.signal,
      )
    } finally {
      res.end()
    }
  })

  /**
   * A button tapped on the projected table. The bench handles its own taps
   * locally, but /table is a bare display with no conversation of its own, so
   * the follow-up has to be built here from what is on the table right now.
   * Answers 202 at once: the result reaches the table over SSE like any other
   * render, and the tap must not depend on the display holding a request open.
   */
  app.post('/api/action', (req, res) => {
    const action = (req.body as { action?: unknown } | undefined)?.action
    if (action === 'dismiss') {
      // One path for clearing the answer: closing its surface dismisses it
      // in the hub too (and the surface route does exactly the same).
      runtime.surfaces.close(ANSWER_ID)
      res.status(202).json({ ok: true })
      return
    }
    if (action === 'repeat') {
      hub.replay()
      res.status(202).json({ ok: true })
      return
    }
    if (action !== 'next') {
      // The catalog's Button only allows these three; anything else is a
      // stale or forged client and must not turn into a free-form prompt.
      res.status(400).json({ error: 'action must be one of next, repeat, dismiss' })
      return
    }
    if (!brain) {
      res.status(503).json({ error: 'HUBBLE_LLM_API_KEY is not set' })
      return
    }
    const current = hub.active()
    if (!current) {
      res.status(409).json({ error: 'nothing on the table to follow up' })
      return
    }
    // Same shape the bench sends for its own "next" tap: the intent is the
    // action word, and the turn on the table goes into history so the model
    // knows what "next" continues. Scene, model and photo carry over because
    // nothing on the table moved between the answer and the tap.
    const { request: prev, answer } = current
    const history = [...(prev.history ?? []), ...(answer ? [{ intent: prev.intent, answer }] : [])].slice(-6)
    const request: RenderRequest = { ...prev, intent: 'next', history }
    res.status(202).json({ ok: true })
    void renderToTable(brain, request, () => {})
  })

  app.get('/api/assets', (_req, res) => res.json(library.list()))
  app.get('/api/assets/:id/file', (req, res) => {
    // Looked up by id in the manifest, never joined from the request: there
    // is no client-supplied path anywhere near the file system.
    const a = library.get(req.params.id)
    if (!a) return void res.status(404).json({ error: 'no such asset' })
    res.type(a.type).sendFile(a.file)
  })
  app.post('/api/surfaces/asset', (req, res) => {
    const id = (req.body as { id?: unknown } | undefined)?.id
    const a = typeof id === 'string' ? library.get(id) : undefined
    if (!a) return void res.status(404).json({ error: 'no such asset' })
    runtime.surfaces.openAsset(a)
    res.json(runtime.surfaces.line())
  })

  // A free-form drawing (draw_svg's route twin): the bench and tests open one
  // without the model, through the same check and surface the tool uses
  // (drawing.ts openDrawingOnTable), so the route can never accept what the
  // tool refuses.
  app.post('/api/surfaces/drawing', (req, res) => {
    const r = openDrawingOnTable(runtime.surfaces, req.body)
    if (!r.ok) return void res.status(400).json({ error: r.error })
    res.json({ id: r.id, ...runtime.surfaces.line() })
  })

  app.get('/api/stage/events', (_req, res) => {
    hub.subscribe(res)
  })

  /**
   * show_answer for the puppet master: the same path as the projected
   * keyboard's SEND (`ask` above), but it waits for the render to finish and
   * reports how it went, so the model can tell the person when the table
   * could not answer instead of assuming it did. The library goes into the
   * scene like /api/render does, so the brain can name assets.
   */
  async function askTable(b: RenderBrain, intent: string, signal: AbortSignal, ctx: ShowContext = {}): Promise<AnswerOutcome> {
    // The conversation's own earlier answers win (Julius's render_answer does
    // the same with its agent's history); the hub's active answer is only the
    // fallback for a conversation that has none yet, e.g. after a restart.
    const current = hub.active()
    const fromHub = current?.answer ? [...(current.request.history ?? []), { intent: current.request.intent, answer: current.answer }].slice(-6) : undefined
    const history = ctx.history?.length ? ctx.history : fromHub
    let failure: string | undefined
    let answer = ''
    await renderToTable(
      b,
      // No `model`: the brain falls back to config.llm.model, the one default (HUBBLE_LLM_MODEL).
      // thinking:false as Julius's render_answer sends it.
      { intent, history, image: ctx.image, thinking: false, scene: withLibrary(ctx.scene, library) },
      (line) => {
        if (line.kind === 'error') failure ??= line.message
        if (line.kind === 'done') answer = line.answer
      },
      signal,
    )
    if (signal.aborted) return { ok: false, error: 'the turn was stopped' }
    if (failure) return { ok: false, error: failure }
    return answer ? { ok: true, answer } : { ok: false, error: 'the brain produced no answer' }
  }

  /**
   * Run one render as the table's active answer. The request takes the table
   * when it arrives; if a newer one arrives first, this one is superseded:
   * its lines stop reaching displays and its caller is told why, so the bench
   * shows "superseded" instead of an answer that never made it to the table.
   *
   * A superseded render is also aborted, like one whose client left: its
   * lines can't reach the table any more, so its model calls are pure cost.
   */
  async function renderToTable(b: RenderBrain, asked: RenderRequest, reply: (line: RenderStreamLine) => void, client?: AbortSignal) {
    // Everything on the table besides the answer (the swipe keyboard, assets,
    // wherever a hand moved them) goes into this render's scene, rebuilt from
    // the live set: surfaceGestures.ts withSurfaces is the one owner (#29's
    // keyboard-in-every-answer rule, review #47, lives there now too).
    // Then the iPad (#60), when its worksheet is on: the exact task it shows
    // and where it lies, so the brain answers what the person sees, beside it.
    // Synchronous (worksheet.ts keeps the last answer), so nothing awaits
    // between a request arriving and it taking the table: latest still wins.
    const surfaced = withSurfaces(asked, runtime.surfaces.list(), runtime.surfaces.bounds())
    const withSheet = worksheet ? worksheet.withIpad(surfaced) : surfaced
    // Then the page the camera read (#86), when a fresh read had both models
    // agree: it replaces the iPad's manifest label with what is really on
    // the table. Synchronous too: the reader keeps its last read.
    const request = taskReader.withPage(withSheet)
    const slot = hub.open(request)
    let renderId = ''
    const supersede = () => {
      if (!renderId) return
      reply({ kind: 'error', renderId, t: 0, message: 'superseded by a newer request' })
      reply({ kind: 'done', renderId, t: 0, answer: '', firstContentMs: null })
    }
    // Resolving on supersede (not when the brain finishes) lets the caller
    // end its response now; the guard below keeps the brain's late lines from
    // being written to a response that has already ended.
    const superseded = new Promise<void>((resolve) =>
      slot.signal.addEventListener(
        'abort',
        () => {
          supersede()
          resolve()
        },
        { once: true },
      ),
    )
    runtime.renderStarted()
    const rendered = b.render(
      request,
      (line) => {
        if (slot.signal.aborted) return
        renderId = line.renderId
        reply(line)
        slot.emit(line)
        // Same lines the displays got, so the answer surface's box is the
        // answer they are drawing.
        runtime.surfaces.onRenderLine(line)
        if (line.kind === 'done') runtime.renderFinished(Boolean(line.answer))
        if (line.kind === 'error') runtime.renderFinished(false)
      },
      { signal: client ? AbortSignal.any([slot.signal, client]) : slot.signal },
    )
    // brain.render reports its own failures as lines; a throw here is a bug,
    // and on the detached /api/action path it would be an unhandled rejection
    // that takes the whole server down mid-demo.
    rendered.catch((err) => console.error(`[render] ${redact(err, config)}`))
    await Promise.race([rendered.catch(() => {}), superseded])
  }

  // Every human input (lidar candidates, MIDI, room buttons) through one stream.
  const inputs = createInputs()
  // Exactly one lidar owner: the spatial service (LIDAR_URL). The old room
  // subscriber (inputs.attachLidar, with an assumed pose and an unregistered
  // 1500 mm mapping) was retired in #89, so the lidar can't be read twice.
  mountSpatial(app, spatial)
  // The simulated lidar (overall view): only where no real lidar is the
  // source. `sim` is null otherwise and its routes say why (409). The same
  // rule is enforced a second time inside the spatial service (attachSim), so
  // skipping this condition can't mix a sim into a real table's scans.
  const simUnavailable = config.lidarUrl
    ? 'a real lidar is configured (LIDAR_URL): the simulated lidar never runs beside it'
    : deps.room && config.lidarSim !== 'on'
      ? 'a room is attached (ROOM is not none): set HUBBLE_LIDAR_SIM=on to rehearse with the simulated lidar'
      : config.lidarSim === 'off'
        ? 'the simulated lidar is switched off (HUBBLE_LIDAR_SIM=off)'
        : ''
  const sim: LidarSim | null = simUnavailable ? null : createLidarSim({ spatial, pose: simPoseFrom(config.lidarSimPose) })
  mountSimLidar(app, sim, simUnavailable)
  mountOverall(app, { runtime, room: deps.room })
  deps.room?.events((e) => {
    if (e.type === 'button') inputs.emit({ kind: 'button', t: Date.now(), id: e.id })
  })
  mountRuntime(app, runtime, inputs)
  // The operator gets the same path onto the table as a question does, so a
  // replayed fallback answer behaves exactly like a live one.
  const operator = mountOperator(app, {
    runtime,
    dismiss: () => hub.dismiss(),
    renderToTable: (b, request) => renderToTable(b, request, () => {}),
    room: deps.room,
    brainConfigured: Boolean(brain),
    worksheet,
    // Read when reset fires, by which time the agent below exists.
    forgetConversation: () => forgetConversation(),
  })
  // The table agent (#54): its tools are this server's own operations
  // (tableAgent.ts maps each one), its model loop lives in @hubble/brain.
  // A caller that injects its own brain (every test does) gets no agent
  // unless it injects the agent's model too: otherwise a test's fake key would
  // build a real gateway client and route the keyboard's SEND through it.
  const agentModel =
    deps.agentModel !== undefined
      ? deps.agentModel
      : !deps.brain && config.llm.apiKey && config.tableAgent !== false
        ? aiquModel({ baseUrl: config.llm.baseUrl, apiKey: config.llm.apiKey, model: config.llm.model })
        : null
  // The agent's conversation lives inside @hubble/brain's createTableAgent
  // with no way to clear it, so reset (operator.ts forgetConversation says
  // why it must) builds a fresh one instead. `agent` stays one stable object
  // that forwards to the current instance, because the keyboard's SEND and
  // mountTableAgent hold it. A turn already running on the old instance
  // finishes there; only new turns start clean.
  const makeAgent = () =>
    brain && agentModel
      ? createAppTableAgent({
          model: agentModel,
          runtime,
          library,
          webHosts: webAllow,
          // One render as a tool: the same path onto the table as everything
          // else, resolving with the answer the displays got ('' if it failed
          // or a newer request superseded it).
          renderAnswer: async (request) => {
            let answer = ''
            await renderToTable(brain, { ...request, scene: withLibrary(request.scene ?? undefined, library) }, (line) => {
              if (line.kind === 'done') answer = line.answer
            })
            return answer
          },
          openWeb: (url) => webRoutes.open(url),
          setAct: operator.setAct,
          ipadProblems: () => worksheet?.problems() ?? [],
          onError: (err) => console.error(`[agent] ${redact(err, config)}`),
        })
      : null
  let currentAgent = makeAgent()
  agent = currentAgent && {
    turn: (input) => currentAgent!.turn(input),
    history: () => currentAgent!.history(),
    answers: () => currentAgent!.answers(),
  }
  forgetConversation = () => {
    if (currentAgent) currentAgent = makeAgent()
  }
  mountTableAgent(app, agent, (scene) => {
    // The same scene policy as /api/render: well-typed values only, then
    // sanitizeScene drops anything outside policy.
    const parsed = RenderBody.shape.scene.safeParse(scene)
    return parsed.success ? sanitizeScene(parsed.data) : undefined
  })
  webRoutes.mount(app, runtime.surfaces)
  mountRoomCamera(app, config.roomCameraUrl, streams)
  mountHandsMirror(app)

  // Express's default handler answers with the error's stack outside
  // production (e.g. for malformed JSON). A short code is all a client needs.
  // Mounted last so it also covers the runtime's routes.
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500
    if (status === 500) console.error(`[http] ${redact(err, config)}`)
    if (!res.headersSent) res.status(status).json({ error: status === 500 ? 'internal' : 'bad-request' })
  }
  app.use(onError)

  return Object.assign(app, { runtime, web, spatial, worksheet })
}

const KINDS: ObjectKind[] = ['notebook', 'book', 'paper', 'keyboard', 'cup', 'phone', 'tablet', 'other']
const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined)

/**
 * `POST /api/render`, as types. Wrong *types* are a 400. Well-typed values
 * outside policy (an id with spaces, an unknown kind, a box off in space) are
 * still dropped by sanitizeScene, as before: the bench's scene editor can
 * produce those, and losing one object beats refusing the whole answer.
 */
const Finite = z.number().finite()
const RenderBody = z.object({
  intent: z.string().max(2000).refine((s) => s.trim() !== '', 'must not be blank'),
  // Notebook photos only, as data URLs. Any other string would be handed to
  // the SDK as an image source, and a URL there is fetched by our server.
  image: z
    .string()
    .regex(/^data:image\/(jpeg|png|webp);base64,/)
    .optional(),
  history: z
    .array(z.object({ intent: z.string().max(2000), answer: z.string().max(20_000) }))
    .max(50)
    .optional(),
  model: z.enum(['aixia-labs', 'aixia-code']).optional(),
  thinking: z.boolean().optional(),
  scene: z
    .object({
      surface: z.object({ widthPx: Finite, heightPx: Finite, mmPerPx: Finite }).partial().optional(),
      objects: z
        .array(
          z.object({
            id: z.string().max(200),
            kind: z.string().max(40),
            label: z.string().max(200).optional(),
            box: z.object({ x: Finite, y: Finite, w: Finite, h: Finite }),
          }),
        )
        .max(64)
        .optional(),
    })
    .optional(),
})
type SceneBody = NonNullable<z.infer<typeof RenderBody>['scene']>

/**
 * A label goes into the system prompt inside a list line, so it is reduced
 * to plain words: letters (any script, so "anteckningsbok" and "häfte"
 * survive), digits, spaces and hyphens, on one line. A newline or quote is
 * how a label would start a new instruction of its own.
 */
export function plainLabel(raw: string): string | undefined {
  const words = raw
    .replace(/[^\p{L}\p{N} -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim()
  return words || undefined
}

/**
 * The scene goes verbatim into the model's prompt, so only well-formed,
 * bounded values get through: ids are plain words and numbers are numbers.
 */
function sanitizeScene(r: SceneBody | undefined): Scene | undefined {
  if (!r) return undefined
  const surface = {
    widthPx: num(r.surface?.widthPx, 320, 7680) ?? DEFAULT_SURFACE.widthPx,
    heightPx: num(r.surface?.heightPx, 240, 4320) ?? DEFAULT_SURFACE.heightPx,
    mmPerPx: num(r.surface?.mmPerPx, 0.05, 10) ?? DEFAULT_SURFACE.mmPerPx,
  }
  const objects = (r.objects ?? []).slice(0, 12).flatMap((ob) => {
    const id = /^[\w-]{1,30}$/.test(ob.id) ? ob.id : undefined
    const kind = KINDS.includes(ob.kind as ObjectKind) ? (ob.kind as ObjectKind) : undefined
    const x = num(ob.box.x, -4000, 8000)
    const y = num(ob.box.y, -4000, 8000)
    const w = num(ob.box.w, 1, 8000)
    const h = num(ob.box.h, 1, 8000)
    if (!id || !kind || x === undefined || y === undefined || w === undefined || h === undefined) return []
    const label = ob.label === undefined ? undefined : plainLabel(ob.label)
    return [{ id, kind, label, box: { x, y, w, h } }]
  })
  return { surface, objects }
}

/**
 * The scene the brain gets: what the client says lies on the table, plus the
 * server's own library. Assets are never taken from the client (sanitizeScene
 * already rebuilt the scene without them), so a client can neither add an
 * asset nor point one at another URL.
 */
function withLibrary(scene: Scene | undefined, library: Library): Scene | undefined {
  const assets = library.list()
  if (assets.length === 0) return scene
  return { ...(scene ?? { surface: DEFAULT_SURFACE, objects: [] }), assets }
}

/**
 * An error as one log line with every configured secret and any bearer
 * token blanked. Upstream errors quote request headers back surprisingly
 * often, and logs get pasted into issues.
 */
export function redact(err: unknown, config: ServerConfig): string {
  let s = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  for (const secret of [config.llm.apiKey, config.jevApiKey])
    if (secret && secret.length >= 6) s = s.split(secret).join('[redacted]')
  return s.replace(/(Bearer\s+)[\w.~+/=-]+/gi, '$1[redacted]').slice(0, 2000)
}

/**
 * The lidar's place on the table: `ROOM_LIDAR_POSE="x,y,rotation"` (table mm
 * from the top-left, user at the bottom edge; degrees clockwise from +x).
 * Measured on site by the spatial service's owner (SPEC §4.3). The default is
 * the spec's own default spot, the middle of the back edge, looking at the
 * user: UNVERIFIED until measured, and touches are only as right as this.
 */
function lidarPose(raw: string | undefined): RoomInfo['lidar'] {
  const v = raw?.split(',').map(Number)
  if (v && v.length === 3 && v.every(Number.isFinite)) return { x: v[0]!, y: v[1]!, rotation: v[2]! }
  return { x: 775, y: 0, rotation: 90 }
}

/**
 * Boot calibration: once the projector is showing our /table page, light the
 * dots and solve camera → table once, then the saved map is used all day.
 * The camera and the projector are the same Pi (pi-projector), so its own
 * /status says when our page is up; until then the dots would land on
 * someone else's picture, so we wait (read-only polling, no writes).
 */
async function bootCalibration(piBase: string, runtime: ReturnType<typeof createRuntime>) {
  for (;;) {
    try {
      // Through the device pool: outside n:10–n:30 this is refused without a packet, and the loop keeps waiting (#73).
      const s = (await (await devicePool.fetch(new URL('/status', piBase), { signal: AbortSignal.timeout(10000) }, 'boot calibration')).json()) as { mode?: string; url?: string | null; kiosk_connected?: boolean }
      if (s.mode === 'url' && s.kiosk_connected && /\/table$/.test(s.url ?? '')) break
    } catch {
      /* the Pi is slow or down: keep waiting */
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  // Let the kiosk finish loading the page before the first dot.
  await new Promise((r) => setTimeout(r, 4000))
  console.log('[calibrate] our page is on the projector: boot calibration')
  const run = await runtime.calibrate()
  console.log(run.ok ? `[calibrate] ok: rms ${run.rms!.toFixed(1)} table px, ${run.dots.filter((x) => x.seen).length}/${run.dots.length} dots, ${(run.ms / 1000).toFixed(0)} s` : `[calibrate] FAILED: ${run.error}`)
}

// Only listen when run directly (`npm run dev:server` / `npm start`), so tests
// can import createApp without binding a port.
if (process.argv[1] && process.argv[1].endsWith('index.ts')) {
  const config = loadConfig()
  // ROOM picks the hardware: 'none' (the default: no room, the bench and
  // /table only), 'emulator' (our emulator of the old gateway draft; start
  // it with `npm run dev:emulator`), 'live' (the real room as configured
  // since 5 Oct: each Pi and the Hue bridge directly, #58), or 'legacy' (the
  // retired NUC API). Everything else in the runtime is the same.
  const which = process.env.ROOM ?? 'none'
  const room =
    which === 'live'
      ? createPiRoom({
          hosts: {
            ...(process.env.ROOM_PI_TABLE && { table: process.env.ROOM_PI_TABLE }),
            ...(process.env.ROOM_PI_TV1 && { 'tv-1': process.env.ROOM_PI_TV1 }),
            ...(process.env.ROOM_PI_TV2 && { 'tv-2': process.env.ROOM_PI_TV2 }),
            ...(process.env.ROOM_PI_LIDAR && { lidar: process.env.ROOM_PI_LIDAR }),
            ...(process.env.ROOM_HUE && { hue: process.env.ROOM_HUE }),
          },
          // The bridge's API user is a credential (ROOM-SETUP.md): .env only.
          hueUser: process.env.ROOM_HUE_USER?.trim() || undefined,
          lidarPose: lidarPose(process.env.ROOM_LIDAR_POSE),
          // The projected band on the table (SPEC §2), in mm.
          table: { width: 1550, height: 970 },
        })
      : which === 'emulator'
      ? createLiveRoom({ base: process.env.ROOM_URL ?? 'http://127.0.0.1:8790', token: process.env.ROOM_TOKEN ?? 'dev-token', kind: 'emulator' })
      : which === 'legacy'
        ? createLegacyRoom({ base: process.env.ROOM_URL ?? 'https://room.local:8443' })
        : undefined
  // The keybed sidecar (apps/keybed, started by `npm run dev`). Always wired:
  // if it isn't running, every ask is null within the deadline and the
  // runtime keeps the camera's last measured keys (or perceive.ts's estimate
  // if the camera never measured any), so nothing here depends on it being up.
  const keybed = createKeybedClient({ url: process.env.KEYBED_URL ?? 'http://127.0.0.1:8792' })
  // The room camera (pi-projector, spec Draft 0.4), when configured: the
  // runtime's one camera for calibration and for finding the keys. The
  // manager (created inside createApp) already serves the runtime's
  // `cameraFrame` from the live shared stream, with a 300 ms fallback to a
  // single pool fetch; the boot calibration below still polls the Pi's
  // /status directly (through the pool) to know when the kiosk is up.
  const camUrl = config.roomCameraUrl
  // The iPad worksheet server (#60, apps/worksheet): spawned from the
  // operator page's checkbox, never at boot. Its port is the one the iPad
  // opens, with this laptop's LAN address (it changes day to day: .17, .18).
  const worksheetPort = Number(process.env.WORKSHEET_PORT ?? 8793)
  const worksheet = (setRuler: Runtime['setRuler']) =>
    createWorksheet({
      base: `http://127.0.0.1:${worksheetPort}`,
      // The iPad opens it through the web app's port (apps/web/worksheetProxy.ts),
      // not worksheetPort, which listens on loopback only.
      publicUrl: () => {
        const origin = webOrigin(process.env.PUBLIC_BASE)
        return origin ? `${origin}/worksheet/` : null
      },
      process: spawnWorksheet(worksheetPort),
      setRuler,
    })
  const app = createApp(config, { room, worksheet, runtime: (channels) => createRuntime({ ...channels, room, requireArm: which === 'live', team: process.env.ROOM_TEAM ?? (which === 'emulator' ? 'hubble' : undefined), publicBase: process.env.PUBLIC_BASE, keybed, calibrationSettleMs: Number(process.env.HUBBLE_CALIBRATE_SETTLE_MS ?? 1500) }) })
  // Calibration changes the physical projection. The on-site owner requires
  // a go for that moment; connecting a read-only camera must not opt into it.
  if (camUrl && process.env.HUBBLE_CALIBRATE_ON_BOOT === 'on') void bootCalibration(camUrl, app.runtime)
  // Every display from displays.ts (the one mapping): projector /table, TV 1
  // the control-panel mirror, TV 2 the data wall; room.config.json's
  // `displays` block overrides any of them. A missing or broken file is the
  // defaults, never a failed boot.
  let roomConfig: unknown = null
  try {
    roomConfig = JSON.parse(readFileSync(new URL('../../room.config.json', import.meta.url), 'utf8'))
  } catch {
    // defaults
  }
  void app.runtime.start(displaysFromConfig(roomConfig)).catch((e) => console.error('room start failed', e))
  app.listen(config.port, '0.0.0.0', () => {
    const r = readiness()
    // Say what to open, not this server's own port: people only ever open
    // the web app, which proxies /api here (runtime.ts, WEB_PORT).
    console.log(`hubble: open http://localhost:${WEB_PORT}  (server :${config.port}, behind it)`)
    console.log(`  llm:        ${r.llm ? 'ready' : 'MISSING — /api/render will answer 503'}`)
    console.log(`  jev:        ${r.jev ? 'ready (placement review on)' : 'off (no TYPESAFE_API_KEY)'}`)
    console.log(`  room:       ${which}${which === 'live' ? ' (each Pi directly; output DISARMED until the operator arms it)' : room ? ` (${process.env.ROOM_URL ?? 'default url'})` : ''}`)
  })
}
