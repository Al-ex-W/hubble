import type { Express } from 'express'
import { randomUUID } from 'node:crypto'
import { streamText, tool, type LanguageModel, type ToolChoice } from 'ai'
import { z } from 'zod'
import type { ServerConfig } from './config.ts'
import { createVoiceProvider, puppetModel, puppetProviderOptions } from './puppetMaster.ts'
import { defaultVoiceId, voiceOptions } from './voices.ts'

/**
 * The Hubble Lab's assistant demo: ONE model call, ONE tool (`say`), streamed
 * to the page event by event so the owner can watch the model think, call the
 * tool and then talk. Nothing here touches the canvas, the table or a session:
 * it exists to make the reasoning -> tool-call -> speech chain visible.
 *
 * Evidence for the shape of this file is docs/plans/2026-10-07-puppet-lab.md
 * (recorded probes against the live Aiqu gateway, 7 Oct 2026). The one fact
 * that decided the design: the gateway answers HTTP 500 to a forced specific
 * toolChoice exactly as it does to 'required', and only 'auto' works. So the
 * "force" is done by instruction plus a server-side fallback (below), and the
 * UI is told which path really happened instead of pretending.
 */

/** Wire contract of POST /api/puppet/lab/run, one JSON object per line. The web page imports the type. */
export type LabEvent =
  | { type: 'reasoning'; delta: string }
  | { type: 'text'; delta: string }
  /** `synthesized` = the model never called say; the server turned its plain text into this call. */
  | { type: 'tool-call'; name: 'say'; input: { text: string }; synthesized?: boolean }
  | { type: 'speech'; id: string; text: string; audio: boolean }
  | { type: 'timing'; path: LabPath; reasoningChars: number; firstReasoningMs?: number; firstTextMs?: number; toolCallMs?: number; speechMs?: number; totalMs: number }
  | { type: 'done' }
  | { type: 'error'; message: string }

/**
 * Which route produced the say call:
 *  - 'forced': toolChoice named the tool and the provider honoured it (never true on Aiqu today).
 *  - 'auto-instructed': toolChoice 'auto', the instructions demanded a single say, and the model obeyed.
 *  - 'fallback': 'auto' and the model answered with plain text; the server wrapped that text in a say.
 */
export type LabPath = 'forced' | 'auto-instructed' | 'fallback'

const FORCE_INSTRUCTIONS = `You are Hubble, a lamp that talks. The say tool is the ONLY way you can talk:
its text is spoken aloud. Your reply MUST be exactly one call to say, with a short natural
spoken answer to the person (one or two sentences, no markdown, no lists). Do not answer in plain text.`

const SPEECH_TTL_MS = 5 * 60_000
const SPEECH_MAX = 50

const runSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  thinking: z.boolean(),
  voice: z.string().max(64).optional(),
})

export function mountPuppetLab(app: Express, config: ServerConfig, overrides: {
  model?: LanguageModel
  voice?: ReturnType<typeof createVoiceProvider>
  /** Default 'auto': the gateway 500s on a named tool (see the header). Tests pass the forced form. */
  toolChoice?: ToolChoice<{ say: unknown }>
} = {}) {
  const voice = overrides.voice ?? createVoiceProvider(config)
  const hasVoice = Boolean(config.elevenLabsApiKey)
  const voices = voiceOptions(config)
  const toolChoice = overrides.toolChoice ?? 'auto'
  // Pending speech: the run stream hands the browser an id, the browser's <audio>
  // then GETs it. Text is held server-side so the audio URL carries no text and
  // the browser cannot make us speak anything it did not get through /run.
  const speeches = new Map<string, { text: string; voiceId: string; at: number }>()
  const sweep = () => {
    const now = Date.now()
    for (const [id, s] of speeches) if (now - s.at > SPEECH_TTL_MS) speeches.delete(id)
    // Oldest first (Map keeps insertion order): a flood of runs cannot grow memory without bound.
    while (speeches.size > SPEECH_MAX) speeches.delete(speeches.keys().next().value!)
  }

  /** The thinking toggle, spelled the way this provider understands, or nothing for providers that would reject it. */
  const providerOptions = (thinking: boolean) => {
    const base = puppetProviderOptions(config)
    // puppetProviderOptions answers undefined for providers that do not know
    // chat_template_kwargs; the lab must not send it there either. Its own key
    // (the provider name) is reused rather than duplicated.
    if (!base) return undefined
    const [provider] = Object.keys(base)
    return { [provider]: { chat_template_kwargs: { thinking } } }
  }

  app.post('/api/puppet/lab/run', async (req, res) => {
    const parsed = runSchema.safeParse(req.body)
    if (!parsed.success) return void res.status(400).json({ error: 'Provide text (at most 2000 characters) and thinking true or false.' })
    // The browser must not be able to make us call TTS with an arbitrary voice id.
    const voiceId = parsed.data.voice ?? defaultVoiceId(config)
    if (!voices.some(v => v.id === voiceId)) return void res.status(400).json({ error: 'Unknown voice.' })
    if (!config.llm.apiKey && !overrides.model) return void res.status(503).json({ error: 'Set HUBBLE_LLM_API_KEY to enable the lab assistant.' })

    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])
    res.on('close', () => { if (!res.writableFinished) controller.abort() })
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' })
    const emit = (event: LabEvent) => { if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`) }

    const t0 = Date.now()
    const since = () => Date.now() - t0
    let firstReasoningMs: number | undefined, firstTextMs: number | undefined, toolCallMs: number | undefined, speechMs: number | undefined
    let reasoningChars = 0
    let plain = ''
    let said: string | undefined
    try {
      const result = streamText({
        model: overrides.model ?? puppetModel(config),
        system: FORCE_INSTRUCTIONS,
        prompt: parsed.data.text,
        // No execute: the lab speaks the text itself (below) so it can emit the
        // speech event with an audio id, and so the call ends the turn, there is no second step.
        tools: { say: tool({ description: 'Speak the text aloud to the person.', inputSchema: z.object({ text: z.string().trim().min(1).max(600) }) }) },
        toolChoice,
        maxOutputTokens: 1500,
        abortSignal: signal,
        ...(providerOptions(parsed.data.thinking) ? { providerOptions: providerOptions(parsed.data.thinking) as never } : {}),
      })
      for await (const part of result.fullStream) {
        if (part.type === 'reasoning-delta') {
          firstReasoningMs ??= since(); reasoningChars += part.text.length
          emit({ type: 'reasoning', delta: part.text })
        } else if (part.type === 'text-delta') {
          firstTextMs ??= since(); plain += part.text
          emit({ type: 'text', delta: part.text })
        } else if (part.type === 'tool-call' && part.toolName === 'say' && said === undefined) {
          toolCallMs = since(); said = (part.input as { text: string }).text
          emit({ type: 'tool-call', name: 'say', input: { text: said } })
        } else if (part.type === 'error') {
          // The SDK surfaces provider failures as a part, not a throw, so a 500
          // would otherwise end the stream silently and look like "no answer".
          throw part.error
        }
      }
      let path: LabPath = typeof toolChoice === 'object' ? 'forced' : 'auto-instructed'
      if (said === undefined) {
        // Why a fallback: with 'auto' nothing stops the model answering in plain
        // text. The demo's point is the say tool, so the text is wrapped in one
        // (clamped to the tool's own 600-char limit) and the UI is told it was synthesized.
        const text = plain.trim().slice(0, 600)
        if (!text) throw new Error('The model neither called say nor answered.')
        toolCallMs = since(); said = text; path = 'fallback'
        emit({ type: 'tool-call', name: 'say', input: { text }, synthesized: true })
      }
      const id = randomUUID()
      sweep(); speeches.set(id, { text: said, voiceId, at: Date.now() })
      speechMs = since()
      emit({ type: 'speech', id, text: said, audio: hasVoice })
      emit({ type: 'timing', path, reasoningChars, firstReasoningMs, firstTextMs, toolCallMs, speechMs, totalMs: since() })
      emit({ type: 'done' })
    } catch (error) {
      // The raw provider error can carry gateway internals; the status is useful, the body is not.
      const status = (error as { statusCode?: number })?.statusCode
      emit({ type: 'error', message: signal.aborted ? 'Run stopped.' : `The model call failed${status ? ` (HTTP ${status})` : ''}. ${error instanceof Error && !status ? error.message : ''}`.trim() })
    } finally {
      res.end()
    }
  })

  app.get('/api/puppet/lab/speech/:id', async (req, res) => {
    const pending = speeches.get(req.params.id)
    if (!pending || !hasVoice) return void res.sendStatus(404)
    // Not deleted on first read: <audio> may re-request (range / replay). TTL owns cleanup.
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)])
    try {
      const audio = await voice.speech(pending.text, signal, pending.voiceId)
      res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' })
      // A manual reader loop: ReadableStream is not typed async-iterable in this
      // tsconfig's lib, and the loop must end on `done`.
      const reader = audio.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        signal.throwIfAborted()
        if (!res.write(Buffer.from(value))) await new Promise<void>(resolve => { res.once('drain', resolve); res.once('close', resolve) })
      }
      res.end()
    } catch {
      if (!res.headersSent) res.sendStatus(502); else res.destroy()
    }
  })
}
