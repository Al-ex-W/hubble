import { generateText, stepCountIs, tool, type LanguageModel, type ModelMessage, type StopCondition } from 'ai'
import { z } from 'zod'
import { buildSystemPrompt, catalogFor, describeScene, type RenderRequest, type Scene } from '@hubble/stage'
import { applyEdits } from './edits.ts'
import { verifyAnswer, type Verdict } from './verify.ts'
import type { JevConfig } from './jev.ts'
import { thinkingOption } from './llm.ts'

/**
 * The brain's loop, on the AI SDK:
 *
 *   draft ──► verify ──ok──► done
 *               │ problems
 *               ▼
 *   repair agent: edit_answer(find/replace) ──► verify ──► … until it passes
 *
 * The draft is plain text (fastest path, and the format the prompt teaches).
 * Repairs are tool calls carrying small exact edits, never a rewrite, so the
 * user's answer stays as written and only what failed changes. The stop
 * condition *is* our verification: the loop ends the moment it passes, or
 * after MAX_REPAIR_STEPS, whichever comes first.
 */
export const MAX_REPAIR_STEPS = 3

export type Step =
  | { kind: 'draft'; ms: number; text: string }
  | { kind: 'verify'; ms: number; ok: boolean; problems: string[]; jev?: number }
  | { kind: 'edit'; ms: number; edits: { find: string; replace: string }[]; error?: string }

export interface LoopResult {
  text: string
  verdict: Verdict
  steps: Step[]
}

export interface LoopDeps {
  model: LanguageModel
  /** Model for repairs; defaults to `model`. Lets a recorder replay a fixed draft and repair live. */
  repairModel?: LanguageModel
  jev?: JevConfig
  onStep?: (s: Step) => void
  /** Aborts every model call and Jev request: the client left, or the deadline passed. */
  abortSignal?: AbortSignal
}

/**
 * The answer as one versioned record. Text and verdict are only ever replaced
 * together, so whoever reads it (the stop condition, the caller) gets a
 * verdict that belongs to exactly that text.
 */
interface Answer {
  version: number
  text: string
  verdict: Verdict
}

const REPAIR_SYSTEM = [
  'You repair a projected table answer that failed verification.',
  'Use the edit_answer tool with the smallest exact find/replace edits that fix every listed problem.',
  'Do not rewrite the answer and do not change its wording or math: only move or resize panels (x, y, w, near, side), add a missing id, fix an arrow or mark reference, or close a tag.',
  'Each find must match the current answer exactly once. When given a valid spot for a panel, use it.',
].join('\n')

export async function runLoop(req: RenderRequest & { scene: Scene }, deps: LoopDeps): Promise<LoopResult> {
  const steps: Step[] = []
  const log = (s: Step) => {
    steps.push(s)
    deps.onStep?.(s)
  }

  // ---- draft ----
  let t = Date.now()
  const user: ModelMessage = req.image
    ? { role: 'user', content: [{ type: 'text', text: req.intent }, { type: 'image', image: req.image }] }
    : { role: 'user', content: req.intent }
  const draft = await generateText({
    model: deps.model,
    // The same per-table catalog the answer is parsed with (verify.ts), so
    // the model is offered exactly the assets it may use.
    system: buildSystemPrompt({ hasImage: Boolean(req.image), scene: req.scene }, catalogFor(req.scene)),
    messages: [
      // Strings only, checked here as well as at the HTTP edge: a content
      // array would let a history entry carry an image URL, which the SDK
      // downloads server-side.
      ...(req.history ?? []).filter((h) => typeof h.intent === 'string' && typeof h.answer === 'string').flatMap((h): ModelMessage[] => [
        { role: 'user', content: h.intent },
        { role: 'assistant', content: h.answer },
      ]),
      user,
    ],
    maxOutputTokens: req.thinking ? 6000 : 1500,
    providerOptions: thinkingOption(Boolean(req.thinking)),
    abortSignal: deps.abortSignal,
  })
  log({ kind: 'draft', ms: Date.now() - t, text: draft.text })

  t = Date.now()
  const first = await verifyAnswer(draft.text, req.scene, req.intent, deps.jev, deps.abortSignal)
  log({ kind: 'verify', ms: Date.now() - t, ok: first.ok, problems: first.problems, jev: first.jev })
  let answer: Answer = { version: 0, text: draft.text, verdict: first }
  if (first.ok) return { text: answer.text, verdict: answer.verdict, steps }

  // ---- repair: tool loop whose stop condition is our verification ----
  //
  // The SDK runs the tool calls of one step with Promise.all. With the text
  // and verdict as two loose variables, two calls in one step interleaved
  // across verification's await: call A fixed the answer and waited on Jev,
  // call B edited A's text and failed fast, then A's late "ok" landed on B's
  // text. The loop stopped "verified" and the broken answer shipped. Edits
  // therefore run one at a time, each against the latest version, and
  // publish text + verdict in one assignment.
  //
  // Ruling: a later same-step call is applied to the newer version rather
  // than refused. Its finds must still match exactly once, and applyEdits
  // refuses content changes, so the worst case is a refused edit; refusing
  // outright would burn one of three repair steps on recorded sessions that
  // fix two panels at once.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn)
    chain = run.catch(() => undefined)
    return run
  }
  const passed: StopCondition<any> = () => answer.verdict.ok
  await generateText({
    model: deps.repairModel ?? deps.model,
    system: REPAIR_SYSTEM,
    prompt: [
      'The table:',
      describeScene(req.scene),
      '',
      'Current answer:',
      answer.text,
      '',
      'Verification failed:',
      ...first.problems.map((p) => `- ${p}`),
    ].join('\n'),
    tools: {
      edit_answer: tool({
        description: 'Apply exact find/replace edits to the current answer, then re-run verification. Returns the new verification result.',
        inputSchema: z.object({
          edits: z.array(z.object({ find: z.string().describe('Exact text to replace; must occur once'), replace: z.string() })).min(1),
        }),
        execute: ({ edits }) =>
          serial(async () => {
            const base = answer
            const t0 = Date.now()
            const applied = applyEdits(base.text, edits)
            if (!applied.ok) {
              log({ kind: 'edit', ms: Date.now() - t0, edits, error: applied.error })
              return { ok: false, error: applied.error }
            }
            log({ kind: 'edit', ms: Date.now() - t0, edits })
            const t1 = Date.now()
            const verdict = await verifyAnswer(applied.text, req.scene, req.intent, deps.jev, deps.abortSignal)
            answer = { version: base.version + 1, text: applied.text, verdict }
            log({ kind: 'verify', ms: Date.now() - t1, ok: verdict.ok, problems: verdict.problems, jev: verdict.jev })
            return verdict.ok ? { ok: true, version: answer.version } : { ok: false, version: answer.version, problems: verdict.problems }
          }),
      }),
    },
    // 'required' would force a tool call each step, but the aiqu gateway
    // (vLLM) answers it with a 500 (recorded 2026-10-05). With 'auto' a text
    // reply just ends the loop, and the verdict reports whether it passed.
    toolChoice: 'auto',
    stopWhen: [passed, stepCountIs(MAX_REPAIR_STEPS)],
    maxOutputTokens: 1200,
    providerOptions: thinkingOption(false),
    abortSignal: deps.abortSignal,
  })
  // Settle any edit still running (a call the stop condition raced past)
  // before reading the record, so text and verdict are final and paired.
  await chain
  return { text: answer.text, verdict: answer.verdict, steps }
}
