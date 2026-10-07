import { DEFAULT_SURFACE, PANEL_MM, clearances, layoutReport, placePanel, pxFromMm, type RenderRequest, type RenderStreamLine, type Scene } from '@hubble/stage'
import { runLoop, type Step } from './agent.ts'
import { aiquModel, type LlmConfig } from './llm.ts'
import { parseAnswer, verifyAnswer } from './verify.ts'
import type { JevConfig } from './jev.ts'
import type { LanguageModel } from 'ai'

/**
 * One table answer, end to end, as the stream contract the server relays.
 * Nothing reaches the table until the loop has verified it; the agent tab
 * sees every step as it happens through `trace` lines.
 */
export interface BrainConfig {
  llm: LlmConfig
  jev?: JevConfig
  /** Tests inject a recorded model here. */
  model?: (name: string) => LanguageModel
  /**
   * Full error details, for the server log only. The stream carries a short
   * code instead, because it is mirrored to every table display and upstream
   * error bodies can echo request headers.
   */
  onError?: (err: unknown) => void
  /** Overrides the deadline (tests use a short one rather than waiting 15 s). */
  deadlineMs?: number
}

export interface RenderOptions {
  /** Aborted when the client goes away; every model call stops with it. */
  signal?: AbortSignal
}

/**
 * What `error` lines say. Codes, not messages: the bench shows them, the
 * table ignores them, and nothing upstream (status bodies, keys in echoed
 * headers) can travel through them.
 */
export type RenderErrorCode = 'unverified' | 'deadline' | 'cancelled' | 'model-error'

/**
 * Overall budget for one answer, draft + repairs + Jev. Measured: verified
 * answers take 1.3–2.2 s live, so 15 s only ever cuts a stuck gateway (the
 * SDK's own retries included). Thinking mode drafts up to 6000 tokens at
 * ~350 tok/s, about 17 s, so it gets twice the budget.
 */
export const DEADLINE_MS = 15_000
export const THINKING_DEADLINE_MS = 30_000

export const FAILURE_TEXT = "I couldn't fit that answer on the table. Please ask again."

/**
 * The line shown instead of an answer that never verified. It goes through
 * the same verification as any answer (it is placed beside nothing, in a
 * clear spot near the user's edge), so the failure path can't put light on a
 * notebook either. `null` when even that has no room: the table stays empty.
 */
export async function failureAnswer(scene: Scene): Promise<string | null> {
  const { surface } = scene
  const w = Math.round(pxFromMm(surface, PANEL_MM.default))
  const write = (x: number, y: number) => `<Canvas>\n<Panel id="notice" x={${x}} y={${y}} w={${w}}>\n<Text>${FAILURE_TEXT}</Text>\n</Panel>\n</Canvas>`
  const h = layoutReport(parseAnswer(write(0, 0)), scene).panels[0]?.asked.h ?? 0
  // Bottom centre first: that edge faces the user.
  const spot = placePanel({ x: Math.round((surface.widthPx - w) / 2), y: surface.heightPx - clearances(surface).edge - h, w }, scene, [], h)
  const text = write(Math.round(spot.x), Math.round(spot.y))
  return (await verifyAnswer(text, scene, '')).ok ? text : null
}

export function createBrain(cfg: BrainConfig) {
  return {
    async render(req: RenderRequest, emit: (line: RenderStreamLine) => void, opts: RenderOptions = {}): Promise<void> {
      const renderId = Math.random().toString(36).slice(2, 10)
      const t0 = Date.now()
      const t = () => Date.now() - t0
      const scene = req.scene ?? { surface: DEFAULT_SURFACE, objects: [] }
      const modelName = req.model ?? cfg.llm.model
      emit({ kind: 'start', renderId, intent: req.intent, model: modelName, t: 0, scene })

      const trace = (s: Step) => {
        const detail =
          s.kind === 'draft'
            ? `draft written in ${s.ms} ms (${s.text.length} chars)`
            : s.kind === 'verify'
              ? s.ok
                ? `verified in ${s.ms} ms${s.jev !== undefined ? ` (Jev placement ${s.jev.toFixed(2)})` : ''}`
                : `${s.problems.filter((p) => !p.startsWith('  ')).length} problem(s) found`
              : s.error
                ? `edit refused: ${s.error}`
                : `${s.edits.length} edit(s) applied`
        emit({ kind: 'trace', renderId, t: t(), step: s.kind, detail, data: s })
        if (s.kind === 'draft') emit({ kind: 'raw', renderId, t: t(), text: s.text })
      }

      // The table cleared on `start`, so a render that can't publish shows a
      // verified failure line rather than nothing, and never the invalid
      // answer: the renderer's guard only moves panels, it can't close a cut
      // Panel or put back content that isn't there. `done.answer` is empty so
      // the bench doesn't feed the rejected text back as history.
      const fail = async (code: RenderErrorCode) => {
        const notice = code === 'cancelled' ? null : await failureAnswer(scene)
        // Displays wait for an `end`; the notice brings its own.
        const events = notice ? parseAnswer(notice) : [{ type: 'end' as const, reason: 'truncated' as const }]
        for (const event of events) emit({ kind: 'event', renderId, t: t(), event })
        emit({ kind: 'error', renderId, t: t(), message: code })
        emit({ kind: 'done', renderId, t: t(), answer: '', firstContentMs: null })
      }

      const deadline = AbortSignal.timeout(cfg.deadlineMs ?? (req.thinking ? THINKING_DEADLINE_MS : DEADLINE_MS))
      const abortSignal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline
      try {
        const model = cfg.model?.(modelName) ?? aiquModel(cfg.llm, modelName)
        const result = await runLoop({ ...req, scene }, { model, jev: cfg.jev, onStep: trace, abortSignal })
        if (!result.verdict.ok) {
          emit({ kind: 'trace', renderId, t: t(), step: 'ship', detail: `withheld: ${result.verdict.problems.length} unresolved problem(s); showing a failure line instead` })
          await fail('unverified')
          return
        }
        for (const event of result.verdict.events) emit({ kind: 'event', renderId, t: t(), event })
        emit({ kind: 'done', renderId, t: t(), answer: result.text, firstContentMs: null })
      } catch (err) {
        // Order matters: a client that left also trips the combined signal,
        // and that is a cancel, not a deadline.
        const code: RenderErrorCode = opts.signal?.aborted ? 'cancelled' : deadline.aborted ? 'deadline' : 'model-error'
        if (code === 'model-error') cfg.onError?.(err)
        await fail(code)
      }
    },
  }
}
