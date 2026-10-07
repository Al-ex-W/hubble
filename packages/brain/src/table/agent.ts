import { generateText, stepCountIs, tool, type LanguageModel, type ModelMessage, type StopCondition, type ToolSet } from 'ai'
import { systemPrompt, toolDescriptions, toolInputs, type TableState, type ToolName } from './spec.ts'

/**
 * The table agent (#54): one long conversation that decides what goes on the
 * table, acting only through tools the runtime executes.
 *
 * Why an agent in front of the brain rather than more inputs straight into
 * renderToTable: before, every input (keyboard SEND, bench chat, the table's
 * "next" button, the operator) took its own path and rebuilt "history" from
 * whatever answer happened to be on the table (and the bench sent none at
 * all, #51). One conversation owns the turns now, so a follow-up from any
 * input knows what came before, and "show the diagram" or "let's play piano"
 * are actions, not answers the model has to fake in panels.
 *
 * What it does NOT own: how an answer looks. `render_answer` hands an intent
 * to the brain's verified draft → verify → repair pipeline unchanged; this
 * agent never writes JSX. And it never touches state directly: every tool
 * goes through the same runtime operations the HTTP routes use, so a tool and
 * a route can't disagree about what "open an asset" means.
 *
 * Shaped by Stage 0 (packages/brain/fixtures/table-agent, 12 real turns): the
 * model puts all its tool calls in the first step (several in parallel when
 * asked for several things); its second step is only a closing sentence that
 * nobody hears (the room has no sound). So a turn stops after the first step
 * whose tool calls all succeeded. A failed call (unknown id, disallowed host)
 * lets the model see the error and try once more.
 *
 * Every turn must call a tool, including the "nothing changes" turns (a
 * greeting, a refusal), which call `say`. That makes "the model chose to
 * leave the table alone" something we can see, distinct from "the model
 * answered in prose that nobody will ever read" (review #55: an `auto`
 * response that explained Pythagoras in plain text left the table silent).
 * A turn where no tool ran at all falls back to render_answer.
 */

export interface ToolOutcome {
  ok: boolean
  /** Shown to the model when ok is false, so it can correct itself. */
  error?: string
  [k: string]: unknown
}

/** The tools that act on the table; `say` is the agent's own (it changes nothing). */
export type ActionName = Exclude<ToolName, 'say'>

/** What each tool does, implemented by the server over the runtime (apps/server/tableAgent.ts). */
export type TableActions = {
  [K in ActionName]: (input: Record<string, unknown>, ctx: ActionContext) => Promise<ToolOutcome> | ToolOutcome
}

/** What an action knows about the turn it runs in. */
export interface ActionContext {
  /** Earlier rendered answers, oldest first: the brain's history for a new render. */
  history: AnswerTurn[]
  /**
   * The app's own per-turn data (the bench's notebook photo and scene), passed
   * through untouched. Carried with the turn, not stashed by the caller, so a
   * turn queued behind another renders with its own photo, never the
   * previous turn's.
   */
  context?: unknown
}

/** A rendered answer, kept so later renders get it as history (what the brain expects). */
export interface AnswerTurn {
  intent: string
  answer: string
}

export interface TurnInput {
  from: 'keyboard' | 'chat' | 'operator' | 'voice'
  text: string
  /** Opaque to the agent; handed to every action of this turn (ActionContext.context). */
  context?: unknown
}

export interface TurnResult {
  from: TurnInput['from']
  text: string
  calls: { name: ToolName; input: unknown; ok: boolean; error?: string }[]
  /** The model's `say` line (greetings, refusals); not shown on the table. */
  reply: string
  /** No tool ran (the agent failed, timed out, or answered in prose), so the text went straight to render_answer. */
  fellBack: boolean
  ms: number
}

export interface TableAgentDeps {
  model: LanguageModel
  state: () => TableState
  actions: TableActions
  /** Until the model's first step returns; past it, the turn falls back. */
  deadlineMs?: number
  /** User turns kept as messages; older ones are dropped. */
  keepTurns?: number
  now?: () => number
  onError?: (err: unknown) => void
}

const DEADLINE_MS = 8000
const KEEP_TURNS = 12
// Answers handed to the brain as history: the brain itself keeps the last 6.
const KEEP_ANSWERS = 6

export function createTableAgent(d: TableAgentDeps) {
  const now = d.now ?? (() => performance.now())
  const deadline = d.deadlineMs ?? DEADLINE_MS
  const keep = d.keepTurns ?? KEEP_TURNS
  let messages: ModelMessage[] = []
  // Bounded on insertion: this agent lives as long as the server, and only
  // the last KEEP_ANSWERS are ever handed on, so keeping more is a leak of
  // whole answers (review #55: 60 renders kept 60).
  const answers: AnswerTurn[] = []
  const remember = (a: AnswerTurn) => {
    answers.push(a)
    if (answers.length > KEEP_ANSWERS) answers.splice(0, answers.length - KEEP_ANSWERS)
  }
  const turns: TurnResult[] = []
  // One turn at a time, in arrival order: two inputs racing (a keyboard SEND
  // while the bench chat is answering) must not interleave their tool calls
  // on one table, or the second's history misses the first.
  let queue: Promise<unknown> = Promise.resolve()

  function trim() {
    // Cut at a user message so a kept window never starts with an orphaned
    // tool result (the provider rejects a tool message without its call).
    let users = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user' && ++users === keep) {
        messages = messages.slice(i)
        return
      }
    }
  }

  async function run(input: TurnInput): Promise<TurnResult> {
    const t0 = now()
    const calls: TurnResult['calls'] = []
    // A copy, taken at the turn's start: an action that keeps its history must
    // not see answers rendered later in the same turn. The bound itself is
    // `remember`'s, the one place answers are added.
    const ctx: ActionContext = { history: answers.slice(), context: input.context }
    let reply = ''
    // The table-changing calls (everything but render_answer and say) still
    // in flight, so a render can wait for them.
    const changing = new Set<Promise<unknown>>()
    const act = async (name: ActionName, args: Record<string, unknown>): Promise<ToolOutcome> => {
      try {
        return await d.actions[name](args, ctx)
      } catch (err) {
        d.onError?.(err)
        return { ok: false, error: 'failed' }
      }
    }
    const tools: ToolSet = Object.fromEntries(
      (Object.keys(toolInputs) as ToolName[]).map((name) => [
        name,
        tool({
          description: toolDescriptions[name],
          inputSchema: toolInputs[name],
          execute: async (raw: unknown) => {
            const args = (raw ?? {}) as Record<string, unknown>
            let out: ToolOutcome
            if (name === 'say') {
              reply = String(args.text ?? '')
              out = { ok: true }
            } else if (name === 'render_answer') {
              // The answer must be verified against the table as this turn
              // leaves it. The SDK runs one step's calls concurrently, and the
              // recordings (explain, followup) put render_answer BEFORE
              // open_asset; rendering at once snapshotted the table without
              // the asset, and the asset then opened on top of a verified
              // answer (review #55: 49,152 px² overlap, both calls ok).
              // So a render first lets its siblings start (they are all
              // started in the same tick, after the step's inputs are parsed:
              // one macrotask is past every one of them) and settle; then the
              // render's surface snapshot includes them. Serialising in the
              // recorded order would not do: render still comes first.
              await new Promise((r) => setTimeout(r, 0))
              await Promise.allSettled([...changing])
              out = await act(name, args)
              if (out.ok && typeof out.answer === 'string' && out.answer) remember({ intent: String(args.intent ?? ''), answer: out.answer })
            } else {
              const p = act(name, args)
              changing.add(p)
              out = await p.finally(() => changing.delete(p))
            }
            calls.push({ name, input: args, ok: out.ok, ...(out.error ? { error: out.error } : {}) })
            return out
          },
        }),
      ]),
    )
    // Stop after the first step that called tools and had them all succeed:
    // Stage 0 showed the rest is a closing sentence nobody hears.
    // Judged on the LAST step only: a refused call followed by a corrected
    // one must stop after the correction, not keep going because the turn
    // once had a failure in it.
    //
    // Clean means every call the model asked for has a successful result.
    // Counting only the results that exist is not enough: a call whose input
    // fails its schema is never executed and has no result, so "every result
    // ok" was vacuously true and the turn ended with nothing done and no
    // retry (review #55, the notebook call with an empty intent).
    const actedCleanly: StopCondition<ToolSet> = ({ steps }) => {
      const last = steps.at(-1)
      if (!last || last.toolCalls.length === 0) return false
      const ok = new Set(last.toolResults.filter((r) => (r.output as ToolOutcome | undefined)?.ok !== false).map((r) => r.toolCallId))
      return last.toolCalls.every((c) => ok.has(c.toolCallId))
    }
    const userMsg: ModelMessage = { role: 'user', content: input.text }
    let fellBack = false
    // The table must never go silent because the agent did. When no tool ran
    // at all, the text itself becomes the question, as before the agent
    // existed. After a tool ran (even a refused one the model was told
    // about), the table already reflects the agent's choice: don't add a
    // second, unasked answer on top.
    const fallBack = async () => {
      if (calls.length > 0) return
      fellBack = true
      const out = await act('render_answer', { intent: input.text })
      calls.push({ name: 'render_answer', input: { intent: input.text }, ok: out.ok })
      if (out.ok && typeof out.answer === 'string' && out.answer) remember({ intent: input.text, answer: out.answer })
    }
    try {
      const r = await generateText({
        model: d.model,
        system: systemPrompt(d.state()),
        messages: [...messages, userMsg],
        tools,
        // 'required' returns a 500 on the aiqu gateway (AGENTS.md); 'auto' is
        // also what lets a greeting go without touching the table.
        toolChoice: 'auto',
        stopWhen: [actedCleanly, stepCountIs(3)],
        abortSignal: AbortSignal.timeout(deadline),
      })
      // Prose without a say is kept as the reply for the bench to show, but
      // it is not a choice to leave the table alone: it falls back below.
      reply ||= r.text
      messages.push(userMsg, ...r.response.messages)
      await fallBack()
    } catch (err) {
      d.onError?.(err)
      await fallBack()
      // Keep the turn in the conversation either way, so the next turn
      // knows it was asked.
      messages.push(userMsg, { role: 'assistant', content: fellBack ? '(answered directly)' : '(interrupted)' })
    }
    trim()
    const result: TurnResult = { from: input.from, text: input.text, calls, reply, fellBack, ms: Math.round(now() - t0) }
    turns.push(result)
    if (turns.length > 50) turns.shift()
    return result
  }

  return {
    turn(input: TurnInput): Promise<TurnResult> {
      const next = queue.then(() => run(input))
      queue = next.catch(() => undefined)
      return next
    },
    /** Recent turns, for the bench's agent view. */
    history(): readonly TurnResult[] {
      return turns
    },
    /** The rendered answers the brain gets as history. */
    answers(): readonly AnswerTurn[] {
      return answers
    },
  }
}

export type TableAgent = ReturnType<typeof createTableAgent>
