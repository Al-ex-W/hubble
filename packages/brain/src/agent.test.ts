import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { loadRecording } from '@hubble/stage/testing'
import { runLoop, type Step } from './agent.ts'
import { verifyAnswer } from './verify.ts'

/**
 * Fixtures: fixtures/repairs/*.json, real repair sessions (label: recording):
 * a scene-aware aixia-labs draft that failed verification, and the
 * edit_answer calls aixia-labs made live to fix it. The tests replay those
 * calls through the AI SDK's mock model, so the real verification, edit
 * application and stop condition run unchanged.
 */
const DIR = new URL('../fixtures/repairs/', import.meta.url)
interface Session {
  stream: string
  steps: Step[]
  finalOk: boolean
}
const SESSIONS: Session[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, DIR), 'utf8')))

const usage = () => ({ inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } }) as never
const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: usage(), warnings: [] })
const toolResult = (edits: unknown, i: number) => ({
  content: [{ type: 'tool-call' as const, toolCallId: `c${i}`, toolName: 'edit_answer', input: JSON.stringify({ edits }) }],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
  usage: usage(),
  warnings: [],
})

function replay(s: Session) {
  const rec = loadRecording(s.stream)
  const edits = s.steps.filter((x): x is Extract<Step, { kind: 'edit' }> => x.kind === 'edit')
  return {
    rec,
    draft: new MockLanguageModelV4({ doGenerate: textResult(rec.text) }),
    // The recorded calls in order, then a closing text turn in case the loop
    // keeps going (it must not: the stop condition ends it on success).
    repair: new MockLanguageModelV4({ doGenerate: [...edits.map((e, i) => toolResult(e.edits, i)), textResult('done')] }),
    editCount: edits.length,
  }
}

const bodies = (text: string) => [...text.matchAll(/<(Math|Equations|Heading)[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2])
const prose = (text: string) => [...text.matchAll(/<(Text|Item|Note|Cell)[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2])

describe('runLoop over recorded repair sessions', () => {
  it('has the recorded sessions', () => {
    expect(SESSIONS.length).toBe(6)
    expect(SESSIONS.every((s) => s.finalOk)).toBe(true)
  })

  it.each(SESSIONS.map((s) => [s.stream, s] as const))('%s: repairs until verification passes, then stops', async (_n, s) => {
    const { rec, draft, repair, editCount } = replay(s)
    const before = await verifyAnswer(rec.text, rec.scene!, '')
    expect(before.ok).toBe(false)
    const r = await runLoop({ intent: '', scene: rec.scene! }, { model: draft, repairModel: repair })
    // Break caught: rendering an answer that failed verification.
    expect(r.verdict.ok).toBe(true)
    // The stop condition is our verification: no model call after it passed.
    expect(repair.doGenerateCalls.length).toBe(editCount)
  })

  it.each(SESSIONS.map((s) => [s.stream, s] as const))('%s: repairs move things, never rewrite the answer', async (_n, s) => {
    const { rec, draft, repair } = replay(s)
    const r = await runLoop({ intent: '', scene: rec.scene! }, { model: draft, repairModel: repair })
    // Break caught: a "fix" that changes the math or the words the user reads.
    expect(bodies(r.text)).toEqual(bodies(rec.text))
    expect(prose(r.text)).toEqual(prose(rec.text))
  })

  it('does not call the repair model when the draft already verifies', async () => {
    const rec = loadRecording('scene-linear-left')
    const draft = new MockLanguageModelV4({ doGenerate: textResult(rec.text) })
    const repair = new MockLanguageModelV4({ doGenerate: textResult('unused') })
    const r = await runLoop({ intent: '', scene: rec.scene! }, { model: draft, repairModel: repair })
    expect(r.verdict.ok).toBe(true)
    expect(repair.doGenerateCalls.length).toBe(0)
  })
})
