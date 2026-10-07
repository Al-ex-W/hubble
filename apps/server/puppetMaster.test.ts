import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createPuppetAgent, createVoiceProvider, mountPuppetMaster, puppetInstructions, puppetProviderOptions, DEFAULT_TTS_MODEL } from './puppetMaster.ts'
import { PREMADE_VOICES } from './voices.ts'
import { createSpeechChannel } from './speechChannel.ts'
import { createStudioStore } from './studio.ts'
import type { ServerConfig } from './config.ts'

// Provenance: schema-derived Vercel tool-call responses and synthetic playback
// events. This exercises the real SDK loop, not a hand-written imitation of it.
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }
const result = (content: any[], reason = 'stop') => ({ content, finishReason: { unified: reason, raw: reason }, usage, warnings: [] })
const call = (name: string, input: unknown, id = name) => ({ type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) })
const config: ServerConfig = { elevenLabsApiKey: 'test-el', agentId: 'existing-hubble', port: 0, jevApiKey: undefined, llm: { apiKey: 'test-model', model: 'aixia-labs', baseUrl: 'https://example.test/v1' } }

describe('puppet master tool loop', () => {
  it('does not edit the canvas until preceding speech finishes, even for parallel tool calls', async () => {
    // Break caught: parallel tool execution publishes an edit before its spoken
    // introduction completes. The store snapshot is an independent oracle.
    const store = createStudioStore()
    let finishSpeech!: () => void
    let speechStarted!: () => void
    const started = new Promise<void>(resolve => { speechStarted = resolve })
    const model = new MockLanguageModelV4({ doGenerate: [
      result([call('say', { text: 'First I will clear the canvas.' }), call('clear_canvas', { version: 0 })], 'tool-calls') as any,
      result([]) as any,
    ] })
    const agent = createPuppetAgent({ model, store, signal: new AbortController().signal, emit: () => {}, speak: () => {
      speechStarted(); return new Promise<void>(resolve => { finishSpeech = resolve })
    } })
    const pending = agent.generate({ prompt: 'Clear it, with an introduction.' })
    await started
    expect(store.snapshot().documents).toHaveLength(3)
    finishSpeech()
    await pending
    expect(store.snapshot().documents).toHaveLength(0)
    expect(model.doGenerateCalls).toHaveLength(2)
  })

  it('rejects a stale destructive edit and lets the model inspect the changed canvas', async () => {
    // Break caught: a stale version silently clears source edits from another
    // page. The known document id/source must survive that call.
    const store = createStudioStore()
    const original = store.snapshot().documents[0]
    store.put({ title: 'Owner edit', source: original.source, prompt: original.prompt }, original.id)
    const model = new MockLanguageModelV4({ doGenerate: [result([call('clear_canvas', { version: 0 })], 'tool-calls') as any, result([]) as any] })
    await createPuppetAgent({ model, store, signal: new AbortController().signal, emit: () => {}, speak: async () => {} }).generate({ prompt: 'Clear' })
    expect(store.get(original.id)?.title).toBe('Owner edit')
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('Canvas changed')
  })

  it('does not apply queued canvas tools after a turn is aborted', async () => {
    // Break caught: a late provider/tool answer mutates the surface after stop.
    const store = createStudioStore()
    const abort = new AbortController()
    const model = new MockLanguageModelV4({ doGenerate: result([]) as any })
    const agent = createPuppetAgent({ model, store, signal: abort.signal, emit: () => {}, speak: async () => {} })
    abort.abort()
    await expect(agent.tools.clear_canvas.execute!({ version: 0 }, { toolCallId: 'x', messages: [], context: {} })).rejects.toThrow()
    expect(store.snapshot().documents).toHaveLength(3)
  })

  it('does not execute queued edits when preceding speech playback fails', async () => {
    // Break caught: the tool queue swallows a speech failure and carries on
    // clearing a canvas the person never heard an introduction for.
    const store = createStudioStore()
    const agent = createPuppetAgent({ model: new MockLanguageModelV4(), store, signal: new AbortController().signal, emit: () => {}, speak: async () => { throw new Error('Playback failed') } })
    const options = { toolCallId: 'tool', messages: [], context: {} }
    const speech = agent.tools.say.execute!({ text: 'Clearing now' }, options)
    const edit = agent.tools.clear_canvas.execute!({ version: 0 }, options)
    await expect(speech).rejects.toThrow('Playback failed')
    await expect(edit).rejects.toThrow('preceding speech failed')
    expect(store.snapshot().documents).toHaveLength(3)
  })

  it('compiles additions and revisions, removes a component, then resets the real demo corpus', async () => {
    // Break caught: tool adapters return success without publishing real store
    // changes, or invalid TSX overwrites the last-good source.
    const store = createStudioStore()
    const agent = createPuppetAgent({ model: new MockLanguageModelV4(), store, signal: new AbortController().signal, emit: () => {}, speak: async () => {} })
    const options = { toolCallId: 'tool', messages: [], context: {} }
    const added = await agent.tools.add_component.execute!({ version: 0, title: 'Counter', source: 'export default () => <UI.Text>Counter</UI.Text>' }, options) as { id: string; revision: number }
    expect(store.get(added.id)?.javascript).toContain('Counter')
    await expect(agent.tools.update_component.execute!({ id: added.id, revision: 1, title: 'Broken', source: 'export default () => <div>' }, options)).rejects.toThrow()
    expect(store.get(added.id)?.revision).toBe(1)
    await agent.tools.remove_component.execute!({ id: added.id, revision: 1 }, options)
    expect(store.get(added.id)).toBeUndefined()
    await agent.tools.reset_canvas.execute!({ version: store.version() }, options)
    expect(store.snapshot().documents.map(x => x.title)).toEqual(['Wave laboratory', 'Focus timer', 'Room atmosphere'])
  })
})

describe('ElevenLabs speech provider', () => {
  it('streams TTS with the existing agent voice, never a second LLM', async () => {
    // Schema-derived provider response: the independent URLs/body prove exact
    // voice reuse and the absence of a conversational generation request.
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const provider = createVoiceProvider(config, async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('/agents/')) return Response.json({ conversation_config: { tts: { voice_id: 'same-voice', model_id: 'eleven_flash_v2' } } })  // the agent's English-only model must NOT be reused
      return new Response(new Uint8Array([1, 2, 3]))
    })
    await provider.speech('Exact local answer', new AbortController().signal)
    expect(calls.map(x => x.url)).toEqual([
      'https://api.elevenlabs.io/v1/convai/agents/existing-hubble',
      'https://api.elevenlabs.io/v1/text-to-speech/same-voice/stream?output_format=mp3_44100_128',
    ])
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ text: 'Exact local answer', model_id: 'eleven_flash_v2_5' })
  })
})

describe('selectable voice (fake fetch, schema-derived URLs)', () => {
  const urls = async (cfg: ServerConfig, voiceId?: string) => {
    const seen: string[] = []
    const provider = createVoiceProvider(cfg, async url => {
      seen.push(String(url))
      if (String(url).includes('/agents/')) return Response.json({ conversation_config: { tts: { voice_id: 'agent-voice' } } })
      return new Response(new Uint8Array([1]))
    })
    await provider.speech('Hi', new AbortController().signal, voiceId)
    return seen
  }
  const tts = (id: string) => `https://api.elevenlabs.io/v1/text-to-speech/${id}/stream?output_format=mp3_44100_128`
  it('speaks with the selected voice, even over the hosted agent voice, and never asks the agent', async () => {
    // Break caught: the select does nothing whenever ELEVENLABS_AGENT_ID is set
    // (agent voice wins over the pick), or the agent is still fetched needlessly.
    expect(await urls(config, 'Xb7hH8MSUJpSbSDYk0k2')).toEqual([tts('Xb7hH8MSUJpSbSDYk0k2')])
  })
  it('without a selection uses the agent voice, else config.voiceId', async () => {
    // Break caught: the new argument changes the old precedence (agent > config).
    expect((await urls(config)).at(-1)).toBe(tts('agent-voice'))
    expect(await urls({ ...config, agentId: undefined, voiceId: 'env-voice' })).toEqual([tts('env-voice')])
  })
})

describe('TTS model', () => {
  const body = async (cfg: ServerConfig) => {
    let sent: any
    const provider = createVoiceProvider(cfg, async (url, init) => {
      if (String(url).includes('/text-to-speech/')) sent = JSON.parse(String(init?.body))
      return new Response(new Uint8Array([1]))
    })
    await provider.speech('Hej', new AbortController().signal)
    return sent
  }
  it('defaults to the multilingual flash model and honours ELEVENLABS_TTS_MODEL', async () => {
    // Break caught: falling back to eleven_flash_v2 (English only) makes Swedish
    // speech unintelligible; an ignored override makes the env var a lie.
    const noAgent = { ...config, agentId: undefined }
    expect(DEFAULT_TTS_MODEL).toBe('eleven_flash_v2_5')
    expect((await body(noAgent)).model_id).toBe('eleven_flash_v2_5')
    expect((await body({ ...noAgent, ttsModel: 'eleven_turbo_v2_5' })).model_id).toBe('eleven_turbo_v2_5')
  })
})

describe('provider options (thinking)', () => {
  const cfg = (baseUrl: string, thinking?: 'off' | 'on'): ServerConfig => ({ ...config, llm: { ...config.llm, baseUrl, thinking } })
  it('sends thinking:false to Aiqu by default, nothing to other providers, and obeys HUBBLE_LLM_THINKING', () => {
    // Break caught: chat_template_kwargs sent to OpenAI (rejected body field),
    // or omitted for Aiqu (seconds of thinking before the first spoken word).
    expect(puppetProviderOptions(cfg('https://llm.aiqu.ai/v1'))).toEqual({ aixia: { chat_template_kwargs: { thinking: false } } })
    expect(puppetProviderOptions(cfg('https://llm.aiqu.ai/v1/'))).toBeDefined()
    expect(puppetProviderOptions(cfg('https://api.openai.com/v1'))).toBeUndefined()
    expect(puppetProviderOptions(cfg('https://api.openai.com/v1', 'off'))).toEqual({ aixia: { chat_template_kwargs: { thinking: false } } })
    expect(puppetProviderOptions(cfg('https://llm.aiqu.ai/v1', 'on'))).toEqual({ aixia: { chat_template_kwargs: { thinking: true } } })
  })
  it('reaches the model request only when configured, with toolChoice auto', async () => {
    // Break caught: options built but never passed to the agent, or toolChoice
    // 'required' (Aiqu answers 500).
    const run = async (providerOptions?: any) => {
      const model = new MockLanguageModelV4({ doGenerate: result([]) as any })
      await createPuppetAgent({ model, store: createStudioStore(), signal: new AbortController().signal, emit: () => {}, speak: async () => {}, providerOptions }).generate({ prompt: 'hi' })
      return model.doGenerateCalls[0]
    }
    const withOpts = await run({ aixia: { chat_template_kwargs: { thinking: false } } })
    expect(withOpts.providerOptions).toEqual({ aixia: { chat_template_kwargs: { thinking: false } } })
    expect(withOpts.toolChoice).toEqual({ type: 'auto' })
    expect((await run()).providerOptions).toBeUndefined()
  })
})

describe('say tool and instructions', () => {
  it('offers say (not speak), and table tools only with a table', () => {
    // Break caught: the old `speak` name lingering in the tool set or prompt,
    // and table tools/instructions leaking into the studio-only server.
    const bare = createPuppetAgent({ model: new MockLanguageModelV4(), store: createStudioStore(), signal: new AbortController().signal, emit: () => {}, speak: async () => {} })
    expect(Object.keys(bare.tools)).toContain('say')
    expect(Object.keys(bare.tools)).not.toContain('speak')
    expect(Object.keys(bare.tools).some(n => n.includes('table') || n === 'show_answer')).toBe(false)
    expect(puppetInstructions({ table: false })).not.toContain('Julius table')
    expect(puppetInstructions({ table: true })).toContain('show_answer')
  })
})

describe('puppet conversation HTTP', () => {
  async function serve(model: any, extra: Record<string, any> = {}) {
    const app = express(); app.use(express.json()); mountPuppetMaster(app, config, createStudioStore(), { model, ...extra })
    const server = createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    return { base, close }
  }
  const post = (url: string, body: unknown = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  /** Read SSE `data:` lines until `n` arrived. */
  async function sse(url: string, n: number) {
    const response = await fetch(url); const reader = response.body!.getReader(); let buffer = ''
    const lines: any[] = []
    while (lines.length < n) {
      const read = await reader.read(); if (read.done) break
      buffer += new TextDecoder().decode(read.value)
      for (const part of buffer.split('\n\n').slice(0, -1)) if (part.startsWith('data: ')) lines.push(JSON.parse(part.slice(6)))
      buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2)
      if (buffer === '') continue
    }
    await reader.cancel(); return lines
  }

  describe('voices', () => {
    const noAgent = { ...config, agentId: undefined }
    const serveVoices = async (cfg: ServerConfig, fetchImpl: typeof fetch) => {
      const app = express(); app.use(express.json())
      mountPuppetMaster(app, cfg, createStudioStore(), { model: new MockLanguageModelV4({ doGenerate: [result([call('say', { text: 'Hi.' })], 'tool-calls') as any, result([]) as any] }), voice: createVoiceProvider(cfg, fetchImpl) })
      const server = createServer(app)
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
    }
    it('GET /api/puppet/voices lists the premade voices with the config default', async () => {
      // Break caught: the UI shows a different default than the one that speaks,
      // or the list drifts from voices.ts (the one owner).
      const { base, close } = await serve(new MockLanguageModelV4())
      try {
        const body = await (await fetch(`${base}/api/puppet/voices`)).json()
        expect(body.voices).toEqual(PREMADE_VOICES)
        expect(body.voices).toHaveLength(7)
        expect(body.default).toBe('CwhRBWXzGAHq8TQ4Fs17')
      } finally { await close() }
    })
    it('prepends a custom env voice so it is never lost', async () => {
      // Break caught: a .env voice missing from the list makes the select show
      // another voice than the one speaking.
      const { base, close } = await serveVoices({ ...noAgent, voiceId: 'env-custom' }, fetch)
      try {
        const body = await (await fetch(`${base}/api/puppet/voices`)).json()
        expect(body.voices[0]).toEqual({ id: 'env-custom', label: 'Custom (ELEVENLABS_TTS_VOICE_ID)' })
        expect(body.voices).toHaveLength(8)
        expect(body.default).toBe('env-custom')
      } finally { await close() }
    })
    it('rejects a turn with an unknown voice (400) before it starts', async () => {
      // Break caught: the browser makes the server call TTS with an arbitrary
      // ElevenLabs voice id (cloned or other-account voices).
      const { base, close } = await serve(new MockLanguageModelV4())
      try {
        const { id } = await (await post(`${base}/api/puppet/sessions`)).json()
        const response = await post(`${base}/api/puppet/sessions/${id}/turn`, { text: 'Hi', voice: 'not-a-listed-voice' })
        expect(response.status).toBe(400)
        // No turn was started, so the next valid turn is not refused as busy.
        expect((await post(`${base}/api/puppet/sessions/${id}/turn`, { text: 'Hi', voice: 'Xb7hH8MSUJpSbSDYk0k2' })).status).toBe(200)
      } finally { await close() }
    })
    it('puts the selected voice in the TTS URL, and the config voice when none is selected', async () => {
      // Break caught: the pick is validated but never reaches the speech route,
      // or sticks to later turns that did not ask for it.
      const tts: string[] = []
      // The timed endpoint is tried first; answering it with one NDJSON audio line keeps this to one request per turn.
      const fake: typeof fetch = async url => { tts.push(String(url)); return new Response('{"audio_base64":"AQ=="}\n') }
      // A fresh server (and so a fresh scripted model) per turn: one model holds
      // exactly one say-then-finish script, which a second turn would find spent.
      for (const voice of ['XrExE9yKIg1WjnnlVkGX', undefined]) {
        const { base, close } = await serveVoices({ ...noAgent, voiceId: 'CwhRBWXzGAHq8TQ4Fs17' }, fake)
        try {
          const { id } = await (await post(`${base}/api/puppet/sessions`)).json()
          const response = await post(`${base}/api/puppet/sessions/${id}/turn`, { text: 'Hi', audio: true, voice })
          const reader = response.body!.getReader(); let head = ''
          // Bounded read: stop at end of stream so a missing speech event fails loudly instead of spinning.
          while (!head.includes('"speech"')) {
            const r = await reader.read()
            if (r.done) throw new Error(`stream ended without a speech event: ${head}`)
            head += new TextDecoder().decode(r.value)
          }
          const speech = head.trim().split('\n').map(l => JSON.parse(l)).find(e => e.type === 'speech')
          expect((await fetch(`${base}/api/puppet/sessions/${id}/speech/${speech.id}`)).status).toBe(200)
          await post(`${base}/api/puppet/sessions/${id}/speech/${speech.id}/ack`, { ok: true })
          for (let r = await reader.read(); !r.done; r = await reader.read());
        } finally { await close() }
      }
      expect(tts.map(u => u.split('/text-to-speech/')[1].split('/')[0])).toEqual(['XrExE9yKIg1WjnnlVkGX', 'CwhRBWXzGAHq8TQ4Fs17'])
    })
  })

  it('publishes every say to the TV channel in call order, waiting for each ack', async () => {
    // Break caught: the TV misses lines, shows them out of order, or a second
    // say starts before the first finished playing (the 2nd line would arrive
    // on the TV before the 1st ack).
    const model = new MockLanguageModelV4({ doGenerate: [
      result([call('say', { text: 'One.' }, 'a'), call('say', { text: 'Two.' }, 'b')], 'tool-calls') as any,
      result([]) as any,
    ] })
    const { base, close } = await serve(model)
    try {
      const { id } = await (await post(`${base}/api/puppet/sessions`)).json()
      const tv = sse(`${base}/api/puppet/speech/events`, 4)
      await new Promise(r => setTimeout(r, 50))
      const response = await post(`${base}/api/puppet/sessions/${id}/turn`, { text: 'Hi' })
      const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ''
      const nextEvent = async () => { while (!buffer.includes('\n')) { const r = await reader.read(); if (r.done) return null; buffer += decoder.decode(r.value) } const i = buffer.indexOf('\n'); const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); return JSON.parse(line) }
      const seen: any[] = []
      for (let e = await nextEvent(); e; e = await nextEvent()) {
        seen.push(e)
        if (e.type === 'speech') {
          // At the first speech event the second must not have been spoken yet.
          if (e.text === 'One.') expect(seen.filter(x => x.type === 'speech')).toHaveLength(1)
          await post(`${base}/api/puppet/sessions/${id}/speech/${e.id}/ack`, { ok: true })
        }
      }
      expect(seen.filter(x => x.type === 'speech').map(x => x.text)).toEqual(['One.', 'Two.'])
      const lines = await tv
      expect(lines.map(l => l.type === 'speech' ? l.text : `turn:${l.phase}`)).toEqual(['turn:start', 'One.', 'Two.', 'turn:end'])
      expect(typeof lines[1].at).toBe('number')
    } finally { await close() }
  })

  /** Run one turn on its own server and scripted model (a shared mock runs out of responses),
   * acking every speech; every read loop breaks on `done` so a missing event fails, not hangs. */
  async function speechesOf(responses: any[]) {
    const { base, close } = await serve(new MockLanguageModelV4({ doGenerate: responses }))
    try {
      const { id } = await (await post(`${base}/api/puppet/sessions`)).json()
      const tv = sse(`${base}/api/puppet/speech/events`, 100)
      await new Promise(r => setTimeout(r, 50))
      const response = await post(`${base}/api/puppet/sessions/${id}/turn`, { text: 'Hi' })
      const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ''
      const events: any[] = []
      for (;;) {
        const r = await reader.read(); if (r.done) break
        buffer += decoder.decode(r.value)
        for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
          const e = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); events.push(e)
          if (e.type === 'speech') await post(`${base}/api/puppet/sessions/${id}/speech/${e.id}/ack`, { ok: true })
        }
      }
      // The TV channel is open-ended: read what it has replayed so far via a fresh subscriber.
      const replay = await fetch(`${base}/api/puppet/speech/events`); const rr = replay.body!.getReader()
      let tvText = ''; const until = Date.now() + 300
      while (Date.now() < until && !tvText.includes('turn')) { const r = await Promise.race([rr.read(), new Promise<any>(res => setTimeout(() => res({ done: true }), 300))]); if (r.done) break; tvText += decoder.decode(r.value) }
      await rr.cancel(); void tv.catch(() => {})
      return { events, tvSpeech: [...tvText.matchAll(/"type":"speech"[^}]*"text":"([^"]*)"/g)].map(m => m[1]) }
    } finally { await close() }
  }

  it('does not speak the final text again when the turn already said it with say', async () => {
    // Break caught (seen live 7 Oct): say "Hi there, I'm Hubble" then final text
    // "Hi there — nice to meet you!" spoken as a second event. Exactly one speech
    // event, on the client stream and on the TV channel.
    const { events, tvSpeech } = await speechesOf([
      result([call('say', { text: "Hi there, I'm Hubble!" })], 'tool-calls') as any,
      result([{ type: 'text', text: 'Hi there — nice to meet you!' }]) as any,
    ])
    expect(events.filter(e => e.type === 'speech').map(e => e.text)).toEqual(["Hi there, I'm Hubble!"])
    expect(tvSpeech).toEqual(["Hi there, I'm Hubble!"])
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('still speaks the final text when the turn called no say, so nobody is left in silence', async () => {
    // Break caught: the double-speech guard over-reaches and drops the only answer.
    const { events, tvSpeech } = await speechesOf([result([{ type: 'text', text: 'Only plain text.' }]) as any])
    expect(events.filter(e => e.type === 'speech').map(e => e.text)).toEqual(['Only plain text.'])
    expect(tvSpeech).toEqual(['Only plain text.'])
  })

  it('refuses a second turn with 409 busy and the running turn finishes untouched', async () => {
    // Break caught: new speech aborting or replacing a running turn. The first
    // turn's say must still be pending, then complete, after the refusal.
    const model = new MockLanguageModelV4({ doGenerate: [result([call('say', { text: 'Working.' })], 'tool-calls') as any, result([]) as any] })
    const { base, close } = await serve(model)
    try {
      const { id } = await (await post(`${base}/api/puppet/sessions`)).json()
      const first = await post(`${base}/api/puppet/sessions/${id}/turn`, { text: 'Go' })
      const reader = first.body!.getReader()
      let head = ''; while (!head.includes('"speech"')) head += new TextDecoder().decode((await reader.read()).value)
      const speech = head.trim().split('\n').map(l => JSON.parse(l)).find(e => e.type === 'speech')
      const second = await post(`${base}/api/puppet/sessions/${id}/turn`, { text: 'Wait, something else' })
      expect(second.status).toBe(409)
      expect(await second.json()).toEqual({ error: 'busy' })
      await post(`${base}/api/puppet/sessions/${id}/speech/${speech.id}/ack`, { ok: true })
      let rest = ''; while (true) { const r = await reader.read(); if (r.done) break; rest += new TextDecoder().decode(r.value) }
      expect(rest).toContain('"done"'); expect(rest).not.toContain('"error"')
      expect(model.doGenerateCalls).toHaveLength(2)
    } finally { await close() }
  })

  it('replays recent TV lines to a display that connects late, bounded', async () => {
    // Break caught: a TV that reconnects shows a blank bubble, or replays an
    // unbounded history / a stale turn-start.
    const speech = createSpeechChannel({ replay: 2 })
    for (const t of ['a', 'b', 'c']) speech.publish({ type: 'speech', id: t, text: t })
    speech.publish({ type: 'turn', phase: 'start' })
    const { base, close } = await serve(new MockLanguageModelV4(), { speech })
    try { expect((await sse(`${base}/api/puppet/speech/events`, 2)).map(l => l.text)).toEqual(['b', 'c']) } finally { await close() }
  })

  it('waits for client acknowledgement and carries completed turns into the next model request', async () => {
    // Break caught: HTTP returns early or a new turn loses the conversation.
    const model = new MockLanguageModelV4({ doGenerate: [result([{ type: 'text', text: 'Hello from Hubble.' }]) as any, result([]) as any] })
    const app = express(); app.use(express.json()); mountPuppetMaster(app, config, createStudioStore(), { model })
    const server = createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const { id } = await (await fetch(`${base}/api/puppet/sessions`, { method: 'POST' })).json()
      const response = await fetch(`${base}/api/puppet/sessions/${id}/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hello' }) })
      const reader = response.body!.getReader()
      const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).trim())
      expect(first).toMatchObject({ type: 'speech', text: 'Hello from Hubble.', audio: false })
      const ack = await fetch(`${base}/api/puppet/sessions/${id}/speech/${first.id}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) })
      expect(ack.status).toBe(204)
      let remaining = ''
      while (true) { const read = await reader.read(); if (read.done) break; remaining += new TextDecoder().decode(read.value) }
      expect(remaining).toContain('"done"')
      const next = await fetch(`${base}/api/puppet/sessions/${id}/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Continue' }) })
      await next.text()
      expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('Hello from Hubble.')
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it('keeps what show_answer put on the table per conversation, so a later turn\'s follow-up sees it, and sanitises the turn\'s scene', async () => {
    // Break caught: history living only inside one turn (a follow-up like "explain the last step"
    // reaches the brain alone), or an unsanitised client scene reaching the brain's prompt.
    // Provenance: synthetic fake table; the model's tool calls are schema-derived.
    const seen: any[] = []
    const table = {
      inspect: () => ({}), setAct() {}, openAsset: () => ({ surface: 'x' }), openWeb: async () => ({ surface: 'x' }), drawSvg: () => ({ surface: 'x' }), moveSurface: () => true, raiseSurface() {}, closeSurface() {}, openKeyboard() {}, closeKeyboard() {}, startLesson() {}, stopLesson() {}, clearTable() {},
      cleanScene: (raw: unknown) => (raw === 'dirty' ? ({ surface: { widthPx: 1, heightPx: 1, mmPerPx: 1 }, objects: [] } as any) : undefined),
      showAnswer: async (intent: string, _s: AbortSignal, ctx: any) => (seen.push({ intent, ctx }), { answer: `A(${intent})` }),
    } as any
    const model = new MockLanguageModelV4({ doGenerate: [
      result([call('show_answer', { intent: 'Solve 2x=4' })], 'tool-calls') as any, result([{ type: 'text', text: 'ok' }]) as any,
      result([call('show_answer', { intent: 'Explain the last step' })], 'tool-calls') as any, result([{ type: 'text', text: 'ok' }]) as any,
    ] })
    const { base, close } = await serve(model, { table })
    try {
      const { id } = await (await post(`${base}/api/puppet/sessions`)).json()
      const turn = async (body: object) => {
        const r = await post(`${base}/api/puppet/sessions/${id}/turn`, body)
        const reader = r.body!.getReader(); let text = ''
        while (true) {
          const read = await reader.read(); if (read.done) break
          text += new TextDecoder().decode(read.value)
          for (const line of text.split('\n')) { try { const e = JSON.parse(line); if (e.type === 'speech') await post(`${base}/api/puppet/sessions/${id}/speech/${e.id}/ack`, { ok: true }) } catch {} }
        }
      }
      await turn({ text: 'solve', scene: 'dirty', image: 'data:image/png;base64,AA' })
      await turn({ text: 'follow up', scene: 'junk' })
      expect(seen[0].ctx).toMatchObject({ history: [], image: 'data:image/png;base64,AA', scene: { objects: [] } })
      expect(seen[1].ctx.history).toEqual([{ intent: 'Solve 2x=4', answer: 'A(Solve 2x=4)' }])
      expect(seen[1].ctx.scene).toBeUndefined()
    } finally { await close() }
  })
})
