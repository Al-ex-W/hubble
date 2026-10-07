import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { simulateReadableStream } from 'ai'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { mountPuppetLab, type LabEvent } from './puppetLab.ts'
import { createVoiceProvider } from './puppetMaster.ts'
import { PREMADE_VOICES } from './voices.ts'
import type { ServerConfig } from './config.ts'

// Provenance: SCHEMA-DERIVED stream parts (the AI SDK's LanguageModelV4 stream
// part shapes) and a fake fetch standing in for ElevenLabs. The shapes were
// cross-checked against the live probe in docs/plans/2026-10-07-puppet-lab.md
// (reasoning -> text "\n\n" -> tool-call), but no byte here is a recording.
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }
const finish = (reason = 'stop') => ({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage })
const streamOf = (parts: any[]) => new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [{ type: 'stream-start', warnings: [] }, ...parts] }) as any }) })
const reasoning = (t: string) => [{ type: 'reasoning-start', id: 'r' }, { type: 'reasoning-delta', id: 'r', delta: t }, { type: 'reasoning-end', id: 'r' }]
const text = (t: string) => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: t }, { type: 'text-end', id: 't' }]
const sayCall = (t: string) => ({ type: 'tool-call', toolCallId: 'c1', toolName: 'say', input: JSON.stringify({ text: t }) })
const config: ServerConfig = { elevenLabsApiKey: 'test-el', port: 0, jevApiKey: undefined, llm: { apiKey: 'test-model', model: 'aixia-labs', baseUrl: 'https://example.test/v1' } }

interface TtsCall { url: string; body: any }
function lab(model: MockLanguageModelV4, extra: Parameters<typeof mountPuppetLab>[2] = {}) {
  const tts: TtsCall[] = []
  const fakeFetch = (async (url: string, init: RequestInit) => {
    tts.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return new Response(new Uint8Array([1, 2, 3]))
  }) as unknown as typeof fetch
  const app = express(); app.use(express.json())
  mountPuppetLab(app, config, { model, voice: createVoiceProvider(config, fakeFetch), ...extra })
  const server: Server = createServer(app)
  return new Promise<{ base: string; tts: TtsCall[]; close: () => void }>(resolve => server.listen(0, () => resolve({
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tts, close: () => server.close(),
  })))
}
// Reads NDJSON until `done`/`error`; the break matters: a stream that never
// ends must fail this test, not hang the suite.
async function run(base: string, body: unknown) {
  const res = await fetch(`${base}/api/puppet/lab/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.body || res.status !== 200) return { status: res.status, events: [] as LabEvent[] }
  const events: LabEvent[] = []; const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
  outer: for (;;) {
    const { value, done } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true })
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const event = JSON.parse(buf.slice(0, nl)) as LabEvent; buf = buf.slice(nl + 1); events.push(event)
      if (event.type === 'done' || event.type === 'error') break outer
    }
  }
  await reader.cancel().catch(() => {})
  return { status: res.status, events }
}

describe('puppet lab', () => {
  it('rejects a voice outside the closed list with 400, before any model call', async () => {
    // Break caught: the lab trusting the browser's voice id, letting any page
    // make the server call TTS with an unvetted (cloned / foreign) voice.
    const model = streamOf([finish()])
    const s = await lab(model)
    const out = await run(s.base, { text: 'hi', thinking: false, voice: 'not-a-real-voice' })
    expect(out.status).toBe(400)
    expect(model.doStreamCalls).toHaveLength(0)
    expect(s.tts).toHaveLength(0)
    s.close()
  })

  it('streams reasoning, then the tool call, then speech, then timing and done, in that order', async () => {
    // Break caught: events emitted out of causal order (speech before the call
    // that produced it), which would make the page show a conclusion before its reasoning.
    const s = await lab(streamOf([...reasoning('17 times 23 is 391'), ...text('\n\n'), sayCall('It is 391.'), finish('tool-calls')]))
    const { events } = await run(s.base, { text: 'what is 17 times 23', thinking: true })
    const order = events.map(e => e.type)
    expect(order.indexOf('reasoning')).toBeLessThan(order.indexOf('tool-call'))
    expect(order.indexOf('tool-call')).toBeLessThan(order.indexOf('speech'))
    expect(order.slice(-2)).toEqual(['timing', 'done'])
    expect(events.find(e => e.type === 'reasoning')).toMatchObject({ delta: '17 times 23 is 391' })
    expect(events.find(e => e.type === 'tool-call')).toMatchObject({ name: 'say', input: { text: 'It is 391.' } })
    // Auto toolChoice and the model obeyed: neither forced nor synthesized.
    expect(events.find(e => e.type === 'timing')).toMatchObject({ path: 'auto-instructed', reasoningChars: 18 })
    s.close()
  })

  it('speaks the say text with the chosen voice and the TTS model, through the speech route', async () => {
    // Break caught: the tool's text or the picked voice not reaching ElevenLabs
    // (speech in the default voice, or in words the model never chose).
    const s = await lab(streamOf([sayCall('Hello there.'), finish('tool-calls')]))
    const chosen = PREMADE_VOICES[3].id
    const { events } = await run(s.base, { text: 'hi', thinking: false, voice: chosen })
    const speech = events.find(e => e.type === 'speech') as Extract<LabEvent, { type: 'speech' }>
    expect(speech.text).toBe('Hello there.')
    const audio = await fetch(`${s.base}/api/puppet/lab/speech/${speech.id}`)
    expect(audio.status).toBe(200)
    expect((await audio.arrayBuffer()).byteLength).toBe(3)
    expect(s.tts).toHaveLength(1)
    expect(s.tts[0].url).toContain(`/text-to-speech/${chosen}/`)
    expect(s.tts[0].body).toMatchObject({ text: 'Hello there.' })
    expect((await fetch(`${s.base}/api/puppet/lab/speech/unknown-id`)).status).toBe(404)
    s.close()
  })

  it('wraps a plain-text answer in a say and labels the run as the fallback', async () => {
    // Break caught: with toolChoice 'auto' a model that answers in text makes
    // the demo silent (no say, no speech) while looking successful.
    const s = await lab(streamOf([...text('Hi, I am Hubble.'), finish()]))
    const { events } = await run(s.base, { text: 'hi', thinking: false })
    expect(events.find(e => e.type === 'tool-call')).toMatchObject({ name: 'say', input: { text: 'Hi, I am Hubble.' }, synthesized: true })
    expect(events.find(e => e.type === 'speech')).toMatchObject({ text: 'Hi, I am Hubble.' })
    expect(events.find(e => e.type === 'timing')).toMatchObject({ path: 'fallback' })
    s.close()
  })

  it('passes a named toolChoice to the model and labels the run forced', async () => {
    // Break caught: the forced toolChoice being dropped, so "forced" would be
    // claimed while the provider was never asked to force anything.
    const model = streamOf([sayCall('Forced.'), finish('tool-calls')])
    const s = await lab(model, { toolChoice: { type: 'tool', toolName: 'say' } })
    const { events } = await run(s.base, { text: 'hi', thinking: false })
    expect((model.doStreamCalls[0].toolChoice as any)).toEqual({ type: 'tool', toolName: 'say' })
    expect(events.find(e => e.type === 'timing')).toMatchObject({ path: 'forced' })
    s.close()
  })

  it('reports a provider failure as an error event, not a silent end', async () => {
    // Break caught: a gateway 500 (recorded for forced toolChoice) ending the
    // stream with no event, which the page would show as an empty run.
    const model = new MockLanguageModelV4({ doStream: async () => { throw Object.assign(new Error('boom'), { statusCode: 500 }) } })
    const s = await lab(model)
    const { events } = await run(s.base, { text: 'hi', thinking: false })
    // The status must survive: a mutant that swallowed the provider error part
    // only said "neither called say nor answered", hiding that the gateway failed.
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('HTTP 500') })
    expect(JSON.stringify(events)).not.toContain('boom')
    s.close()
  })
})
