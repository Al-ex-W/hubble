import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { createBrain } from '@hubble/brain'
import { loadRecording } from '@hubble/stage/testing'
import type { RenderStreamLine, StageEvent, SurfacesLine, TableSurface } from '@hubble/stage'
import type { KeyboardSurfaceState, Pt } from '@hubble/stage/swipe'
import type { ServerConfig } from './config.ts'
import { createApp } from './index.ts'
import { createRuntime } from './runtime.ts'

/**
 * The swipe keyboard as a surface on the table (#29), end to end over HTTP:
 * open it, type on it with a real recorded hand, SEND, and the answer reaches
 * a display, through the real server, hub, runtime, surface manager, brain
 * (parser, layout report, verify) and the shared keyboard reducer.
 *
 * Fixtures:
 * - IMG_3537.strokes.json (label: recording): the hands lab's four pinch
 *   swipes over a printed keyboard, in keyboard mm. Mapped into table px
 *   through the opened keyboard's box (label: mechanical mutation: a scale
 *   and an offset, written out below independently of the server's inverse).
 * - math-pythagoras (label: recording) is the model's answer. Chosen by a
 *   probe (plan, Evidence): it verifies with no repair against an empty
 *   table plus the keyboard, so the test never depends on repair behaviour.
 * - The SEND key's centre (385, 154) mm is written out from the layout
 *   (send spans 7.5-10 keys of 44 mm on the 4th row; label: schema-derived).
 */
const config: ServerConfig = {
  port: 0,
  // Deliberately not 'aixia-labs' (the old hard-coded SEND model), so a test
  // can tell the configured default from a hard-code coming back.
  llm: { baseUrl: 'https://llm.invalid/v1', apiKey: 'sk-kb', model: 'aixia-code' },
  jevApiKey: undefined,
}
const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } as never
const ANSWER = loadRecording('math-pythagoras')
const REC = JSON.parse(readFileSync(new URL('../../packages/stage/src/swipe/fixtures/IMG_3537.strokes.json', import.meta.url), 'utf8')) as {
  meta: { label: string; truth: string }
  strokes: { points: Pt[] }[]
}
const SEND_MM = { x: 385, y: 154 }
// The widget's strip above the keys, and its physical size (440 × 256 mm):
// written out, not read from the code under test.
const KEYS_Y_MM = 80
const WIDGET_MM = { w: 440, h: 256 }
const MM_PER_PX = 1550 / 1920 // DEFAULT_SURFACE: the room's 1.55 m wide band on 1920 px (7 Oct)

/** Every user turn the model was shown, so history can be checked. */
const asked: string[] = []
/** The model name the brain was asked to use, per call. */
const models: string[] = []
const brain = createBrain({
  llm: config.llm as { baseUrl: string; apiKey: string; model: string },
  model: (name) =>
    (models.push(name), new MockLanguageModelV4({
      doGenerate: async (opts) => {
        asked.push(JSON.stringify(opts.prompt.filter((m) => m.role === 'user')))
        return { content: [{ type: 'text', text: ANSWER.text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
      },
    })),
})

type Line = RenderStreamLine | SurfacesLine
function display(base: string) {
  const lines: Line[] = []
  const ctl = new AbortController()
  const ready = fetch(`${base}/api/stage/events`, { signal: ctl.signal }).then((res) => {
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          buf += dec.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i)
            buf = buf.slice(i + 2)
            if (frame.startsWith('data: ')) lines.push(JSON.parse(frame.slice(6)))
          }
        }
      } catch {
        // aborted at the end of the test
      }
    })()
  })
  return { lines, ready, close: () => ctl.abort() }
}
const lastSet = (lines: Line[]) => lines.filter((l): l is SurfacesLine => l.kind === 'surfaces').at(-1)?.surfaces ?? []
const kbOf = (set: readonly TableSurface[]) => set.find((s) => s.kind === 'keyboard')
const mathBodies = (text: string) => [...text.matchAll(/<Math(?:\s[^>]*)?>([\s\S]*?)<\/Math>/g)].map((m) => m[1]!.trim())

/** Keyboard mm → table px through a keyboard box (the mechanical mutation of the recording). */
const toTable = (box: { x: number; y: number }, p: Pt) => ({ x: box.x + p.x / MM_PER_PX, y: box.y + (p.y + KEYS_Y_MM) / MM_PER_PX })

function server(withBrain: boolean) {
  const app = createApp(withBrain ? config : { ...config, llm: { ...config.llm, apiKey: '' } }, {
    brain: withBrain ? brain : undefined,
    runtime: (channels) => createRuntime({ ...channels, calibrationFile: '/nonexistent/kb.json' }),
  })
  const s = app.listen(0)
  return {
    app,
    s,
    ready: new Promise<string>((r) => s.once('listening', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`))),
  }
}

let srv: ReturnType<typeof server>
let base: string
beforeAll(async () => {
  srv = server(true)
  base = await srv.ready
})
afterAll(() => {
  srv.app.runtime.stop()
  srv.s.close()
})
const post = (path: string, body: unknown = {}, b = base) => fetch(`${b}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const stroke = async (points: Pt[], b = base) => (await (await post('/api/keyboard/stroke', { points }, b)).json()) as { hit: boolean; output: { kind: string }; state: KeyboardSurfaceState }

describe('the swipe keyboard on the table (server + hub over HTTP)', () => {
  it('opens as a keyboard surface of its physical size at bottom-centre, and every display gets it', async () => {
    const tv = display(base)
    await tv.ready
    expect((await post('/api/keyboard/open')).status).toBe(200)
    await vi.waitFor(() => expect(kbOf(lastSet(tv.lines))).toBeDefined(), { timeout: 2000 })
    const kb = kbOf(lastSet(tv.lines))!
    // Break caught: the keyboard drawn at a pixel size instead of its 44 mm
    // keys (AGENTS.md rule 5), or opened somewhere out of reach.
    const w = WIDGET_MM.w / MM_PER_PX
    const h = WIDGET_MM.h / MM_PER_PX
    expect(kb.box.w).toBeCloseTo(w, 6)
    expect(kb.box.h).toBeCloseTo(h, 6)
    expect(kb.box.x).toBeCloseTo((1920 - w) / 2, 6)
    expect(kb.box.y).toBeCloseTo(1200 - h - 40 / MM_PER_PX, 6)
    expect(kb.state).toEqual({ text: '', candidates: [], sent: null })
    tv.close()
  })

  it('types "my name is julie" from the recorded hand, sends it, and the answer renders on the table', async () => {
    expect(REC.meta.label).toBe('recording')
    expect(REC.strokes).toHaveLength(4) // corpus pin
    const tv = display(base)
    await tv.ready
    await post('/api/keyboard/open')
    const box = kbOf((await (await fetch(`${base}/api/surfaces`)).json() as SurfacesLine).surfaces)!.box
    let last: KeyboardSurfaceState | undefined
    for (const s of REC.strokes) {
      const r = await stroke(s.points.map((p) => toTable(box, p)))
      // Break caught: strokes converted with the wrong origin or scale, so
      // they miss the keyboard or decode as other words.
      expect(r.hit).toBe(true)
      expect(r.output.kind).toBe('word')
      last = r.state
    }
    expect(last!.text).toBe(REC.meta.truth)
    // Every display mirrors the draft: the state is on the surface itself.
    await vi.waitFor(() => expect((kbOf(lastSet(tv.lines))!.state as KeyboardSurfaceState).text).toBe(REC.meta.truth), { timeout: 2000 })

    const sent = await stroke([toTable(box, SEND_MM)])
    expect(sent.output).toEqual({ kind: 'sent', text: REC.meta.truth })
    // Break caught: the line keeping the message after send (sent twice), or
    // no send marker for displays to flash.
    expect(sent.state).toEqual({ text: '', candidates: [], sent: { n: 1, text: REC.meta.truth } })

    // The answer reaches the display like any other: start → pieces → done.
    await vi.waitFor(() => expect(tv.lines.some((l) => l.kind === 'done' && Boolean(l.answer))).toBe(true), { timeout: 5000 })
    const start = tv.lines.filter((l): l is Extract<RenderStreamLine, { kind: 'start' }> => l.kind === 'start').at(-1)!
    expect(start.intent).toBe(REC.meta.truth)
    // Break caught: the answer laid out without knowing where the keyboard
    // is (the probe in the plan shows a recorded panel landing 81% on it).
    expect(start.scene?.objects.find((o) => o.id === 'swipe-keyboard')?.box).toEqual(box)
    const evs = tv.lines.flatMap((l): StageEvent[] => (l.kind === 'event' && l.renderId === start.renderId ? [l.event] : []))
    const got = evs.filter((e): e is Extract<StageEvent, { type: 'piece' }> => e.type === 'piece' && e.tag === 'Math').map((e) => e.body.trim())
    expect(got).toEqual(mathBodies(ANSWER.text))
    expect(got.length).toBeGreaterThan(0)
    // The keyboard stays on the table beside the answer, ready for the next question.
    expect(kbOf(lastSet(tv.lines))).toBeDefined()
    expect(lastSet(tv.lines).some((s) => s.kind === 'answer')).toBe(true)
    tv.close()
  })

  it('a second question carries the answer on the table as history', async () => {
    await post('/api/keyboard/open')
    const box = (await (await fetch(`${base}/api/surfaces`)).json() as SurfacesLine).surfaces.find((s) => s.kind === 'keyboard')!.box
    const n = asked.length
    await stroke([toTable(box, { x: 22 + 2 * 44, y: 22 + 44 })]) // tap d (2nd row, 3rd key, half-key stagger)
    await stroke([toTable(box, SEND_MM)])
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(n), { timeout: 5000 })
    // Break caught: each typed question asked with no context, so "explain
    // step 2" can't know which answer it is about.
    expect(asked.at(-1)).toContain(REC.meta.truth)
    expect(asked.at(-1)).toContain('"d"')
    // Break caught: SEND naming its own model again (it hard-coded
    // 'aixia-labs' until 7 Oct), which made HUBBLE_LLM_MODEL a no-op here.
    expect(models.at(-1)).toBe('aixia-code')
  })

  it('a moved keyboard types where it is drawn; a stroke that starts off it is not typed', async () => {
    await post('/api/keyboard/close')
    await post('/api/keyboard/open')
    expect((await post('/api/surfaces/keyboard/move', { dx: -500, dy: -300 })).status).toBe(200)
    const box = (await (await fetch(`${base}/api/surfaces`)).json() as SurfacesLine).surfaces.find((s) => s.kind === 'keyboard')!.box
    // Break caught: opening an open keyboard (the bench's toggle, a second
    // tap on the launcher) throwing away where someone moved it.
    await post('/api/keyboard/open')
    expect((await (await fetch(`${base}/api/surfaces`)).json() as SurfacesLine).surfaces.find((s) => s.kind === 'keyboard')!.box).toEqual(box)
    const my = REC.strokes[0]!.points
    // Break caught: strokes mapped through where the keyboard opened instead
    // of where it is now.
    expect((await stroke(my.map((p) => toTable(box, p)))).state.text).toBe('my')
    // The same swipe, started 5 px left of the keyboard's edge (a swipe over
    // something else that crosses the keys).
    const off = my.map((p) => toTable(box, p))
    off[0] = { x: box.x - 5, y: off[0]!.y }
    const r = await stroke(off)
    expect(r.hit).toBe(false)
    expect(r.state.text).toBe('my')
  })

  it('close discards the draft; a stroke at a closed keyboard is a 409; bad strokes are refused', async () => {
    await post('/api/keyboard/close')
    expect((await post('/api/keyboard/stroke', { points: [{ x: 900, y: 900 }] })).status).toBe(409)
    await post('/api/keyboard/open')
    const set = (await (await fetch(`${base}/api/surfaces`)).json()) as SurfacesLine
    // Break caught: someone else's half-typed line reappearing on reopen.
    expect(set.surfaces.find((s) => s.kind === 'keyboard')!.state).toMatchObject({ text: '', candidates: [] })
    for (const body of [{}, { points: [] }, { points: [{ x: 'a', y: 1 }] }, { points: [{ x: 1 }] }, { points: [{ x: 1e9, y: 1 }] }, { points: Array.from({ length: 2001 }, () => ({ x: 1, y: 1 })) }]) {
      expect((await post('/api/keyboard/stroke', body)).status, JSON.stringify(body).slice(0, 40)).toBe(400)
    }
    expect((await post('/api/keyboard/open', { x: 'left' })).status).toBe(400)
  })
})

describe('the draft goes whenever the keyboard leaves the table (review #47)', () => {
  // Every path that can remove the keyboard surface. Before the fix only the
  // keyboard's own close route discarded the draft.
  const paths: [string, () => Promise<Response>][] = [
    ['its own close', () => post('/api/keyboard/close')],
    ['the generic surface close', () => post('/api/surfaces/keyboard/close')],
    ["the operator's close-all", () => post('/api/operator/close-all')],
    ["the operator's reset", () => post('/api/operator/reset')],
    ["the operator's switch to the keyboard act", () => post('/api/operator/act', { act: 'lesson' })],
  ]
  for (const [name, close] of paths) {
    it(`${name} discards it`, async () => {
      await post('/api/keyboard/open')
      const box = (await (await fetch(`${base}/api/surfaces`)).json() as SurfacesLine).surfaces.find((s) => s.kind === 'keyboard')!.box
      expect((await stroke(REC.strokes[0]!.points.map((p) => toTable(box, p)))).state.text).toBe('my')
      expect((await close()).status).toBe(200)
      expect((await (await fetch(`${base}/api/surfaces`)).json() as SurfacesLine).surfaces.some((s) => s.kind === 'keyboard')).toBe(false)
      await post('/api/keyboard/open')
      // Break caught: the next person finding (and possibly sending) the
      // last person's half-typed line.
      expect((await (await fetch(`${base}/api/surfaces`)).json() as SurfacesLine).surfaces.find((s) => s.kind === 'keyboard')!.state).toMatchObject({ text: '', candidates: [] })
      await post('/api/operator/act', { act: 'math' })
    })
  }
})

describe('every answer is laid out around the open keyboard (review #47)', () => {
  it('an ordinary question, not typed on the keyboard, carries the runtime\'s keyboard box, replacing a stale client copy', async () => {
    await post('/api/keyboard/close')
    await post('/api/keyboard/open', { x: 678.4, y: 90 })
    const box = (await (await fetch(`${base}/api/surfaces`)).json() as SurfacesLine).surfaces.find((s) => s.kind === 'keyboard')!.box
    const stale = { id: 'swipe-keyboard', kind: 'other', label: 'projected keyboard', box: { x: 1, y: 1, w: 10, h: 10 } }
    const lines = (await (await post('/api/render', { intent: 'explain step 2', scene: { surface: { widthPx: 1920, heightPx: 1080, mmPerPx: MM_PER_PX }, objects: [stale] } })).text()).trim().split('\n').map((l) => JSON.parse(l) as RenderStreamLine)
    const start = lines.find((l): l is Extract<RenderStreamLine, { kind: 'start' }> => l.kind === 'start')!
    // Break caught: the bench chat box, voice or "next" laying an answer
    // straight over the open keyboard (the review's reproduction overlapped
    // it by 184,549 px²), or the client's old box winning over the runtime's.
    expect(start.scene!.objects.filter((o) => o.id === 'swipe-keyboard').map((o) => o.box)).toEqual([box])
    await post('/api/keyboard/close')
  })
})

describe('the bench sends its own chat turn (ask: false)', () => {
  it('SEND clears the line and counts the send, but asks no model', async () => {
    await post('/api/keyboard/close')
    await post('/api/keyboard/open')
    const box = (await (await fetch(`${base}/api/surfaces`)).json() as SurfacesLine).surfaces.find((s) => s.kind === 'keyboard')!.box
    await stroke(REC.strokes[0]!.points.map((p) => toTable(box, p)))
    const n = asked.length
    const r = (await (await post('/api/keyboard/stroke', { points: [toTable(box, SEND_MM)], ask: false })).json()) as { output: unknown; state: KeyboardSurfaceState }
    expect(r.output).toEqual({ kind: 'sent', text: 'my' })
    expect(r.state).toMatchObject({ text: '', sent: { text: 'my' } })
    // Break caught: the question asked twice (once by the runtime, once by
    // the bench's own chat turn): two answers racing for the table.
    await new Promise((res) => setTimeout(res, 50))
    expect(asked.length).toBe(n)
    expect((await post('/api/keyboard/stroke', { points: [toTable(box, SEND_MM)], ask: 'no' })).status).toBe(400)
  })
})

describe('the swipe keyboard with no model configured', () => {
  it('keeps the typed line instead of dropping it on SEND', async () => {
    const off = server(false)
    const b = await off.ready
    try {
      await post('/api/keyboard/open', {}, b)
      const box = (await (await fetch(`${b}/api/surfaces`)).json() as SurfacesLine).surfaces.find((s) => s.kind === 'keyboard')!.box
      await stroke(REC.strokes[0]!.points.map((p) => toTable(box, p)), b)
      const r = await stroke([toTable(box, SEND_MM)], b)
      // Break caught: SEND clearing the line with nothing to answer it
      // (the words would be lost), or flashing a send that never happened.
      expect(r.state).toEqual({ text: 'my', candidates: [], sent: null })
    } finally {
      off.app.runtime.stop()
      off.s.close()
    }
  })
})
