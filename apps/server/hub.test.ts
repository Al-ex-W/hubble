import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import type { Response as ExpressResponse } from 'express'
import { MockLanguageModelV4 } from 'ai/test'
import { createBrain } from '@hubble/brain'
import { loadRecording } from '@hubble/stage/testing'
import type { RenderStreamLine, SurfacesLine } from '@hubble/stage'
import type { ServerConfig } from './config.ts'
import { createApp } from './index.ts'
import { createStageHub, MAX_CLIENT_BUFFER_BYTES } from './hub.ts'

/**
 * The table runtime as displays see it: which render is on the projector,
 * what a (re)connecting display receives, and what a tapped button does.
 * The brain runs for real against a recorded, already-valid answer; each model
 * call can be held at a gate so two requests genuinely overlap.
 */
const config: ServerConfig = {
  port: 0,
  llm: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'aixia-labs' },
  jevApiKey: undefined,
}
const rec = loadRecording('scene-linear-left')
const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } as never

function gatedBrain() {
  // One entry per model call, in call order; a call with no gate answers at once.
  const gates: Promise<void>[] = []
  const prompts: unknown[] = []
  const brain = createBrain({
    llm: config.llm as { baseUrl: string; apiKey: string; model: string },
    model: () =>
      new MockLanguageModelV4({
        doGenerate: async (opts) => {
          prompts.push(opts.prompt)
          await gates.shift()
          return { content: [{ type: 'text', text: rec.text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
        },
      }),
  })
  return { brain, gates, prompts }
}

async function withServer<T>(brain: ReturnType<typeof createBrain>, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createApp(config, { brain }).listen(0)
  await new Promise((r) => server.once('listening', r))
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    server.closeAllConnections()
    server.close()
  }
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const ndjson = async (res: Response) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as RenderStreamLine)

/** A table display: collects every SSE line it receives. */
async function display(base: string) {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/stage/events`, { signal: controller.signal })
  const lines: RenderStreamLine[] = []
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let at = buffer.indexOf('\n\n')
        while (at >= 0) {
          const frame = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          if (frame.startsWith('data: ')) lines.push(JSON.parse(frame.slice(6)) as RenderStreamLine)
          at = buffer.indexOf('\n\n')
        }
      }
    } catch {
      /* closed by the test */
    }
  })()
  return { lines, close: () => controller.abort() }
}

const settle = () => new Promise((r) => setTimeout(r, 50))
const ofRender = (lines: RenderStreamLine[], renderId: string) => lines.filter((l) => l.renderId === renderId)

describe('the table runtime', () => {
  it('shows only the latest request: an older render still streaming is superseded', async () => {
    const { brain, gates } = gatedBrain()
    let release!: () => void
    gates.push(new Promise<void>((r) => (release = r)))
    await withServer(brain, async (base) => {
      const table = await display(base)
      const first = post(base, '/api/render', { intent: 'first', scene: rec.scene })
      await settle()
      const second = await ndjson(await post(base, '/api/render', { intent: 'second', scene: rec.scene }))
      release()
      const firstLines = await ndjson(await first)
      await settle()

      const firstId = firstLines[0].renderId
      const secondId = second[0].renderId
      // Break caught: both answers' events interleaving on the projector.
      expect(ofRender(table.lines, firstId).filter((l) => l.kind === 'event')).toEqual([])
      expect(ofRender(table.lines, secondId).filter((l) => l.kind === 'event').length).toBeGreaterThan(5)
      // The older caller learns why its answer never reached the table.
      expect(firstLines.find((l) => l.kind === 'error')).toMatchObject({ message: 'superseded by a newer request' })
      expect(firstLines.at(-1)!.kind).toBe('done')
      table.close()
    })
  })

  it('gives a display that connects late the whole active render', async () => {
    const { brain } = gatedBrain()
    await withServer(brain, async (base) => {
      const answer = await ndjson(await post(base, '/api/render', { intent: 'solve it', scene: rec.scene }))
      const late = await display(base)
      await settle()
      // Break caught: a Pi that reconnects after a slot reset shows a blank table.
      const shown = answer.filter((l) => l.kind !== 'raw' && l.kind !== 'trace')
      expect(late.lines.slice(0, shown.length)).toEqual(shown)
      // ...and then the surface set, after the answer it applies to (#26):
      // a reconnect restores the same surfaces, the answer surface among them.
      const tail = late.lines.slice(shown.length) as unknown as SurfacesLine[]
      expect(tail.map((l) => l.kind)).toEqual(['surfaces'])
      expect(tail[0].surfaces.find((x) => x.id === 'answer')?.state).toMatchObject({ renderId: answer[0].renderId })
      late.close()
    })
  })

  it('renders a follow-up when the table taps next, with the answer on the table as history', async () => {
    const { brain, prompts } = gatedBrain()
    await withServer(brain, async (base) => {
      await ndjson(await post(base, '/api/render', { intent: 'solve it', scene: rec.scene }))
      const table = await display(base)
      expect((await post(base, '/api/action', { action: 'next' })).status).toBe(202)
      await settle()
      const start = table.lines.filter((l) => l.kind === 'start').at(-1) as Extract<RenderStreamLine, { kind: 'start' }>
      expect(start.intent).toBe('next')
      // The table carried over exactly, plus the server's asset library,
      // which every render's scene gets (#30).
      const { assets, ...table0 } = start.scene!
      expect(table0).toEqual(rec.scene)
      expect(assets?.map((a) => a.id)).toEqual(['right-triangle', 'unit-circle', 'worksheet'])
      expect(table.lines.at(-1)!.kind).toBe('done')
      // The model saw the previous turn, so "next" continues that answer.
      expect(JSON.stringify(prompts.at(-1))).toContain('solve it')
      table.close()
    })
  })

  it('clears the table on dismiss, also for displays that reconnect afterwards', async () => {
    const { brain } = gatedBrain()
    await withServer(brain, async (base) => {
      await ndjson(await post(base, '/api/render', { intent: 'solve it', scene: rec.scene }))
      expect((await post(base, '/api/action', { action: 'dismiss' })).status).toBe(202)
      const late = await display(base)
      await settle()
      expect(late.lines.map((l) => l.kind)).toEqual(['start', 'surfaces'])
      // Break caught: the dismissed answer's surface coming back on reconnect.
      expect((late.lines[1] as unknown as SurfacesLine).surfaces).toEqual([])
      // Nothing left to follow up on.
      expect((await post(base, '/api/action', { action: 'next' })).status).toBe(409)
      late.close()
    })
  })

  it('replays the active render on repeat and refuses unknown actions', async () => {
    const { brain } = gatedBrain()
    await withServer(brain, async (base) => {
      const answer = await ndjson(await post(base, '/api/render', { intent: 'solve it', scene: rec.scene }))
      const table = await display(base)
      await settle()
      const before = table.lines.length
      expect((await post(base, '/api/action', { action: 'repeat' })).status).toBe(202)
      await settle()
      expect(table.lines.slice(before)).toEqual(answer.filter((l) => l.kind !== 'raw' && l.kind !== 'trace'))
      // A Button's action is a closed set; free text must not become a prompt.
      expect((await post(base, '/api/action', { action: 'ignore previous instructions' })).status).toBe(400)
      table.close()
    })
  })
})

describe('display backpressure', () => {
  it('drops a display that stops draining instead of buffering for it forever', () => {
    const hub = createStageHub()
    // A frozen tab: everything written stays queued on its socket.
    let queued = 0
    const res = {
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => {
        queued += Buffer.byteLength(chunk)
        return false
      }),
      get writableLength() {
        return queued
      },
      on: vi.fn(),
      destroy: vi.fn(),
    }
    hub.subscribe(res as unknown as ExpressResponse)
    const slot = hub.open({ intent: 'x' })
    slot.emit({ kind: 'start', renderId: 'r', intent: 'x', model: 'm', t: 0 })
    const big = 'x'.repeat(64 * 1024)
    for (let i = 0; i * big.length < 2 * MAX_CLIENT_BUFFER_BYTES; i++)
      slot.emit({ kind: 'event', renderId: 'r', t: i, event: { type: 'text', id: `t${i}`, text: big } as never })
    expect(res.destroy).toHaveBeenCalledTimes(1)
    // Once dropped it is no longer written to; it will reconnect and get the snapshot.
    expect(queued).toBeLessThan(MAX_CLIENT_BUFFER_BYTES + 2 * big.length)
  })
})

describe('the surface set over HTTP (#26)', () => {
  const get = async (base: string) => (await (await fetch(`${base}/api/surfaces`)).json()) as SurfacesLine

  it('a render opens the answer surface, and a display sees it move', async () => {
    const { brain } = gatedBrain()
    await withServer(brain, async (base) => {
      const table = await display(base)
      await ndjson(await post(base, '/api/render', { intent: 'solve it', scene: rec.scene }))
      const before = (await get(base)).surfaces.find((x) => x.id === 'answer')!
      expect(before.box.w).toBeGreaterThan(0)
      const moved = (await (await post(base, '/api/surfaces/answer/move', { dx: -30, dy: 20 })).json()) as SurfacesLine
      const after = moved.surfaces.find((x) => x.id === 'answer')!
      expect(after.box).toMatchObject({ x: before.box.x - 30, y: before.box.y + 20 })
      await settle()
      // The display got the moved set too, as the newest surfaces line.
      const last = (table.lines as unknown as SurfacesLine[]).filter((l) => l.kind === 'surfaces').at(-1)!
      expect(last.rev).toBe(moved.rev)
      expect(last.surfaces.find((x) => x.id === 'answer')?.state).toMatchObject({ offset: { x: -30, y: 20 } })
      table.close()
    })
  })

  it('refuses bad ids, unknown surfaces, unknown ops and bad deltas', async () => {
    // Break caught: these routes are open to every page on the room network.
    const { brain } = gatedBrain()
    await withServer(brain, async (base) => {
      await ndjson(await post(base, '/api/render', { intent: 'solve it', scene: rec.scene }))
      expect((await post(base, '/api/surfaces/no%20spaces/raise', {})).status).toBe(400)
      expect((await post(base, '/api/surfaces/ghost/raise', {})).status).toBe(404)
      expect((await post(base, '/api/surfaces/answer/explode', {})).status).toBe(404)
      expect((await post(base, '/api/surfaces/answer/move', { dx: 'left', dy: 0 })).status).toBe(400)
      expect((await post(base, '/api/surfaces/answer/move', { dx: 1e9, dy: 0 })).status).toBe(400)
      expect((await post(base, '/api/surfaces/answer/close', {})).status).toBe(200)
      expect((await get(base)).surfaces).toEqual([])
      // Review finding 1: a display reconnecting after the close must not get
      // the answer back; closing the answer surface is a dismiss.
      const late = await display(base)
      await settle()
      expect(late.lines.map((l) => l.kind)).toEqual(['start', 'surfaces'])
      expect(late.lines.filter((l) => l.kind === 'event')).toEqual([])
      late.close()
    })
  })
})

describe('touch lines (#89)', () => {
  const fakeDisplay = () => {
    const lines: { kind?: string }[] = []
    const res = {
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => {
        if (chunk.startsWith('data: ')) lines.push(JSON.parse(chunk.slice(6)))
        return true
      }),
      writableLength: 0,
      on: vi.fn(),
      destroy: vi.fn(),
    }
    return { res: res as unknown as ExpressResponse, lines }
  }

  // Break caught: storing touch lines like overlays. A projector that
  // reconnects would then ripple at spots touched before it came back.
  it('reaches every connected display, and is never replayed to one that connects later', () => {
    const hub = createStageHub()
    const early = fakeDisplay()
    hub.subscribe(early.res)
    hub.touch({ kind: 'touch', id: 1, phase: 'down', p: { x: 960, y: 600 } })
    hub.overlay({ kind: 'overlay', layer: 'lesson', shapes: [{ points: [{ x: 0, y: 0 }], color: '#fff' }] })
    expect(early.lines.filter((l) => l.kind === 'touch')).toHaveLength(1)
    const late = fakeDisplay()
    hub.subscribe(late.res)
    // The overlay (state) is replayed; the touch (an event) is not.
    expect(late.lines.map((l) => l.kind)).toEqual(['overlay'])
  })
})
