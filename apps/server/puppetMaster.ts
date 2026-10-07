import type { Express } from 'express'
import { randomUUID } from 'node:crypto'
import { ToolLoopAgent, isStepCount, tool, type LanguageModel, type ModelMessage } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'
import { DEFAULT_LLM_BASE_URL, type ServerConfig } from './config.ts'
import { tableTools, type PuppetTable, type TableTurn } from './puppetTable.ts'
import { createPuppetInputChannel, type PuppetInputChannel } from './puppetInput.ts'
import { defaultVoiceId, voiceOptions } from './voices.ts'
import { createSpeechChannel, type SpeechChannel } from './speechChannel.ts'
import { createVoiceLevelBus, type VoiceLevelBus } from './voiceLevel.ts'
import { createAlignmentAccumulator, parseTimestampStream } from './wordTiming.ts'
import type { createStudioStore } from './studio.ts'
import { UI_CONTRACT } from '../web/src/studio/contract.ts'
import type { PuppetEvent } from '../web/src/studio/puppetContract.ts'

type Store = ReturnType<typeof createStudioStore>
const ELEVEN = 'https://api.elevenlabs.io/v1'

const BASE_INSTRUCTIONS = `You are Hubble, the puppet master of this living canvas.
One conversation controls what the person hears and what the canvas contains.
The say tool is the ONLY way to talk to the person: its text is spoken aloud and shown
as a speech bubble on the TV. Anything you do not say, they do not hear.
Say a short natural sentence before a slow or visible action, and a short one after.
Each say call finishes playing before the next tool executes.
Use inspect_canvas to see current component ids, revisions, sources and canvas version.
You may add_component, update_component, remove_component, clear_canvas or reset_canvas.
Never claim an edit succeeded until its tool returned success. If a tool reports a conflict,
inspect the latest canvas before deciding what to do. Do not execute code yourself.
Use the selected component as context for refinements, not as a restriction on other edits.
Only clear or reset when it follows the user's intent. Conversation alone needs no canvas edit.
The person TYPES to you. A running turn is never interrupted: finish it, and never wait
for or promise to react to anything the person might send mid-turn.
Use toolChoice auto (the provider does not support required). Prefer one tool per step.
When done, finish with plain conversational text or no text if you already said the conclusion.
Do not repeat a said sentence in your final text. Never say source code or markdown.`

const TABLE_INSTRUCTIONS = `
You also have the Julius table in front of the person: a projector shows answers and objects on
a real table. Call inspect_table before moving or closing anything. To answer a question about
maths or a notebook, call show_answer with the question: you never write the layout yourself,
the table brain draws it. If a tool says the brain or a page is unavailable, tell the person
with say and carry on. open_web works only for allow-listed hosts. draw_svg draws any shape or
picture you make up, at a real size in mm (bright on a white table; black is no light). open_asset, draw_svg, move_surface,
raise_surface, close_surface, open_keyboard, close_keyboard, set_act, start_lesson, stop_lesson
and clear_table change the real table; use them only when the person's request calls for it.
show_answer remembers the answers you already put on the table, so a follow-up such as "explain
the last step" is a show_answer call with that question: the brain sees the earlier answers.
When the person says "solve this", "this problem" or "what's on my page", call read_page first,
then show_answer with "Solve: " and the text it returned; if it read nothing, ask them to type it.`

/** Table tools are only offered, and only described, when a table adapter is mounted (studioServer.ts has none). */
export function puppetInstructions(opts: { table: boolean }) {
  return `${BASE_INSTRUCTIONS}${opts.table ? TABLE_INSTRUCTIONS : ''}\nThe canvas kit and source contract are: ${UI_CONTRACT}`
}
export const PUPPET_INSTRUCTIONS = puppetInstructions({ table: false })

/** HUBBLE_PUPPET_MODEL, else the table's model: the puppet may run a different (e.g. faster) model. */
export function puppetModel(config: ServerConfig): LanguageModel {
  return createOpenAICompatible({ name: PROVIDER, baseURL: config.llm.baseUrl, apiKey: config.llm.apiKey })(config.llm.puppetModel ?? config.llm.model)
}

const PROVIDER = 'aixia'
const normalUrl = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase()

/**
 * Whether to send `chat_template_kwargs.thinking`, and which way.
 *
 * Why not always false: that field is a vLLM/DeepSeek chat-template argument.
 * The Aiqu gateway needs it spelled out (its DeepSeek template otherwise
 * thinks for seconds before the first spoken word), but OpenAI and most other
 * OpenAI-compatible endpoints reject or ignore unknown body fields, so it is
 * sent only when it is known to be understood: HUBBLE_LLM_THINKING says so
 * explicitly, or the base URL is the default Aiqu gateway (then it defaults
 * to off). Any other provider gets nothing.
 */
export function puppetProviderOptions(config: ServerConfig) {
  const choice = config.llm.thinking ?? (normalUrl(config.llm.baseUrl) === normalUrl(DEFAULT_LLM_BASE_URL) ? 'off' : undefined)
  if (!choice) return undefined
  return { [PROVIDER]: { chat_template_kwargs: { thinking: choice === 'on' } } }
}

/** eleven_flash_v2_5: ~75 ms and multilingual. The demo speaks English (owner, 7 Oct), but
 * visitors' names and the odd Swedish word still come out right; eleven_flash_v2 is English only. */
export const DEFAULT_TTS_MODEL = 'eleven_flash_v2_5'

/** Vercel owns the reasoning/tool loop. This queue owns side effects: SDK tools
 * may execute concurrently when a model returns parallel calls, but speech and
 * canvas writes must follow the model's call order, including playback waits. */
export function createPuppetAgent(deps: {
  model: LanguageModel; store: Store; signal: AbortSignal
  emit: (event: PuppetEvent) => void
  speak: (text: string) => Promise<void>
  /** Julius table adapter. Absent in studioServer.ts: table tools then do not exist. */
  table?: PuppetTable
  /** This conversation's table state (earlier answers, the turn's scene and photo); the session owns it so history outlives a turn. */
  tableTurn?: TableTurn
  /** providerOptions for the model (see puppetProviderOptions); omitted for providers that would reject them. */
  providerOptions?: Record<string, Record<string, unknown>>
}) {
  let tail = Promise.resolve()
  let speechFailed = false
  function ordered<T>(name: string, execute: () => T | Promise<T>) {
    const task = tail.then(async () => {
      deps.signal.throwIfAborted()
      if (speechFailed) throw new Error('A preceding speech failed. Stop this turn instead of applying queued edits.')
      deps.emit({ type: 'tool', name, phase: 'start' })
      let result: T
      try { result = await execute() }
      catch (error) { if (name === 'say') speechFailed = true; throw error }
      deps.signal.throwIfAborted()
      deps.emit({ type: 'tool', name, phase: 'done' })
      return result
    })
    tail = task.then(() => {}, () => {})
    return task
  }
  const version = (asked: number) => {
    if (asked !== deps.store.version()) throw new Error('Canvas changed. Inspect it again before editing.')
  }
  const component = z.object({ title: z.string().min(1).max(80), source: z.string().min(1).max(50_000) })
  const tools = {
    inspect_canvas: tool({
      description: 'Read the actual canvas, sources, ids, revisions and version before editing.',
      inputSchema: z.object({}),
      execute: () => ordered('inspect_canvas', () => ({ version: deps.store.version(), documents: deps.store.snapshot().documents.map(({ javascript: _js, ...document }) => document) })),
    }),
    say: tool({
      description: 'The only way to talk to the person. The text is spoken aloud with text-to-speech and shown as a speech bubble on the TV. Waits for playback to finish before the next tool runs.',
      inputSchema: z.object({ text: z.string().trim().min(1).max(600) }),
      execute: ({ text }) => ordered('say', async () => { await deps.speak(text); return { delivered: true } }),
    }),
    add_component: tool({
      description: 'Compile and add a complete interactive React tool using the Liquid kit.',
      inputSchema: component.extend({ version: z.number().int().nonnegative() }),
      execute: ({ title, source, version: asked }) => ordered('add_component', () => {
        version(asked)
        const document = deps.store.put({ title, source, prompt: title })
        return { id: document.id, revision: document.revision, version: deps.store.version() }
      }),
    }),
    update_component: tool({
      description: 'Compile replacement source for an existing component; keeps other components running.',
      inputSchema: component.extend({ id: z.string(), revision: z.number().int().positive() }),
      execute: ({ id, revision, title, source }) => ordered('update_component', () => {
        const previous = deps.store.get(id)
        if (!previous || previous.revision !== revision) throw new Error('Component changed or disappeared. Inspect the canvas again.')
        const document = deps.store.put({ title, source, prompt: previous.prompt }, id)
        return { id, revision: document.revision, version: deps.store.version() }
      }),
    }),
    remove_component: tool({
      description: 'Remove an existing component from the canvas.',
      inputSchema: z.object({ id: z.string(), revision: z.number().int().positive() }),
      execute: ({ id, revision }) => ordered('remove_component', () => {
        if (deps.store.get(id)?.revision !== revision) throw new Error('Component changed or disappeared. Inspect the canvas again.')
        deps.store.remove(id); return { removed: id, version: deps.store.version() }
      }),
    }),
    clear_canvas: tool({
      description: 'Remove every component, leaving an empty canvas. Preserve the conversation.',
      inputSchema: z.object({ version: z.number().int().nonnegative() }),
      execute: ({ version: asked }) => ordered('clear_canvas', () => { version(asked); deps.store.clear(); return { version: deps.store.version() } }),
    }),
    reset_canvas: tool({
      description: 'Restore the three original demo examples. Preserve the conversation.',
      inputSchema: z.object({ version: z.number().int().nonnegative() }),
      execute: ({ version: asked }) => ordered('reset_canvas', () => { version(asked); deps.store.reset(); return { version: deps.store.version() } }),
    }),
  }
  const all = deps.table ? { ...tools, ...tableTools(deps.table, ordered, deps.signal, deps.tableTurn) } : tools
  return new ToolLoopAgent({
    model: deps.model, instructions: puppetInstructions({ table: Boolean(deps.table) }), tools: all,
    // toolChoice stays 'auto': the Aiqu gateway answers 500 to 'required'.
    stopWhen: isStepCount(16), toolChoice: 'auto', maxOutputTokens: 6000,
    ...(deps.providerOptions ? { providerOptions: deps.providerOptions as never } : {}),
  })
}

interface PendingSpeech {
  text: string
  settle: (error?: Error) => void
  claimed: boolean
  /** Word timings for the TV, gated on the page's `playing` signal (speechChannel.ts). */
  timeline: ReturnType<SpeechChannel['timeline']>
}
interface Session {
  history: ModelMessage[][]
  /** What show_answer put on the table in this conversation: the brain's follow-up memory (see puppetTable.ts ANSWER_HISTORY). */
  answers: { intent: string; answer: string }[]
  controller?: AbortController
  speeches: Map<string, PendingSpeech>
  touched: number
  ended?: Promise<void>
  /** The voice picked for the current turn (already validated against voiceOptions), if any. */
  voice?: string
}

/** Credentials and voice selection live on the server. When an existing Hubble
 * agent is configured we use its actual voice, rather than silently assigning
 * a second voice to the local puppet master. No hosted agent settings are edited.
 * Precedence for the spoken voice: an explicit selection from the UI (speech's
 * `voiceId`, validated by the turn route) > the hosted agent's voice > config.voiceId.
 * A deliberate pick must win over the agent's voice, or the select would do nothing
 * whenever ELEVENLABS_AGENT_ID is set. */
export function createVoiceProvider(config: ServerConfig, fetchImpl: typeof fetch = fetch) {
  // The key is optional in config (main no longer requires it at boot). Routes
  // check `hasVoice` first, so this only fires if a caller skips that check.
  const key = () => config.elevenLabsApiKey ?? (() => { throw new Error('ELEVENLABS_API_KEY is not set.') })()
  let voice: Promise<{ id: string; model: string }> | undefined
  // Only the agent's VOICE is reused, never its model: the model is ours to
  // pick (multilingual by default, see DEFAULT_TTS_MODEL), not the agent's.
  // ELEVENLABS_TTS_MODEL overrides the default.
  const model = config.ttsModel ?? DEFAULT_TTS_MODEL
  const resolveVoice = () => voice ??= (async () => {
    if (config.agentId) {
      const response = await fetchImpl(`${ELEVEN}/convai/agents/${encodeURIComponent(config.agentId)}`, {
        headers: { 'xi-api-key': key() }, signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error('Could not read the configured Hubble agent voice.')
      const data = await response.json() as { conversation_config?: { tts?: { voice_id?: string; model_id?: string } } }
      const tts = data.conversation_config?.tts
      if (!tts?.voice_id) throw new Error('The configured agent has no voice.')
      return { id: tts.voice_id, model }
    }
    return { id: defaultVoiceId(config), model }
  })().catch(error => { voice = undefined; throw error })
  return {
    /**
     * Same audio as speech(), from ElevenLabs' `stream/with-timestamps`: an NDJSON
     * body of base64 mp3 slices plus per-character alignment (shape recorded in
     * docs/plans/2026-10-07-tv-voice.md). Throws if the endpoint refuses, so the
     * route can fall back to plain speech() and the TV to estimated pacing.
     */
    async speechTimed(text: string, signal: AbortSignal, voiceId?: string) {
      const selected = voiceId ? { id: voiceId, model } : await resolveVoice()
      signal.throwIfAborted()
      const response = await fetchImpl(`${ELEVEN}/text-to-speech/${encodeURIComponent(selected.id)}/stream/with-timestamps?output_format=mp3_44100_128`, {
        method: 'POST', signal, headers: { 'xi-api-key': key(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: selected.model }),
      })
      if (!response.ok || !response.body) throw new Error('ElevenLabs could not generate timed speech.')
      return response.body
    },
    async speech(text: string, signal: AbortSignal, voiceId?: string) {
      // An explicit voice skips resolveVoice entirely: no needless agent lookup
      // (and no failure from it) for a voice the caller already named. The model
      // is unchanged either way.
      const selected = voiceId ? { id: voiceId, model } : await resolveVoice()
      signal.throwIfAborted()
      const response = await fetchImpl(`${ELEVEN}/text-to-speech/${encodeURIComponent(selected.id)}/stream?output_format=mp3_44100_128`, {
        method: 'POST', signal, headers: { 'xi-api-key': key(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: selected.model }),
      })
      if (!response.ok || !response.body) throw new Error('ElevenLabs could not generate speech.')
      return response.body
    },
  }
}

/**
 * ONE puppet master per server (owner, 7 Oct: "the same Puppet Master instance
 * is the one running on the hubble blob view as well as the actual
 * projector"). Two mounts on one app would give two speech channels and two
 * input channels behind the same URLs: the TV would hear one assistant while
 * show_answer drew through another, silently. So a second mount on the same
 * app THROWS instead of shadowing the first. Keyed by app, so tests (and
 * studioServer.ts) that build their own app are unaffected.
 */
const mounted = new WeakSet<object>()

export function mountPuppetMaster(app: Express, config: ServerConfig, store: Store, overrides: {
  model?: LanguageModel; voice?: ReturnType<typeof createVoiceProvider>
  /** The Julius table. Omit (studioServer.ts) and the agent has canvas and say only. */
  table?: PuppetTable
  speech?: SpeechChannel
  /** The one voice-level bus (voiceLevel.ts). studioServer.ts creates it and shares it with the Hue driver; absent, the puppet master makes its own. */
  voiceLevel?: VoiceLevelBus
  /** Typed text from Julius's inputs (projected keyboard SEND, pinch typing), published for the landing page to turn into a turn. Shared with index.ts's one seam. */
  input?: PuppetInputChannel
} = {}) {
  if (mounted.has(app)) throw new Error('the puppet master is already mounted on this app: there must be exactly one instance')
  mounted.add(app)
  // Every say, from every session, for displays that only listen (the TV).
  const speechChannel = overrides.speech ?? createSpeechChannel()
  // Which instance this is, for the pages that must all be talking to the same
  // one (/tv, /table, /overall read it; see usePuppetInstance). Random per
  // mount, so a second server process or a restarted one shows a new id.
  const instance = { instanceId: randomUUID(), startedAt: Date.now() }
  app.get('/api/puppet/instance', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ...instance, listeners: { speech: speechChannel.listeners(), input: inputChannel.listeners() }, table: Boolean(overrides.table) })
  })
  app.get('/api/puppet/speech/events', (_req, res) => speechChannel.subscribe(res))
  const voiceLevel = overrides.voiceLevel ?? createVoiceLevelBus()
  // The landing page measures the voice it plays (usePuppetAssistant) and posts it in ~100 ms
  // batches of ~20 Hz frames. `t` is the page's own clock, only used for spacing inside a batch:
  // the server rebuilds each frame's `at` as arrival minus (last t - t), so no clock is trusted
  // across machines and the batch is published at once (lowest latency for the lights). A frame
  // with speech null and level 0 means "silence now" (voiceLevel.ts contract).
  const levelBody = z.object({
    speech: z.string().max(64).nullable(),
    frames: z.array(z.object({ level: z.number().min(0).max(1), t: z.number() })).min(1).max(50),
  })
  app.post('/api/puppet/voice-level', (req, res) => {
    const parsed = levelBody.safeParse(req.body)
    if (!parsed.success) return void res.status(400).json({ error: 'Provide { speech: string | null, frames: [{ level 0..1, t }] } with 1 to 50 frames.' })
    const { speech, frames } = parsed.data
    const arrived = Date.now()
    const last = Math.max(...frames.map(f => f.t))
    for (const f of [...frames].sort((a, b) => a.t - b.t)) {
      // A frame measured more than 1 s before the batch ended is a stale batch, not live voice: pin it.
      const at = arrived - Math.min(last - f.t, 1000)
      voiceLevel.publish({ level: f.level, at, speech })
      speechChannel.level({ level: f.level, at })
    }
    res.sendStatus(204)
  })
  const inputChannel = overrides.input ?? createPuppetInputChannel()
  app.get('/api/puppet/input/events', (_req, res) => inputChannel.subscribe(res))
  app.post('/api/puppet/input', (req, res) => {
    const r = inputChannel.publishChecked(req.body)
    if (!r.ok) return void res.status(400).json({ error: r.error })
    res.status(202).json({ id: r.id, delivered: r.delivered })
  })
  const sessions = new Map<string, Session>()
  const voice = overrides.voice ?? createVoiceProvider(config)
  const hasVoice = Boolean(config.elevenLabsApiKey)
  const session = (id: string) => { const s = sessions.get(id); if (s) s.touched = Date.now(); return s }
  // `voice` is checked against the server's closed list below, not here: the
  // list depends on config, and a 400 with its own message is clearer than the
  // generic "provide a query" one.
  const turnSchema = z.object({ text: z.string().trim().min(1).max(2000), selected: z.string().optional(), audio: z.boolean().default(false), voice: z.string().max(64).optional(),
    // The bench's notebook photo and scene, as /api/render takes them; used only by show_answer. Data URLs only: any other string would be fetched by our server as an image source.
    image: z.string().regex(/^data:image\/(jpeg|png|webp);base64,/).optional(), scene: z.unknown().optional() })
  const voices = voiceOptions(config)
  app.get('/api/puppet/voices', (_req, res) => res.json({ voices, default: defaultVoiceId(config) }))
  app.post('/api/puppet/sessions', (_req, res) => {
    for (const [id, s] of sessions) {
      if (Date.now() - s.touched > 30 * 60_000 && !s.controller) sessions.delete(id)
    }
    if (sessions.size >= 24) return void res.status(503).json({ error: 'Too many active conversations.' })
    const id = randomUUID()
    sessions.set(id, { history: [], answers: [], speeches: new Map(), touched: Date.now() })
    res.json({ id, voice: hasVoice, configured: Boolean(config.llm.apiKey) })
  })
  app.delete('/api/puppet/sessions/:id', (req, res) => {
    sessions.get(req.params.id)?.controller?.abort(); sessions.delete(req.params.id); res.sendStatus(204)
  })
  app.post('/api/puppet/sessions/:id/cancel', async (req, res) => {
    const s = session(req.params.id)
    if (!s) return void res.sendStatus(404)
    s.controller?.abort()
    // Wait for actual tool cleanup before accepting the next utterance, rather
    // than racing a stopped stream's controller and rejecting it with a 409.
    await s.ended
    res.sendStatus(204)
  })
  app.post('/api/puppet/sessions/:id/turn', async (req, res) => {
    const s = session(req.params.id)
    if (!s) return void res.status(404).json({ error: 'Conversation expired. Start again.' })
    const parsed = turnSchema.safeParse(req.body)
    if (!parsed.success) return void res.status(400).json({ error: 'Provide a query of at most 2000 characters.' })
    // The browser must not be able to make us call TTS with an arbitrary id.
    if (parsed.data.voice !== undefined && !voices.some(v => v.id === parsed.data.voice)) return void res.status(400).json({ error: 'Unknown voice.' })
    if (!config.llm.apiKey && !overrides.model) return void res.status(503).json({ error: 'Set HUBBLE_LLM_API_KEY to enable the Hubble puppet master.' })
    // NEVER interrupt: a second typed turn while one runs is refused, not queued and
    // not an abort. The agent runs on our own model, so a turn is cheap to
    // finish and interrupting it would leave canvas/table half-edited. The one
    // way to end a turn early is the explicit cancel route (operator Stop).
    if (s.controller) return void res.status(409).json({ error: 'busy' })
    const controller = new AbortController()
    s.controller = controller
    // Per turn, not sticky: a turn without `voice` goes back to the default, so
    // the server never keeps speaking in a voice the client has stopped asking for.
    s.voice = parsed.data.voice
    let ended!: () => void
    s.ended = new Promise<void>(resolve => { ended = resolve })
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    res.on('close', () => { if (!res.writableFinished) controller.abort() })
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' })
    const emit = (event: PuppetEvent) => { if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`) }
    const spoken: string[] = []
    const speak = async (text: string) => {
      signal.throwIfAborted()
      const id = randomUUID()
      await new Promise<void>((resolve, reject) => {
        const settle = (error?: Error) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', aborted); s.speeches.delete(id)
          if (error) reject(error); else { spoken.push(text); resolve() }
        }
        const aborted = () => settle(new Error('Speech cancelled.'))
        const timer = setTimeout(() => settle(new Error('Speech playback acknowledgement timed out.')), 45_000)
        s.speeches.set(id, { text, settle, claimed: false, timeline: speechChannel.timeline(id) })
        signal.addEventListener('abort', aborted, { once: true })
        emit({ type: 'speech', id, text, audio: parsed.data.audio && hasVoice })
        // Same instant, same order as the client's event: the TV bubble shows
        // the line as it is spoken. Published to all sessions' displays.
        speechChannel.publish({ type: 'speech', id, text })
      })
    }
    speechChannel.publish({ type: 'turn', phase: 'start' })
    try {
      const agent = createPuppetAgent({ model: overrides.model ?? puppetModel(config), store, signal, emit, speak, table: overrides.table, tableTurn: overrides.table ? { history: s.answers, image: parsed.data.image, scene: overrides.table.cleanScene?.(parsed.data.scene) } : undefined, providerOptions: puppetProviderOptions(config) })
      const input = `${parsed.data.selected ? `Selected component: ${parsed.data.selected}\n` : ''}Canvas version: ${store.version()}\nUser: ${parsed.data.text}`
      const result = await agent.generate({ messages: [...s.history.flat(), { role: 'user', content: input }], abortSignal: signal })
      // Never truncate the model's conclusion. Keep each audio request short
      // so playback and acknowledgement fit the bounded speech deadline.
      // The model ignores "do not repeat a said sentence" (seen live, 2026-10-07:
      // say "Hi there, I'm Hubble — great to meet you!" and then final text "Hi
      // there — nice to meet you!" spoken as a second event). So the guard is
      // here, not in the prompt: once any say succeeded the person has heard the
      // answer, and the final text is history only. With no say, it is still
      // spoken so a person is never left in silence. `spoken` only grows when a
      // line finished playing, which is exactly "the person heard something".
      const text = spoken.length > 0 ? '' : result.text.trim()
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(offset + 600, text.length)
        if (end < text.length) {
          const space = text.lastIndexOf(' ', end)
          if (space > offset) end = space
        }
        await speak(text.slice(offset, end).trim())
        offset = end
        while (text[offset] === ' ') offset++
      }
      signal.throwIfAborted()
      // Trim whole turns, never arbitrary messages: a tool result must retain
      // the assistant call it answers when the next prompt is assembled.
      s.history = [...s.history, [{ role: 'user', content: parsed.data.text } as ModelMessage, ...result.response.messages]].slice(-8)
      emit({ type: 'done' })
    } catch {
      // Preserve only what the person actually received, not queued speech or
      // tool success claims from an interrupted generation. Next turn inspects
      // the real store again, including edits completed before interruption.
      s.history = [...s.history, [{ role: 'user', content: parsed.data.text } as ModelMessage,
        ...(spoken.length ? [{ role: 'assistant', content: spoken.join(' ') } as ModelMessage] : [])]].slice(-8)
      if (!res.destroyed) emit({ type: 'error', message: signal.aborted ? 'Turn stopped.' : 'Hubble could not finish this turn. Check model and voice configuration.' })
    } finally {
      for (const speech of [...s.speeches.values()]) speech.settle(new Error('Turn ended.'))
      speechChannel.publish({ type: 'turn', phase: 'end' })
      s.controller = undefined; ended(); s.ended = undefined; res.end()
    }
  })
  app.post('/api/puppet/sessions/:id/speech/:speech/ack', (req, res) => {
    const pending = session(req.params.id)?.speeches.get(req.params.speech)
    if (!pending) return void res.sendStatus(404)
    pending.settle(req.body?.ok === true ? undefined : new Error('Speech playback failed.'))
    res.sendStatus(204)
  })
  // The page's audio element fired 'playing': audio time 0 is NOW. The TV reveals words against it.
  app.post('/api/puppet/sessions/:id/speech/:speech/playing', (req, res) => {
    const pending = session(req.params.id)?.speeches.get(req.params.speech)
    if (!pending) return void res.sendStatus(404)
    pending.timeline.playing()
    res.sendStatus(204)
  })
  app.get('/api/puppet/sessions/:id/speech/:speech', async (req, res) => {
    const s = session(req.params.id)
    const pending = s?.speeches.get(req.params.speech)
    if (!s?.controller || !pending || pending.claimed || !hasVoice) return void res.sendStatus(404)
    pending.claimed = true
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    const signal = AbortSignal.any([s.controller.signal, abort.signal, AbortSignal.timeout(60_000)])
    try {
      // Preferred: the timestamped stream, decoded back to plain mp3 for the browser while the
      // word timings go to the TV's timeline. Any failure BEFORE the first audio byte (endpoint
      // refused, body not NDJSON) falls back to plain speech(): the person still hears the line and
      // the TV paces its words by estimate. After the first byte there is no clean way back, so it ends the stream.
      let wrote = false
      if (typeof voice.speechTimed === 'function') {
        try {
          const timed = await voice.speechTimed(pending.text, signal, s.voice)
          const alignment = createAlignmentAccumulator()
          for await (const chunk of parseTimestampStream(timed as unknown as AsyncIterable<Uint8Array>)) {
            signal.throwIfAborted()
            if (chunk.alignment) { alignment.add(chunk.alignment); pending.timeline.addWords(alignment.words(false), false) }
            if (!chunk.audio) continue
            if (!wrote) res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' })
            wrote = true
            if (!res.write(chunk.audio)) await new Promise<void>(resolve => { res.once('drain', resolve); res.once('close', resolve) })
          }
          if (!wrote) throw new Error('No audio in the timed stream.')
          pending.timeline.addWords(alignment.words(true), true)
          return void res.end()
        } catch (error) {
          if (wrote || signal.aborted) throw error
        }
      }
      const audio = await voice.speech(pending.text, signal, s.voice)
      res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' })
      // Node 22 web streams are async-iterable at runtime; the DOM lib types lack it (TS2504).
      for await (const chunk of audio as unknown as AsyncIterable<Uint8Array>) {
        signal.throwIfAborted()
        if (!res.write(Buffer.from(chunk))) await new Promise<void>(resolve => { res.once('drain', resolve); res.once('close', resolve) })
      }
      res.end()
    } catch {
      pending.settle(new Error('Speech unavailable.'))
      if (!res.headersSent) res.sendStatus(502); else res.destroy()
    }
  })
  // The light driver (voiceLights.ts) subscribes to this; the same bus studioServer.ts passed in, or ours.
  return { voiceLevel, speech: speechChannel }
}
