import type { Express } from 'express'
import { createStageParser, type RenderRequest, type RenderStreamLine, type Scene } from '@hubble/stage'
import { loadRecording } from '@hubble/stage/testing'
import type { Room } from '@hubble/room'
import type { Runtime } from './runtime.ts'
import { DISPLAY_PAGES, PAGE_PATH, isDisplayId, isDisplayPage } from './displays.ts'
import { SONGS } from './lesson/lesson.ts'
import type { Worksheet } from './worksheet.ts'

/**
 * The operator panel's HTTP surface (#34): switch acts, reset, recover.
 *
 * On stage there is no time to debug. Everything here is one request that
 * either works or says why, and nothing here waits on a device for longer
 * than ROOM_DEADLINE_MS: one dead device must never take the operator's
 * view down with it (AGENTS.md, rule 6).
 *
 * The routes own no state. Acts, lights and health belong to the runtime;
 * which answer is on the table belongs to the hub; putting an answer on the
 * table goes through the same `renderToTable` as a real question. The
 * operator can only ask the owners to do what they already do.
 */

/**
 * Recorded answers the operator may replay when the uplink is slow or down.
 * An allow-list of names, not a path: the operator page is reachable from
 * the room network, and a file name in a request would be a file read.
 * Both verify with no repair (probe in docs/plans/2026-10-06-demo-smoke.md),
 * so they render exactly as recorded.
 */
export const FALLBACK_ANSWERS = {
  linear: { recording: 'scene-linear-left', intent: 'Solve the task in my notebook.' },
  graph: { recording: 'scene-quadratic-graph', intent: 'Show me the graph of the quadratic.' },
} as const
export type FallbackName = keyof typeof FALLBACK_ANSWERS

const ROOM_DEADLINE_MS = 1500

/** What `renderToTable` needs from a brain: index.ts's Brain, narrowed. */
export interface RenderBrain {
  render(request: RenderRequest, emit: (line: RenderStreamLine) => void, opts?: { signal?: AbortSignal }): Promise<unknown>
}

/**
 * A brain that answers with a recorded answer and never calls a model.
 *
 * Why a brain and not a direct write to the hub: the fallback then takes the
 * table exactly like a live answer (latest wins, a newer question supersedes
 * it, late displays get it by replay, the lights follow), so it can't drift
 * from the real path. The recording's own scene goes on the start line: the
 * answer was verified against that scene, and re-verifying against the live
 * one could refuse the very answer the fallback exists to show (plan ruling).
 */
export function createReplayBrain(text: string, scene: Scene | null): RenderBrain {
  return {
    async render(request, emit, opts) {
      const renderId = `replay-${Math.random().toString(36).slice(2, 8)}`
      emit({ kind: 'start', renderId, intent: request.intent, model: 'replay', t: 0, scene: scene ?? request.scene })
      const p = createStageParser()
      for (const event of [...p.push(text), ...p.end()]) {
        if (opts?.signal?.aborted) return
        emit({ kind: 'event', renderId, t: 0, event })
      }
      emit({ kind: 'done', renderId, t: 0, answer: text, firstContentMs: 0 })
    },
  }
}

/**
 * Empty the table: every surface closes through the surface manager (#38),
 * the one owner of what is on the table, so its window list and the
 * displays can't disagree. Calling the hub's dismiss directly (what this
 * did before #38 landed) cleared the answer but left its surface in the
 * list, a window a hand could still hit. The hub is dismissed only when
 * no answer surface did it already. Then the runtime settles the mode,
 * since clearing may have aborted a render mid-way (review #40, finding 4).
 *
 * Exported (not only used by the routes below) because the puppet master's
 * clear_table tool must do exactly this and nothing else: a second
 * implementation would drift from what the operator's button does.
 */
export function clearTableOf(runtime: Runtime, dismiss: () => void) {
  if (!runtime.surfaces.closeAll().closedAnswer) dismiss()
  runtime.tableCleared()
}

/**
 * The keyboard act, as the operator panel starts it. The song is validated
 * BEFORE anything changes: a refused song must not have already cleared the
 * table (review #40, finding 1: 'constructor' got past a plain lookup after
 * the dismiss). The math answer leaves the table so the lit key is the one
 * thing to look at (owner, 2026-10-06). Shared with the puppet's start_lesson
 * so a spoken "teach me Ode to Joy" and the operator's button cannot differ.
 * Returns false for an unknown song.
 */
export function startLessonAct(runtime: Runtime, dismiss: () => void, song: string): boolean {
  if (!Object.hasOwn(SONGS, song)) return false
  clearTableOf(runtime, dismiss)
  runtime.startLesson(song)
  return true
}

export interface OperatorDeps {
  runtime: Runtime
  /** The hub's dismiss: clears the answer on every display. */
  dismiss(): void
  /** index.ts's one path onto the table. */
  renderToTable(brain: RenderBrain, request: RenderRequest): Promise<void>
  room?: Room
  brainConfigured: boolean
  /** The iPad worksheet (#60); absent when the server was built without it. */
  worksheet?: Worksheet
  /**
   * Forget the table agent's conversation. Reset must start the show from
   * nothing, and the conversation is part of the show: without this, turns
   * from a rehearsal survived reset, and on 7 Oct "Solve problem 2" (iPad
   * showing x² - 5x + 6 = 0) rendered "Task 2: 3(x - 2) = 9" from an earlier
   * worksheet photo, because the model read "problem 2" off its old answers.
   */
  forgetConversation?: () => void
  now?: () => number
}

export function mountOperator(app: Express, d: OperatorDeps) {
  const now = d.now ?? Date.now

  app.get('/api/operator/piano', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(d.runtime.pianoState())
  })
  app.post('/api/operator/piano', (req, res) => {
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled
    if (typeof enabled !== 'boolean') return void res.status(400).json({ error: 'enabled must be a boolean' })
    const changed = d.runtime.setPianoEnabled(enabled)
    res.json(d.runtime.pianoState())
    // Do not hold the checkbox request through camera/sidecar deadlines.
    // Repeated enables are idempotent and cannot stack capture work.
    if (changed && enabled) void d.runtime.look().catch(() => undefined)
  })

  app.get('/api/operator/status', async (_req, res) => {
    const { lastRender, lastMidiAt } = d.runtime.health()
    res.json({
      ...d.runtime.state(),
      room: await roomStatus(d.room),
      camera: { calibrated: d.runtime.calibrated(), seen: d.runtime.seen().length, source: d.runtime.calibrationSource(), at: d.runtime.calibration()?.at ?? null },
      midi: { lastAt: lastMidiAt, agoMs: lastMidiAt === null ? null : now() - lastMidiAt },
      brain: { configured: d.brainConfigured, lastRender },
      worksheet: d.worksheet?.status() ?? null,
      output: d.runtime.roomOutput(),
    })
  })

  /**
   * Room output: arm or disarm writes to the room's shared projector, TVs and
   * lights. The owner's rule is no writes without the owner's go, and since
   * 5 Oct the room has no slots or tokens in code, so this switch is the go.
   */
  app.post('/api/operator/room', (req, res) => {
    const armed = (req.body as { armed?: unknown } | undefined)?.armed
    if (typeof armed !== 'boolean') return void res.status(400).json({ error: 'armed must be true or false' })
    res.json(d.runtime.arm(armed))
  })

  /**
   * What each room display shows (displays.ts): projector, TV 1, TV 2 → table,
   * mirror, datawall, tv or off. The Setup control's re-point goes through the
   * runtime's slot-gated writer, so it reaches the room only when armed (and
   * the device pool keeps it inside the hardware window); disarmed, the choice
   * is remembered and applied on arm.
   */
  app.get('/api/operator/displays', (_req, res) => {
    res.json({ displays: d.runtime.displays(), pages: DISPLAY_PAGES, paths: PAGE_PATH, output: d.runtime.roomOutput() })
  })
  app.post('/api/operator/displays', async (req, res) => {
    const b = (req.body ?? {}) as { id?: unknown; page?: unknown }
    if (!isDisplayId(b.id)) return void res.status(400).json({ error: 'id must be table, tv-1 or tv-2' })
    if (!isDisplayPage(b.page)) return void res.status(400).json({ error: `page must be one of ${DISPLAY_PAGES.join(', ')}` })
    res.json({ displays: await d.runtime.setDisplay(b.id, b.page), pages: DISPLAY_PAGES, paths: PAGE_PATH, output: d.runtime.roomOutput() })
  })

  /**
   * The iPad worksheet's controls, all in one request shape so the page has
   * one call: `on` starts or stops its server, `taskIds` (or the pre-#88
   * `taskId`, one problem) and `textMm` change what the iPad shows (through the worksheet server, its owner), `ruler` lights
   * the check ruler beside it. Applied in that order, so ticking the box and
   * picking a task in one click works.
   */
  app.post('/api/operator/worksheet', async (req, res) => {
    if (!d.worksheet) return void res.status(404).json({ error: 'this server runs without the worksheet' })
    const b = (req.body ?? {}) as { on?: unknown; taskId?: unknown; taskIds?: unknown; textMm?: unknown; ruler?: unknown }
    if (b.on !== undefined) {
      const st = await d.worksheet.setOn(b.on === true)
      if (b.on === true && !st.on) return void res.status(502).json(st)
    }
    // Validation is the worksheet state's (apps/worksheet/state.ts), the one
    // owner of what the iPad shows: passed through as sent, never re-checked
    // here, so the two can't disagree about what a valid sheet is.
    if (b.taskId !== undefined || b.taskIds !== undefined || b.textMm !== undefined) {
      const r = await d.worksheet.show({ taskId: b.taskId, taskIds: b.taskIds, textMm: b.textMm })
      if (!r.ok) return void res.status(400).json(r.status)
    }
    if (b.ruler !== undefined) d.worksheet.setRuler(b.ruler === true)
    res.json(d.worksheet.status())
  })

  const clearTable = () => clearTableOf(d.runtime, d.dismiss)

  /**
   * Switch act. The one implementation: the operator route below and the
   * table agent's set_act/start_lesson tools (#54) both call this, so the
   * agent can't start a lesson that skips clearing the table.
   */
  function setAct(act: unknown, songArg?: unknown): { status: number; error?: string } {
    if (act === 'math') {
      d.runtime.stopLesson()
      return { status: 200 }
    }
    if (act !== 'lesson') return { status: 400, error: 'act must be math or lesson' }
    const song = songArg === undefined ? 'ode-to-joy' : String(songArg)
    // Validated before anything changes (see startLessonAct): a refused song
    // must not have already cleared the table. One implementation, shared
    // with the puppet master's start_lesson.
    if (!startLessonAct(d.runtime, d.dismiss, song)) return { status: 404, error: `unknown song; try ${Object.keys(SONGS).join(', ')}` }
    return { status: 200 }
  }

  app.post('/api/operator/act', (req, res) => {
    const b = (req.body ?? {}) as { act?: unknown; song?: unknown }
    const r = setAct(b.act, b.song)
    if (r.error) return void res.status(r.status).json({ error: r.error })
    res.json(d.runtime.state())
  })

  // Close every surface on the table and stay in the act. The lesson's lit
  // key is not a surface: it *is* the keyboard act (an overlay, not a
  // window), and the operator ends it by switching act or resetting.
  app.post('/api/operator/close-all', (_req, res) => {
    clearTable()
    res.json(d.runtime.state())
  })

  // Back to the start of the show: empty table, math act, idle lights.
  app.post('/api/operator/reset', (_req, res) => {
    clearTable()
    d.runtime.stopLesson()
    d.forgetConversation?.()
    res.json(d.runtime.state())
  })

  app.post('/api/operator/fallback', (req, res) => {
    const name = String((req.body as { answer?: unknown } | undefined)?.answer ?? '')
    if (!Object.hasOwn(FALLBACK_ANSWERS, name)) return void res.status(400).json({ error: `answer must be one of ${Object.keys(FALLBACK_ANSWERS).join(', ')}` })
    const { recording, intent } = FALLBACK_ANSWERS[name as FallbackName]
    const rec = loadRecording(recording)
    const scene = rec.scene ?? undefined
    // 202 at once, like /api/action: the answer reaches the table over SSE,
    // and the operator's click must not hold a request open.
    res.status(202).json({ ok: true, answer: name })
    void d.renderToTable(createReplayBrain(rec.text, rec.scene), { intent, scene })
  })

  return { setAct }
}

async function roomStatus(room: Room | undefined): Promise<{ kind: string; ok: boolean; error?: string; displays?: number; lights?: number }> {
  if (!room) return { kind: 'none', ok: false, error: 'no room (ROOM=none)' }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const info = await Promise.race([
      room.info(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${ROOM_DEADLINE_MS} ms`)), ROOM_DEADLINE_MS)
      }),
    ])
    return { kind: room.kind, ok: true, displays: info.displays.length, lights: info.lights.length }
  } catch (e) {
    return { kind: room.kind, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'room unreachable' }
  } finally {
    clearTimeout(timer)
  }
}
