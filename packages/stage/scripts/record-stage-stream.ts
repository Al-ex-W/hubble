import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { buildSystemPrompt } from '../src/prompt.ts'
import { DEFAULT_SURFACE, OBJECT_SIZE_MM, pxFromMm, type ObjectKind, type Scene } from '../src/scene.ts'

// Keys come from the environment, or from ./.env in the directory it is run
// from (the app repo root), without making the engine depend on dotenv.
try {
  process.loadEnvFile()
} catch {
  /* no .env: rely on the environment */
}

/**
 * Stage 0 recorder: asks the real model for table answers, using the real
 * prompt pack, and saves every SSE delta verbatim with its arrival time.
 *
 * The parser is tested against these files, not against output we imagine the
 * model produces. Re-run after any prompt or catalog change and diff the census.
 *
 *   npm run record:stage               # from the app repo root: the full prompt set
 *   npm run record:stage math-linear   # one case
 *
 * Output: fixtures/stage-streams/<case>.jsonl. Line 1 is metadata; every other
 * line is {"t": msSinceRequest, "data": <raw SSE data payload>}.
 */

interface Case {
  id: string
  intent: string
  image?: string
  thinking?: boolean
  /** Objects on the table, by kind, at mm positions in the lit area. */
  scene?: SceneSpec[]
}

/**
 * `[kind, xMm, yMm]`, or an `other` obstacle with its own name and footprint.
 * Obstacles exist because the piano and plate kinds were removed (#17) while
 * `scene-crowded` still wants a cluttered table: they keep their old ids and
 * sizes, and the label makes the prompt read exactly as it did when recorded
 * (`describeScene` prints `label ?? kind`).
 */
type SceneSpec = [ObjectKind, number, number] | ['other', number, number, { id: string; wMm: number; hMm: number }]

const sceneOf = (objs: SceneSpec[]): Scene => ({
  surface: DEFAULT_SURFACE,
  objects: objs.map(([kind, xMm, yMm, obstacle]) => ({
    id: obstacle?.id ?? kind,
    kind,
    ...(obstacle ? { label: obstacle.id } : {}),
    box: {
      x: pxFromMm(DEFAULT_SURFACE, xMm),
      y: pxFromMm(DEFAULT_SURFACE, yMm),
      w: pxFromMm(DEFAULT_SURFACE, obstacle?.wMm ?? OBJECT_SIZE_MM[kind].w),
      h: pxFromMm(DEFAULT_SURFACE, obstacle?.hMm ?? OBJECT_SIZE_MM[kind].h),
    },
  })),
})

// Intents are phrased the way the voice agent will pass them to the render
// tool: a short restatement of what the user asked, not the raw transcript.
const CASES: Case[] = [
  { id: 'math-linear', intent: 'Show me how to solve the task in my notebook.', image: 'linear' },
  { id: 'math-linear-thinking', intent: 'Show me how to solve the task in my notebook.', image: 'linear', thinking: true },
  { id: 'math-quadratic', intent: 'Solve the equation in my notebook step by step.', image: 'quadratic' },
  { id: 'math-quadratic-thinking', intent: 'Solve the equation in my notebook step by step.', image: 'quadratic', thinking: true },
  { id: 'math-fractions', intent: 'Help me with this fraction problem.', image: 'fractions' },
  { id: 'math-inequality', intent: 'How do I solve this inequality?', image: 'inequality' },
  { id: 'math-derivative', intent: 'Show me how to differentiate this.', image: 'derivative' },
  { id: 'math-derivative-thinking', intent: 'Show me how to differentiate this.', image: 'derivative', thinking: true },
  { id: 'math-spoken', intent: 'Solve x squared minus 9 equals 0.' },
  { id: 'math-pythagoras', intent: 'Explain the Pythagorean theorem with an example.' },
  { id: 'math-percent', intent: 'What is 15 percent of 240?' },
  { id: 'recipe-soup', intent: 'Show me a recipe for a good chicken soup.' },
  { id: 'recipe-pancakes', intent: 'How do I make pancakes?' },
  { id: 'tempt-table', intent: 'Show me a table comparing the planets by size.' },
  { id: 'tempt-code', intent: 'Write me a Python function that sorts a list.' },
  { id: 'tempt-unknown', intent: 'What time is it in Tokyo right now?' },
  { id: 'general-photosynthesis', intent: 'Explain photosynthesis simply.' },
  { id: 'general-buttons', intent: 'Give me three study tips and let me tap to see the next one.' },
  // Advanced set (recorded with the full-size components in the prompt).
  { id: 'adv-integral', intent: 'Show me how to solve the integral in my notebook.', image: 'integral' },
  { id: 'adv-system', intent: 'Solve the system of equations in my notebook.', image: 'system' },
  { id: 'adv-optimize', intent: 'Help me solve this optimization problem.', image: 'optimize' },
  { id: 'adv-projectile', intent: 'Explain this physics problem step by step.', image: 'projectile' },
  { id: 'adv-limit', intent: 'How do I evaluate this limit?', image: 'limit' },
  { id: 'adv-quadratic-graph', intent: 'Solve the equation in my notebook and show me the graph.', image: 'quadratic' },
  { id: 'adv-compare-methods', intent: 'Show two different ways to solve x^2 - 6x + 5 = 0 side by side.' },
  { id: 'adv-derivative-graph', intent: 'Differentiate f(x) = x^3 - 3x and show where it has turning points on a graph.' },
  { id: 'adv-planets-table', intent: 'Compare the four inner planets in a table: diameter, moons, day length.' },
  { id: 'adv-taylor', intent: 'Explain the Taylor series of sin(x) and show how it approximates the curve.' },
  { id: 'adv-compound-interest', intent: 'If I save 1000 kr a month at 7 percent a year, how much do I have after 10 years?' },
  { id: 'adv-derivative-thinking', intent: 'Differentiate f(x) = x^3 - 3x and show where it has turning points on a graph.', thinking: true },
  // Scene-aware set: the prompt carries the table (bench default positions in
  // mm), so the model places panels itself. These drive the layout report.
  { id: 'scene-linear-left', intent: 'Solve the task in my notebook.', image: 'linear', scene: [['notebook', 230, 300]] },
  { id: 'scene-linear-center', intent: 'Solve the task in my notebook.', image: 'linear', scene: [['notebook', 650, 260]] },
  { id: 'scene-linear-right-edge', intent: 'Solve the task in my notebook.', image: 'linear', scene: [['notebook', 1250, 300]] },
  { id: 'scene-integral', intent: 'Show me how to solve the integral in my notebook.', image: 'integral', scene: [['notebook', 230, 300]] },
  { id: 'scene-optimize', intent: 'Help me solve this optimization problem.', image: 'optimize', scene: [['notebook', 230, 300]] },
  { id: 'scene-quadratic-graph', intent: 'Solve the equation in my notebook and show me the graph.', image: 'quadratic', scene: [['notebook', 230, 300]] },
  { id: 'scene-crowded', intent: 'Solve the task in my notebook.', image: 'system', scene: [['notebook', 230, 300], ['other', 1050, 360, { id: 'plate', wMm: 260, hMm: 260 }], ['cup', 1300, 640], ['other', 360, 620, { id: 'piano', wMm: 780, hMm: 140 }]] },
  { id: 'scene-empty-pythagoras', intent: 'Explain the Pythagorean theorem with a picture of the idea.', scene: [] },
  { id: 'scene-empty-compare', intent: 'Show two different ways to solve x^2 - 6x + 5 = 0 side by side.', scene: [] },
  { id: 'scene-planets', intent: 'Compare the four inner planets in a table: diameter, moons, day length.', scene: [['cup', 1300, 640]] },
  { id: 'scene-study-tips', intent: 'Give me three study tips and let me tap to see the next one.', scene: [['notebook', 230, 300]] },
  { id: 'scene-projectile', intent: 'Explain this physics problem step by step.', image: 'projectile', scene: [['notebook', 900, 300]] },
]

const ROOT = new URL('..', import.meta.url)
const OUT = new URL('fixtures/stage-streams/', ROOT)

function imageDataUrl(name: string): string {
  const bytes = readFileSync(new URL(`fixtures/notebooks/${name}.jpg`, ROOT))
  return `data:image/jpeg;base64,${bytes.toString('base64')}`
}

async function record(c: Case) {
  const scene = c.scene ? sceneOf(c.scene) : undefined
  const system = buildSystemPrompt({ hasImage: Boolean(c.image), scene })
  const model = process.env.STAGE_MODEL ?? 'aixia-labs'
  const user = c.image
    ? [
        { type: 'text', text: c.intent },
        { type: 'image_url', image_url: { url: imageDataUrl(c.image) } },
      ]
    : c.intent
  const body = {
    model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: c.thinking ? 6000 : 1500,
    chat_template_kwargs: { thinking: Boolean(c.thinking) },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }
  const t0 = Date.now()
  const res = await fetch(`${process.env.HUBBLE_LLM_BASE_URL ?? 'https://llm.aiqu.ai/v1'}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.HUBBLE_LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) throw new Error(`${c.id}: HTTP ${res.status} ${await res.text()}`)

  const lines: string[] = [
    JSON.stringify({
      meta: {
        case: c.id,
        label: 'recording',
        recordedAt: new Date(t0).toISOString(),
        model,
        thinking: Boolean(c.thinking),
        intent: c.intent,
        image: c.image ? { fixture: `notebooks/${c.image}.jpg`, label: 'synthetic' } : null,
        promptSha: createHash('sha256').update(system).digest('hex').slice(0, 12),
        scene: scene ?? null,
      },
    }),
  ]
  // Split on SSE event boundaries ourselves rather than trusting chunk edges:
  // a network chunk can end mid-line, and the recording must hold whole events.
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line.startsWith('data:')) lines.push(JSON.stringify({ t: Date.now() - t0, data: line.slice(5).trim() }))
    }
  }
  writeFileSync(new URL(`${c.id}.jsonl`, OUT), lines.join('\n') + '\n')
  console.log(`${c.id}: ${lines.length - 1} events in ${Date.now() - t0} ms`)
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const only = process.argv[2]
  const cases = only ? CASES.filter((c) => c.id === only) : CASES
  if (cases.length === 0) throw new Error(`no case ${only}`)
  // A few at a time: fast, without looking like a flood to a shared gateway.
  for (let i = 0; i < cases.length; i += 4) {
    await Promise.all(cases.slice(i, i + 4).map((c) => record(c).catch((e) => console.error(String(e)))))
  }
}

main().catch((err) => {
  console.error(String(err).split(process.env.HUBBLE_LLM_API_KEY ?? '\0').join('[redacted]'))
  process.exit(1)
})
