import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import type { RenderRequest } from '@hubble/stage'
import type { ServerConfig } from './config.ts'
import { createApp } from './index.ts'

/*
 * The table agent through the real server (#54): HTTP turn → agent → the
 * server's own operations → the runtime's table. The agent's model replays
 * RECORDED first steps (packages/brain/fixtures/table-agent, real aixia-labs
 * turns); the brain is a stub that records what it was asked, so these test
 * the wiring, not the model.
 */

const config: ServerConfig = { port: 0, llm: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'aixia-labs' }, jevApiKey: undefined }
const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } as never
const recorded = (name: string) => JSON.parse(readFileSync(new URL(`../../packages/brain/fixtures/table-agent/${name}.json`, import.meta.url), 'utf8')) as { steps: { toolCalls: { name: string; input: unknown }[] }[] }
const step = (calls: { name: string; input: unknown }[]) => ({
  content: calls.map((c, i) => ({ type: 'tool-call' as const, toolCallId: `t${i}-${Math.random().toString(36).slice(2, 6)}`, toolName: c.name, input: JSON.stringify(c.input) })),
  finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
  usage,
  warnings: [],
})

function stubBrain() {
  const asked: RenderRequest[] = []
  return {
    asked,
    render: async (req: RenderRequest, emit: (l: unknown) => void) => {
      asked.push(req)
      emit({ kind: 'start', renderId: `r${asked.length}`, intent: req.intent, model: 'm', t: 0, scene: req.scene })
      emit({ kind: 'done', renderId: `r${asked.length}`, t: 1, answer: `<Canvas><Panel x={100} y={100} w={400}><Text>answer ${asked.length}</Text></Panel></Canvas>`, firstContentMs: 1 })
    },
  }
}

async function withServer<T>(steps: unknown[], fn: (base: string, brain: ReturnType<typeof stubBrain>, app: ReturnType<typeof createApp>, model: MockLanguageModelV4) => Promise<T>) {
  const brain = stubBrain()
  const model = new MockLanguageModelV4({ doGenerate: steps as never })
  const app = createApp(config, { brain: brain as never, agentModel: model })
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, brain, app, model)
  } finally {
    server.closeAllConnections()
    server.close()
  }
}
const turn = async (base: string, text: string, from = 'chat', extra: Record<string, unknown> = {}) =>
  (await fetch(`${base}/api/agent/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, from, ...extra }) })).json()
const say = step([{ name: 'say', input: { text: 'ok' } }])
const systemOf = (model: MockLanguageModelV4, i: number) => (model.doGenerateCalls[i]!.prompt as { role: string; content: string }[])[0]!.content

describe('the table agent through the server', () => {
  it('"show me the right triangle" opens the library asset on the table', async () => {
    await withServer([step(recorded('asset').steps[0]!.toolCalls)], async (base, _b, app) => {
      const r = await turn(base, 'Show me the right triangle diagram')
      expect(r.calls).toEqual([{ name: 'open_asset', input: { id: 'right-triangle' }, ok: true }])
      // Break caught: the tool reporting ok while nothing reached the table.
      expect(app.runtime.surfaces.list().some((s) => s.kind === 'asset' && s.id.includes('right-triangle'))).toBe(true)
    })
  })

  it('"let\'s play piano" switches to the lesson act and starts the song', async () => {
    // The recorded piano turn calls set_act(lesson) then start_lesson; here
    // start_lesson runs alone (its recorded call), so each tool's own path
    // is what gets tested, not set_act covering for it.
    const startOnly = recorded('piano').steps[0]!.toolCalls.filter((c) => c.name === 'start_lesson')
    expect(startOnly).toHaveLength(1)
    await withServer([step(recorded('asset').steps[0]!.toolCalls), step(startOnly)], async (base, _b, app) => {
      await turn(base, 'Show me the right triangle diagram')
      expect(app.runtime.surfaces.list()).toHaveLength(1)
      await turn(base, "Let's play piano, teach me Ode to Joy")
      expect(app.runtime.state()).toMatchObject({ act: 'lesson', lesson: { song: 'Ode to Joy' } })
      // Break caught: start_lesson bypassing the operator's act switch, which
      // is what clears the table (the keyboard act is key highlights only).
      expect(app.runtime.surfaces.list()).toEqual([])
    })
  })

  it('"I want to type" opens the projected keyboard', async () => {
    await withServer([step(recorded('keyboard').steps[0]!.toolCalls)], async (base, _b, app) => {
      await turn(base, 'I want to type something')
      expect(app.runtime.surfaces.list().some((s) => s.kind === 'keyboard')).toBe(true)
    })
  })

  it('a follow-up from the keyboard carries the earlier answer to the brain (fixes #51)', async () => {
    await withServer(
      [step([{ name: 'render_answer', input: { intent: 'Explain the Pythagorean theorem' } }]), step([{ name: 'render_answer', input: { intent: 'Prove the Pythagorean theorem' } }])],
      async (base, brain) => {
        await turn(base, 'Explain the Pythagorean theorem')
        await turn(base, 'now prove it', 'keyboard')
        // Break caught: the second turn rendered with no history (what the
        // bench and the keyboard sent before the agent).
        expect(brain.asked).toHaveLength(2)
        expect(brain.asked[1]!.history).toEqual([{ intent: 'Explain the Pythagorean theorem', answer: expect.stringContaining('answer 1') }])
        // Every render still gets the library (the asset policy of /api/render).
        expect(brain.asked[1]!.scene?.assets?.map((a) => a.id)).toContain('right-triangle')
      },
    )
  })

  it('"reset the show" forgets the conversation: the next answer gets no history', async () => {
    await withServer(
      [step([{ name: 'render_answer', input: { intent: 'Solve the worksheet photo, task 2' } }]), step([{ name: 'render_answer', input: { intent: 'Solve problem 2' } }])],
      async (base, brain) => {
        await turn(base, 'Solve the task on the worksheet')
        await fetch(`${base}/api/operator/reset`, { method: 'POST' })
        await turn(base, 'Solve problem 2')
        // Break caught (rehearsal, 7 Oct): reset kept the agent's turns, so
        // "problem 2" was read off an earlier answer about a different sheet
        // instead of the iPad's picks.
        expect(brain.asked).toHaveLength(2)
        expect(brain.asked[1]!.history ?? []).toEqual([])
      },
    )
  })

  it('refuses a private address and opens nothing', async () => {
    // The default policy is any public site (7 Oct), so what must still be
    // refused is the local network: here, the room's projector Pi.
    await withServer([step([{ name: 'open_web', input: { url: 'http://192.168.42.21/status' } }]), { content: [{ type: 'text', text: 'not allowed' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }], async (base, _b, app) => {
      const r = await turn(base, 'open the projector')
      // Break caught: the agent's open_web skipping the policy the route
      // enforces, which would let a spoken request reach the room's devices.
      expect(r.calls[0]).toMatchObject({ name: 'open_web', ok: false })
      expect(app.runtime.surfaces.list().some((s) => s.kind === 'web')).toBe(false)
    })
  })

  it('MUTATION (explain, render first): the answer is verified with the asset of the same turn already on the table', async () => {
    // The explain recording's two calls, reordered to how its first
    // recording had them (render_answer, then open_asset).
    const calls = [...recorded('explain').steps[0]!.toolCalls].sort((a) => (a.name === 'render_answer' ? -1 : 1))
    expect(calls.map((c) => c.name)).toEqual(['render_answer', 'open_asset'])
    await withServer([step(calls)], async (base, brain) => {
      await turn(base, 'Explain the Pythagorean theorem')
      // Break caught: the brain verifying a layout against a table without
      // the asset, which then opened over the verified answer (review #55).
      expect(brain.asked).toHaveLength(1)
      expect(brain.asked[0]!.scene?.objects.map((o) => o.id)).toContain('surface-asset-right-triangle')
    })
  })

  it('forwards the turn\'s notebook photo to the render', async () => {
    const photo = 'data:image/jpeg;base64,/9j/AAAA'
    await withServer([step(recorded('notebook').steps[0]!.toolCalls)], async (base, brain) => {
      await turn(base, 'Solve the task in my notebook', 'chat', { image: photo })
      // Break caught: "solve my notebook" rendered without the notebook.
      expect(brain.asked[0]!.image).toBe(photo)
    })
  })

  it('an unknown asset id is refused and nothing opens', async () => {
    await withServer([step([{ name: 'open_asset', input: { id: 'cat' } }]), say], async (base, _b, app, model) => {
      const r = await turn(base, 'Show me a picture of a cat')
      // Break caught: a lookup that falls back to some other asset.
      expect(r.calls[0]).toMatchObject({ name: 'open_asset', ok: false })
      expect(app.runtime.surfaces.list()).toEqual([])
      // ...and the model is told which ids exist, so it can correct itself.
      expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain('right-triangle')
    })
  })

  it('tells the agent the table in real mm at the live scale, not the default one', async () => {
    // Schema-derived probe (no projector to record yet): a render whose scene
    // sets a 1 mm/px surface, then the real 200 × 150 mm right-triangle asset.
    const surface = { widthPx: 1920, heightPx: 1080, mmPerPx: 1 }
    await withServer([step([{ name: 'render_answer', input: { intent: 'hi' } }]), step(recorded('asset').steps[0]!.toolCalls), say], async (base, _b, app, model) => {
      await turn(base, 'hi', 'chat', { scene: { surface, objects: [] } })
      expect(app.runtime.surfaces.bounds().mmPerPx).toBe(1)
      await turn(base, 'Show me the right triangle diagram')
      await turn(base, 'thanks')
      // Break caught: boxes converted with a scale captured at startup
      // (0.78125 mm/px showed this asset as 156 × 117 mm).
      expect(systemOf(model, 2)).toMatch(/^- asset-right-triangle \(asset, .* mm, 200×150 mm$/m)
    })
  })

  it('"draw a circle around my cup" opens a drawing at the recorded size and centre', async () => {
    const calls = recorded('draw-around-cup').steps[0]!.toolCalls
    const input = calls.find((c) => c.name === 'draw_svg')!.input as { widthMm: number; xMm: number; yMm: number }
    await withServer([step(calls)], async (base, _b, app) => {
      const r = await turn(base, 'Draw a circle around my cup')
      expect(r.calls.map((c: { name: string; ok: boolean }) => [c.name, c.ok])).toEqual([['draw_svg', true]])
      const d = app.runtime.surfaces.list().find((s) => s.kind === 'drawing')!
      // Break caught: the tool reporting ok while nothing reached the table,
      // or the drawing ignoring the size and spot the model chose (a circle
      // "around the cup" drawn in the middle of the table, at the wrong size).
      const mmPerPx = app.runtime.surfaces.bounds().mmPerPx
      expect(d.box.w * mmPerPx).toBeCloseTo(input.widthMm, 5)
      expect((d.box.x + d.box.w / 2) * mmPerPx).toBeCloseTo(input.xMm, 5)
      expect((d.box.y + d.box.h / 2) * mmPerPx).toBeCloseTo(input.yMm, 5)
      expect(String(d.state.svg)).toMatch(/^<svg[^>]* width="\d+"/)
    })
  })

  it('a drawing with a script is refused, the model is told why, and nothing opens', async () => {
    const calls = recorded('draw-star').steps[0]!.toolCalls.map((c) => (c.name === 'draw_svg' ? { ...c, input: { ...(c.input as object), svg: String((c.input as { svg: string }).svg).replace('</svg>', '<script>alert(1)</script></svg>') } } : c))
    await withServer([step(calls), say], async (base, _b, app) => {
      const r = await turn(base, 'Draw a big star in the middle of the table')
      // Break caught: the agent's draw_svg skipping the check the route uses.
      expect(r.calls[0]).toMatchObject({ name: 'draw_svg', ok: false })
      expect(r.calls[0].error).toMatch(/<script>/)
      expect(app.runtime.surfaces.list().some((s) => s.kind === 'drawing')).toBe(false)
    })
  })

  it('POST /api/surfaces/drawing goes through the same check', async () => {
    const svg = (recorded('draw-smiley').steps[0]!.toolCalls.find((c) => c.name === 'draw_svg')!.input as { svg: string }).svg
    await withServer([], async (base, _b, app) => {
      const post = (body: unknown) => fetch(`${base}/api/surfaces/drawing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const ok = await post({ svg, widthMm: 220, heightMm: 220 })
      expect(ok.status).toBe(200)
      expect(((await ok.json()) as { id: string }).id).toMatch(/^drawing-\d+$/)
      // Break caught: the route as a way around the tool's check.
      const bad = await post({ svg: svg.replace('</svg>', '<script>x()</script></svg>'), widthMm: 220, heightMm: 220 })
      expect(bad.status).toBe(400)
      expect(((await bad.json()) as { error: string }).error).toMatch(/<script>/)
      // Break caught: sizes the schema bounds (the table) let through.
      expect((await post({ svg, widthMm: 5000, heightMm: 220 })).status).toBe(400)
      expect(app.runtime.surfaces.list().filter((s) => s.kind === 'drawing')).toHaveLength(1)
    })
  })

  it('tells the agent where the camera sees objects, in table mm', async () => {
    await withServer([say], async (base, _b, app, model) => {
      // A look the camera made: the runtime's seen objects, in projector px.
      const mmPerPx = app.runtime.surfaces.bounds().mmPerPx
      ;(app.runtime as unknown as { seen: () => unknown[] }).seen = () => [{ id: 'cup', kind: 'cup', box: { x: 1000 / mmPerPx, y: 400 / mmPerPx, w: 85 / mmPerPx, h: 85 / mmPerPx } }]
      await turn(base, 'draw a circle around my cup')
      // Break caught: the agent blind to objects, so "around my cup" can't be placed.
      expect(systemOf(model, 0)).toMatch(/cup \(cup\) centre 1043,443 mm, 85×85 mm/)
    })
  })

  it('rejects a turn without text', async () => {
    await withServer([], async (base) => {
      expect((await fetch(`${base}/api/agent/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '  ' }) })).status).toBe(400)
    })
  })
})
