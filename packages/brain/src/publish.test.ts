import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { loadRecording } from '@hubble/stage/testing'
import type { RenderStreamLine, Scene, StageEvent } from '@hubble/stage'
import { runLoop, type Step } from './agent.ts'
import { applyEdits, visibleContent } from './edits.ts'
import { FAILURE_TEXT, createBrain, failureAnswer } from './render.ts'
import { verifyAnswer } from './verify.ts'

/**
 * Issue #14: what may reach the table, and how a render is bounded.
 *
 * Fixtures: fixtures/repairs/*.json (label: recording) and the stage-streams
 * recordings; where a case needs a shape no recording has, it is a
 * mechanical mutation of one (named at each test). Oracles are plain string
 * and rectangle checks, not the verifier's own helpers.
 */
const DIR = new URL('../fixtures/repairs/', import.meta.url)
interface Session {
  stream: string
  steps: Step[]
}
const SESSIONS: Session[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, DIR), 'utf8')))
const session = (name: string) => SESSIONS.find((s) => s.stream === name)!
const editsOf = (s: Session) => s.steps.filter((x): x is Extract<Step, { kind: 'edit' }> => x.kind === 'edit')

const usage = () => ({ inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } }) as never
const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: usage(), warnings: [] })
const toolCalls = (...calls: unknown[]) => ({
  content: calls.map((edits, i) => ({ type: 'tool-call' as const, toolCallId: `c${i}`, toolName: 'edit_answer', input: JSON.stringify({ edits }) })),
  finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
  usage: usage(),
  warnings: [],
})
const LLM = { baseUrl: 'https://llm.example/v1', apiKey: 'sk-secret-123', model: 'aixia-labs' }

async function collect(brain: ReturnType<typeof createBrain>, req: Parameters<ReturnType<typeof createBrain>['render']>[0], opts?: { signal?: AbortSignal }) {
  const lines: RenderStreamLine[] = []
  await brain.render(req, (l) => lines.push(l), opts)
  const events = lines.flatMap((l) => (l.kind === 'event' ? [l.event] : []))
  const shown = events.flatMap((e) => (e.type === 'text' ? [e.text] : e.type === 'piece' ? [e.body] : [])).join('')
  return { lines, events, shown, error: lines.find((l) => l.kind === 'error') as Extract<RenderStreamLine, { kind: 'error' }> | undefined, done: lines.at(-1) as Extract<RenderStreamLine, { kind: 'done' }> }
}

describe('publishing: only verified answers reach the table', () => {
  it.each(SESSIONS.map((s) => [s.stream, s] as const))('%s: a repair model that answers in text ships the failure line, not the draft', async (_n, s) => {
    const rec = loadRecording(s.stream)
    const brain = createBrain({
      llm: LLM,
      // Recorded draft; the repair turn replies with text instead of calling
      // edit_answer, which 'auto' tool choice allows (the reviewed repro).
      model: () => new MockLanguageModelV4({ doGenerate: [textResult(rec.text), textResult('The layout looks fine to me.')] }),
    })
    const { shown, error, done } = await collect(brain, { intent: 'x', scene: rec.scene! })
    // Break caught: an answer that failed verification being drawn anyway.
    const math = [...rec.text.matchAll(/<Math>([^<]+)<\/Math>/g)].map((m) => m[1])
    for (const m of math) expect(shown).not.toContain(m)
    expect(shown.replace(/\s+/g, ' ').trim()).toBe(FAILURE_TEXT)
    expect(error?.message).toBe('unverified')
    // Break caught: the rejected text coming back as conversation history.
    expect(done.answer).toBe('')
  })

  it.each(SESSIONS.map((s) => [s.stream, s] as const))('%s: the failure line itself is clear of every object', async (_n, s) => {
    const scene = loadRecording(s.stream).scene!
    const text = await failureAnswer(scene)
    expect(text).not.toBeNull()
    const [x, y, w] = [/x=\{(\d+)\}/, /y=\{(\d+)\}/, /w=\{(\d+)\}/].map((r) => Number(r.exec(text!)![1]))
    // Plain rectangle maths, one line of text: the notice must not land on a notebook.
    for (const o of scene.objects) expect(x + w <= o.box.x || o.box.x + o.box.w <= x || y + 60 <= o.box.y || o.box.y + o.box.h <= y).toBe(true)
  })
})

describe('verifyAnswer: an answer must show something, completely', () => {
  const scene = loadRecording('scene-linear-left').scene!
  // Each of these used to verify `ok` (review repros).
  it.each([
    ['empty reply', ''],
    ['a bare apology (stray text the parser drops)', 'Sorry'],
    ['an empty Canvas', '<Canvas>\n</Canvas>'],
  ])('rejects %s', async (_n, text) => {
    expect((await verifyAnswer(text, scene, '')).ok).toBe(false)
  })

  it('rejects a verified recording cut off before its last closing tags (mechanical mutation)', async () => {
    const rec = loadRecording('scene-linear-left')
    expect((await verifyAnswer(rec.text, scene, '')).ok).toBe(true)
    // Cut at the last </Panel>: everything inside is whole, only the closes are missing.
    const cut = rec.text.slice(0, rec.text.lastIndexOf('</Panel>'))
    expect(cut.length).toBeGreaterThan(100)
    // Break caught: the parser closing frames itself made a truncated answer look complete.
    const v = await verifyAnswer(cut, scene, '')
    expect(v.ok).toBe(false)
    expect(v.problems.join('\n')).toMatch(/cut off/)
  })
})

describe('applyEdits: repairs move things, the code refuses anything else', () => {
  it('accepts every recorded repair edit', () => {
    for (const s of SESSIONS) {
      let text = s.steps[0].kind === 'draft' ? s.steps[0].text : ''
      for (const e of editsOf(s)) {
        const r = applyEdits(text, e.edits)
        expect(r.ok, `${s.stream}: ${r.ok ? '' : r.error}`).toBe(true)
        if (r.ok) text = r.text
      }
    }
  })

  it('refuses a recorded edit mutated to also change the Math (mechanical mutation)', () => {
    const rec = loadRecording('scene-crowded')
    const [edit] = editsOf(session('scene-crowded'))[0].edits
    // Break caught: a "layout fix" that rewrites what the user reads.
    const sneaky = [edit, { find: '<Math>x = y + 1</Math>', replace: '<Math>x = y + 2</Math>' }]
    expect(rec.text).toContain(sneaky[1].find)
    const r = applyEdits(rec.text, sneaky)
    expect(r.ok).toBe(false)
  })

  it('refuses an edit that drops prose along with a tag', () => {
    const rec = loadRecording('scene-crowded')
    const r = applyEdits(rec.text, [{ find: '<Text>Back-substitute.</Text>', replace: '' }])
    expect(r.ok).toBe(false)
  })

  it('sees a change inside TeX that holds a literal < (recorded inequality)', () => {
    const rec = loadRecording('math-inequality')
    // Break caught: a tag pattern that swallows `< 11</Math>` as a tag, hiding the change.
    expect(visibleContent(rec.text)).toContain('x < 11')
    expect(applyEdits(rec.text, [{ find: 'x < 11', replace: 'x < 12' }]).ok).toBe(false)
  })

  it('treats overlapping matches as ambiguous', () => {
    // Break caught: split() counts "aa" once in "aaa", so the edit was applied to a guess.
    expect(applyEdits('<Text>aaa</Text>', [{ find: 'aa', replace: 'aa' }]).ok).toBe(false)
  })
})

describe('repair hints are valid spots or none', () => {
  const crowded = session('scene-crowded')
  const draft = crowded.steps[0].kind === 'draft' ? crowded.steps[0].text : ''
  const hints = (problems: string[]) =>
    problems.flatMap((p) => {
      const m = /x=\{(-?\d+)\} y=\{(-?\d+)\} w=\{(\d+)\} \(height follows the content, about (\d+) px/.exec(p)
      return m ? [{ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }] : []
    })

  it('gives no spot to content taller than the table (mechanical mutation: a shorter table)', async () => {
    const scene0 = loadRecording('scene-crowded').scene!
    // The recorded panel is estimated at 676 px; a 600 px table cannot hold it.
    const scene: Scene = { ...scene0, surface: { ...scene0.surface, heightPx: 600 } }
    const v = await verifyAnswer(draft, scene, '')
    expect(v.ok).toBe(false)
    // Break caught: placePanel clamps the height, so the old hint "fit" only by cutting the panel's bottom off.
    for (const h of hints(v.problems)) expect(h.y + h.h).toBeLessThanOrEqual(scene.surface.heightPx - 30)
  })

  it('never points at a later panel that already verifies (mechanical mutation: a second panel added)', async () => {
    const scene = loadRecording('scene-crowded').scene!
    const before = await verifyAnswer(draft, scene, '')
    const [spot] = hints(before.problems)
    expect(spot).toBeDefined()
    // A small, valid panel placed exactly where the recorded hint pointed, written after the failing one.
    const extra = `<Panel id="tip" x={${spot.x}} y={${spot.y}} w={${spot.w}}>\n<Text>Check by substituting.</Text>\n</Panel>\n`
    const text = draft.replace('</Canvas>', `${extra}</Canvas>`)
    const v = await verifyAnswer(text, scene, '')
    expect(v.problems.some((p) => p.startsWith('Panel id="tip"'))).toBe(false)
    const tip = { x: spot.x, y: spot.y, w: spot.w, h: 120 }
    // Break caught: hints computed only against panels written before the failing one.
    for (const h of hints(v.problems)) expect(h.x + h.w <= tip.x || tip.x + tip.w <= h.x || h.y + h.h <= tip.y || tip.y + tip.h <= h.y).toBe(true)
  })
})

describe('repair edits are serialised against one versioned answer', () => {
  it('two edits in one step never leave a verdict for an older text (recorded session, both calls in one step)', async () => {
    const s = session('scene-crowded')
    const rec = loadRecording(s.stream)
    const fix = editsOf(s)[0].edits
    // The second same-step call undoes the move: valid as an edit, broken as a layout.
    const undo = [{ find: fix[0].replace, replace: fix[0].find }]
    const draft = new MockLanguageModelV4({ doGenerate: textResult(rec.text) })
    const repair = new MockLanguageModelV4({ doGenerate: [toolCalls(fix, undo), textResult('done')] })
    // Jev answers slowly and only for answers with no problems, which is
    // exactly the window the race needs: the fixed text waits on Jev while
    // the undone one verifies (and fails) first.
    const jev = {
      apiKey: 'jev-test',
      fetchImpl: (async () => {
        await new Promise((r) => setTimeout(r, 30))
        return new Response(JSON.stringify({ answers: { q: { noul: 0.9 } } }))
      }) as typeof fetch,
    }
    const r = await runLoop({ intent: 'x', scene: rec.scene! }, { model: draft, repairModel: repair, jev })
    // Break caught: verdict.ok from the fixed text paired with the undone text.
    const truth = await verifyAnswer(r.text, rec.scene!, 'x')
    expect(r.verdict.ok).toBe(truth.ok)
    expect(r.verdict.problems).toEqual(truth.problems)
  })
})

describe('the request lifecycle', () => {
  const rec = loadRecording('scene-linear-left')
  /** A model that answers only when aborted, like a stuck gateway. */
  const hanging = () => {
    const seen: (AbortSignal | undefined)[] = []
    const model = new MockLanguageModelV4({
      doGenerate: (opts) => {
        seen.push(opts.abortSignal)
        return new Promise((_, reject) => opts.abortSignal?.addEventListener('abort', () => reject(opts.abortSignal!.reason)))
      },
    })
    return { model, seen }
  }

  it('stops the model call at the deadline and shows the failure line', async () => {
    const { model, seen } = hanging()
    const brain = createBrain({ llm: LLM, model: () => model, deadlineMs: 50 })
    const { shown, error } = await collect(brain, { intent: 'x', scene: rec.scene! })
    // Break caught: a stuck gateway holding the request (and the table) forever.
    expect(seen[0]?.aborted).toBe(true)
    expect(error?.message).toBe('deadline')
    expect(shown.replace(/\s+/g, ' ').trim()).toBe(FAILURE_TEXT)
  })

  it('aborts the model call when the caller cancels, and shows nothing', async () => {
    const { model, seen } = hanging()
    const brain = createBrain({ llm: LLM, model: () => model })
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 20)
    const { events, error } = await collect(brain, { intent: 'x', scene: rec.scene! }, { signal: ctl.signal })
    expect(seen[0]?.aborted).toBe(true)
    expect(error?.message).toBe('cancelled')
    expect(events.filter((e: StageEvent) => e.type !== 'end')).toEqual([])
  })

  it('sends a short code outward and the details only to onError', async () => {
    const logged: unknown[] = []
    const brain = createBrain({
      llm: LLM,
      onError: (e) => logged.push(e),
      model: () =>
        new MockLanguageModelV4({
          doGenerate: async () => {
            throw new Error(`401 from gateway: {"error":"bad key","echo":"Authorization: Bearer ${LLM.apiKey}"}`)
          },
        }),
    })
    const { lines, error } = await collect(brain, { intent: 'x', scene: rec.scene! })
    // Break caught: an upstream body (echoing the key) mirrored to every table display.
    expect(error?.message).toBe('model-error')
    expect(JSON.stringify(lines)).not.toContain(LLM.apiKey)
    expect(String(logged[0])).toContain('401')
  })
})
