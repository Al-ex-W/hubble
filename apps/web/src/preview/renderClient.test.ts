import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { createBrain } from '@hubble/brain'
import { loadRecording } from '@hubble/stage/testing'
import type { RenderRequest, RenderStreamLine } from '@hubble/stage'
import { createRenderClient } from './renderClient.ts'

/**
 * The bench's stream handling against what the server really sends: the
 * lines come from the brain running on a recorded, already-valid answer.
 */
const rec = loadRecording('scene-linear-left')
const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } as never
const brain = createBrain({
  llm: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'aixia-labs' },
  model: () => new MockLanguageModelV4({ doGenerate: { content: [{ type: 'text', text: rec.text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] } }),
})
async function recordedLines(req: RenderRequest): Promise<RenderStreamLine[]> {
  const lines: RenderStreamLine[] = []
  await brain.render({ ...req, scene: rec.scene! }, (l) => lines.push(l))
  return lines
}

/**
 * A fetch whose NDJSON body the test feeds by hand, so two attempts can be
 * interleaved line by line. Aborting errors the body like a browser does.
 */
function fakeServer() {
  const streams: { body: string; push(line: RenderStreamLine): void; end(): void }[] = []
  const fetch = (async (_url: string, init: RequestInit) => {
    const enc = new TextEncoder()
    let ctl!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) })
    init.signal!.addEventListener('abort', () => ctl.error(new DOMException('aborted', 'AbortError')))
    streams.push({
      body: init.body as string,
      push: (line) => ctl.enqueue(enc.encode(`${JSON.stringify(line)}\n`)),
      end: () => ctl.close(),
    })
    return new Response(body, { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { fetch, streams }
}
const tick = () => new Promise((r) => setTimeout(r, 5))

describe('createRenderClient', () => {
  it('keeps a replaced request and its replacement apart', async () => {
    const server = fakeServer()
    const client = createRenderClient({ fetch: server.fetch, schedule: (f) => void setTimeout(f, 0) })
    const first = await recordedLines({ intent: 'first' })
    const second = await recordedLines({ intent: 'second' })

    client.run({ intent: 'first', scene: rec.scene! })
    await tick()
    // The first answer is mid-stream (start and a few lines buffered, not yet
    // committed) when the user sends a new request.
    for (const line of first.slice(0, 4)) server.streams[0].push(line)
    client.run({ intent: 'second', scene: rec.scene! })
    await tick()
    for (const line of second) server.streams[1].push(line)
    server.streams[1].end()
    await tick()

    const runs = client.getRuns()
    expect(runs.map((r) => [r.request.intent, r.status, r.error])).toEqual([
      // Break caught: the old run spinning forever, or carrying the new request.
      ['first', 'error', 'cancelled'],
      ['second', 'done', undefined],
    ])
    expect(runs[1].events.length).toBe(second.filter((l) => l.kind === 'event').length)
  })

  it('records the scene each run was rendered for, so a replay uses it', async () => {
    const server = fakeServer()
    const client = createRenderClient({ fetch: server.fetch, schedule: (f) => void setTimeout(f, 0) })
    client.run({ intent: 'solve it', scene: rec.scene! })
    await tick()
    for (const line of await recordedLines({ intent: 'solve it' })) server.streams[0].push(line)
    server.streams[0].end()
    await tick()
    expect(client.getRuns()[0].scene).toEqual(rec.scene)
  })

  it('keeps a superseded run marked as an error, not an empty success', async () => {
    const server = fakeServer()
    const client = createRenderClient({ fetch: server.fetch, schedule: (f) => void setTimeout(f, 0) })
    client.run({ intent: 'first' })
    await tick()
    const [start] = await recordedLines({ intent: 'first' })
    // The server's shape for a request a newer one took the table from.
    server.streams[0].push(start)
    server.streams[0].push({ kind: 'error', renderId: start.renderId, t: 0, message: 'superseded by a newer request' })
    server.streams[0].push({ kind: 'done', renderId: start.renderId, t: 0, answer: '', firstContentMs: null })
    server.streams[0].end()
    await tick()
    expect(client.getRuns()[0]).toMatchObject({ status: 'error', error: 'superseded by a newer request' })
  })
})
