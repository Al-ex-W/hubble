/**
 * Stage 0 for the table agent (#54): how does aixia-labs on the aiqu gateway
 * actually use these tools? Sends real turns with the product's own prompt and
 * tools (src/table/spec.ts) and writes each session to
 * packages/brain/fixtures/table-agent/<name>.json (label: RECORDING).
 *
 * Tools are not executed against a runtime here: each returns a plausible,
 * fixed result ("opened", "rendered") so multi-step turns can continue, and
 * the recording keeps exactly what the model asked for.
 *
 *   npx tsx packages/brain/scripts/record-table-agent.ts [nameFilter]
 * Reads HUBBLE_LLM_API_KEY from the repo's .env (never printed).
 */
import { config as loadEnv } from 'dotenv'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateText, stepCountIs, tool, type ModelMessage } from 'ai'
import { aiquModel } from '../src/llm.ts'
import { systemPrompt, toolDescriptions, toolInputs, type TableState, type ToolName } from '../src/table/spec.ts'

const here = dirname(fileURLToPath(import.meta.url))
// The app repo's root .env (this package is a submodule under packages/brain).
loadEnv({ path: join(here, '../../../.env') })
const apiKey = process.env.HUBBLE_LLM_API_KEY
if (!apiKey) throw new Error('HUBBLE_LLM_API_KEY not set')
const model = aiquModel({ baseUrl: process.env.HUBBLE_LLM_BASE_URL ?? 'https://llm.aiqu.ai/v1', apiKey, model: 'aixia-labs' })

const base: TableState = {
  act: 'math',
  lesson: null,
  surfaces: [],
  assets: [
    { id: 'right-triangle', kind: 'image', title: 'Right triangle with legs a, b and hypotenuse c (Pythagoras)' },
    { id: 'unit-circle', kind: 'image', title: 'Unit circle with an angle theta, its sine and cosine' },
    { id: 'worksheet', kind: 'image', title: 'Photo of a handwritten maths worksheet (Swedish tasks)' },
  ],
  webHosts: ['en.wikipedia.org', 'sv.wikipedia.org', 'www.desmos.com', 'developer.mozilla.org'],
  songs: [
    { id: 'ode-to-joy', title: 'Ode to Joy' },
    { id: 'twinkle', title: 'Twinkle Twinkle Little Star' },
  ],
}
const answerOn: TableState = { ...base, surfaces: [{ id: 'answer', kind: 'answer', title: 'Pythagorean theorem', xMm: 172, yMm: 156, wMm: 484, hMm: 300 }] }
// A cup the camera saw, for "draw a circle around my cup" (draw_svg must
// place by the objects list). Size and spot as on the real table: an 85 mm
// mug, right of centre.
const cupOn: TableState = { ...base, objects: [{ id: 'cup', kind: 'cup', label: 'coffee cup', xMm: 1000, yMm: 400, wMm: 85, hMm: 85 }] }
const notebookOn: TableState = { ...base, surfaces: [{ id: 'notebook', kind: 'notebook', title: 'notebook (object)', xMm: 230, yMm: 300, wMm: 210, hMm: 297 }] }

// Each case: a table, prior turns (for follow-ups), the user's turn, and what
// we'd expect (for the census only; the recording stores what really happened).
type Case = { name: string; state: TableState; prior?: ModelMessage[]; user: string; expect: ToolName[] | 'none' }
const CASES: Case[] = [
  { name: 'explain', state: base, user: 'Explain the Pythagorean theorem', expect: ['render_answer'] },
  { name: 'notebook', state: notebookOn, user: 'Solve the task in my notebook', expect: ['render_answer'] },
  { name: 'asset', state: base, user: 'Show me the right triangle diagram', expect: ['open_asset'] },
  { name: 'web', state: base, user: 'Open the Wikipedia page about integrals', expect: ['open_web'] },
  { name: 'piano', state: base, user: "Let's play piano, teach me Ode to Joy", expect: ['start_lesson'] },
  { name: 'close', state: answerOn, user: 'Close that', expect: ['close_surface'] },
  { name: 'keyboard', state: base, user: 'I want to type something', expect: ['show_keyboard'] },
  { name: 'two-tools', state: base, user: 'Show the unit circle and explain what sine is', expect: ['open_asset', 'render_answer'] },
  { name: 'hello', state: base, user: 'Hi Hubble!', expect: ['say'] },
  { name: 'unknown-asset', state: base, user: 'Show me a picture of a cat', expect: ['say'] },
  { name: 'bad-host', state: base, user: 'Open youtube.com', expect: ['say'] },
  // draw_svg (2026-10-07): the model makes up a drawing, places it by mm.
  { name: 'draw-star', state: base, user: 'Draw a big star in the middle of the table', expect: ['draw_svg'] },
  { name: 'draw-around-cup', state: cupOn, user: 'Draw a circle around my cup', expect: ['draw_svg'] },
  { name: 'draw-smiley', state: base, user: 'Draw a smiley face', expect: ['draw_svg'] },
  {
    name: 'followup',
    state: answerOn,
    prior: [
      { role: 'user', content: 'Explain the Pythagorean theorem' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'p1', toolName: 'render_answer', input: { intent: 'Explain the Pythagorean theorem with a worked example' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'p1', toolName: 'render_answer', output: { type: 'json', value: { ok: true, onTable: 'answer' } } }] },
    ],
    user: 'Now show me how to prove it',
    expect: ['render_answer'],
  },
]

const results: Record<ToolName, unknown> = {
  render_answer: { ok: true, onTable: 'answer' },
  open_asset: { ok: true, surface: 'asset' },
  open_web: { ok: true, surface: 'web' },
  draw_svg: { ok: true, id: 'drawing-1' },
  show_keyboard: { ok: true, surface: 'swipe-keyboard' },
  close_surface: { ok: true },
  start_lesson: { ok: true },
  set_act: { ok: true },
  say: { ok: true },
}

const filter = process.argv[2]
const out = join(here, '../fixtures/table-agent')
mkdirSync(out, { recursive: true })
for (const c of CASES) {
  if (filter && !c.name.includes(filter)) continue
  const calls: { step: number; name: string; input: unknown; tMs: number }[] = []
  const t0 = performance.now()
  let step = 0
  const tools = Object.fromEntries(
    (Object.keys(toolInputs) as ToolName[]).map((n) => [
      n,
      tool({
        description: toolDescriptions[n],
        inputSchema: toolInputs[n],
        execute: async (input: unknown) => {
          calls.push({ step, name: n, input, tMs: Math.round(performance.now() - t0) })
          return results[n]
        },
      }),
    ]),
  )
  let record: Record<string, unknown>
  try {
    const r = await generateText({
      model,
      // The gateway caches identical requests (AGENTS.md): a nonce keeps each
      // recording a real model call.
      system: `${systemPrompt(c.state)}\n\n<!-- nonce ${Date.now()}-${Math.random().toString(36).slice(2)} -->`,
      messages: [...(c.prior ?? []), { role: 'user', content: c.user }],
      tools,
      toolChoice: 'auto',
      stopWhen: stepCountIs(4),
      onStepFinish: () => {
        step++
      },
    })
    record = {
      label: 'recording',
      model: 'aixia-labs',
      recordedAt: new Date().toISOString(),
      case: c,
      calls,
      text: r.text,
      steps: r.steps.map((s) => ({ finishReason: s.finishReason, toolCalls: s.toolCalls.map((t) => ({ name: t.toolName, input: t.input })), text: s.text, usage: s.usage })),
      totalMs: Math.round(performance.now() - t0),
    }
  } catch (err) {
    record = { label: 'recording', model: 'aixia-labs', recordedAt: new Date().toISOString(), case: c, calls, error: String((err as Error).message ?? err).slice(0, 400), totalMs: Math.round(performance.now() - t0) }
  }
  writeFileSync(join(out, `${c.name}.json`), JSON.stringify(record, null, 2))
  const got = calls.map((x) => x.name)
  console.log(`${c.name.padEnd(14)} ${String(record.totalMs).padStart(6)} ms  calls=${JSON.stringify(got)}  expect=${JSON.stringify(c.expect)}  ${record.error ? `ERROR ${record.error}` : `text=${JSON.stringify(String(record.text ?? '').slice(0, 80))}`}`)
}
