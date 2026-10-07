import { writeFileSync } from 'node:fs'
import { MockLanguageModelV4 } from 'ai/test'
import { listRecordings, loadRecording } from '@hubble/stage/testing'
import { runLoop } from '../src/agent.ts'
import { verifyAnswer } from '../src/verify.ts'
import { aiquModel } from '../src/llm.ts'

/**
 * Records real repair sessions: each scene-aware stream whose layout fails
 * verification is replayed as the draft, and aixia-labs repairs it live with
 * edit_answer. The saved tool calls are what the loop tests replay.
 *
 *   npx tsx packages/brain/scripts/record-repairs.ts   (from the app repo root)
 */
try {
  process.loadEnvFile()
} catch {
  /* rely on the environment */
}
const live = aiquModel({ baseUrl: process.env.HUBBLE_LLM_BASE_URL ?? 'https://llm.aiqu.ai/v1', apiKey: process.env.HUBBLE_LLM_API_KEY!, model: 'aixia-labs' })
const OUT = new URL('../fixtures/repairs/', import.meta.url)

for (const name of listRecordings().filter((n) => n.startsWith('scene-'))) {
  const rec = loadRecording(name)
  const before = await verifyAnswer(rec.text, rec.scene!, '')
  if (before.ok) continue
  const draftModel = new MockLanguageModelV4({
    doGenerate: { content: [{ type: 'text', text: rec.text }], finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(), warnings: [] },
  })
  const t0 = Date.now()
  const r = await runLoop({ intent: (rec as { intent?: string }).intent ?? '', scene: rec.scene! }, { model: draftModel, repairModel: live })
  const edits = r.steps.filter((s) => s.kind === 'edit')
  writeFileSync(
    new URL(`${name}.json`, OUT),
    JSON.stringify({ label: 'recording', recordedAt: new Date().toISOString(), model: 'aixia-labs', stream: name, ms: Date.now() - t0, steps: r.steps, finalOk: r.verdict.ok, finalText: r.text }, null, 1),
  )
  console.log(`${name}: ${before.problems.filter((p) => !p.startsWith('  ')).length} problems → ${edits.length} edit call(s) → ${r.verdict.ok ? 'VERIFIED' : 'still failing: ' + r.verdict.problems[0]} (${Date.now() - t0} ms)`)
}

function usage() {
  return { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } as never
}
