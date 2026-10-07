import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { createBrain } from '@hubble/brain'
import { createLiveRoom, MOODS, type Room } from '@hubble/room'
import { loadRecording } from '@hubble/stage/testing'
import type { OverlayLine, RenderStreamLine, StageEvent } from '@hubble/stage'
import { startEmulator } from '../room-emulator/index.ts'
import type { ServerConfig } from './config.ts'
import { createApp } from './index.ts'
import { createRuntime } from './runtime.ts'

/**
 * THE DEMO SMOKE (#25): `npm run demo:smoke`, the loop's merge gate.
 *
 * Why one file that runs both acts against one server, instead of more unit
 * tests: every piece below already has unit tests, and the demo can still
 * break between them (a hub that stops replaying, a runtime route that stops
 * reaching the overlay, an act that only works on a fresh server). This runs
 * the demo's own order on the real wiring: server + brain + hub + runtime +
 * room client + spec emulator, all on port 0, no network, no hardware, no key.
 *
 * What is stubbed, and why it is the honest seam: only the model. The brain's
 * `generateText` gets a recorded aixia-labs answer (label: recording), so the
 * real parser, layout report and verify loop run on what the model really
 * wrote. The recordings chosen verify on the first draft (probe in the plan),
 * so the smoke never depends on repair-model behaviour.
 *
 * Oracles are independent of the code under test: regexes over the
 * recording's text for what the table must show, the Ode to Joy melody
 * written out by hand, and plain white-key arithmetic for where a key is.
 */

const config: ServerConfig = {
  port: 0,
  llm: { baseUrl: 'https://llm.invalid/v1', apiKey: 'sk-smoke', model: 'aixia-labs' },
  jevApiKey: undefined,
}
const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } as never

// Act 1's answers. The presenter asks twice: the notebook's linear equation
// (Math beside the notebook), then a graph (Equations + Plot, the heaviest
// components the table draws).
const LINEAR = loadRecording('scene-linear-left')
const GRAPH = loadRecording('scene-quadratic-graph')
// Each request's intent picks its recording, so the stub stays a pure replay
// whatever order or number of model calls the brain makes.
const BY_INTENT: Record<string, string> = { 'solve the task in my notebook': LINEAR.text, 'graph it': GRAPH.text }

const brain = createBrain({
  llm: config.llm as { baseUrl: string; apiKey: string; model: string },
  model: () =>
    new MockLanguageModelV4({
      doGenerate: async (opts) => {
        // Only the user turns: the system prompt's own worked example quotes
        // "solve the task in my notebook", which would match every request.
        const asked = JSON.stringify(opts.prompt.filter((m) => m.role === 'user'))
        const intent = Object.keys(BY_INTENT).find((i) => asked.includes(i))
        if (!intent) throw new Error('smoke: no recording for this prompt')
        return { content: [{ type: 'text', text: BY_INTENT[intent] }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
      },
    }),
})

/** A display on /api/stage/events: what a /table page would receive, parsed. */
function display(base: string) {
  const lines: (RenderStreamLine | OverlayLine)[] = []
  const ctl = new AbortController()
  const ready = fetch(`${base}/api/stage/events`, { signal: ctl.signal }).then(async (res) => {
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

/** The emulator's own view of the room (its bench channel sends the state on connect). */
async function emulatorState(url: string): Promise<{ displays: Record<string, unknown>; lights: Record<string, { color?: string; bri?: number }> }> {
  const res = await fetch(`${url}/emulator/state`)
  const reader = res.body!.getReader()
  const { value } = await reader.read()
  await reader.cancel()
  // Only the first event: under load the emulator's next state (a light the
  // player just sent) can arrive in the same chunk, and parsing both as one
  // JSON failed the gate with "Unexpected non-whitespace character" (seen
  // 7 Oct with two vitest runs in parallel).
  const first = new TextDecoder().decode(value).split('\n\n')[0]
  return JSON.parse(first.replace(/^data: /, '').trim())
}

const events = (lines: (RenderStreamLine | OverlayLine)[], renderId: string): StageEvent[] =>
  lines.flatMap((l) => (l.kind === 'event' && l.renderId === renderId ? [l.event] : []))
const pieces = (evs: StageEvent[], tag: string) => evs.filter((e): e is Extract<StageEvent, { type: 'piece' }> => e.type === 'piece' && e.tag === tag)
const opens = (evs: StageEvent[], tag: string) => evs.filter((e) => e.type === 'open' && e.tag === tag)
// Independent oracle: what the recording's text says the table must show.
const bodies = (text: string, tag: string) => [...text.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1].trim())
const count = (text: string, tag: string) => text.match(new RegExp(`<${tag}[\\s>/]`, 'g'))?.length ?? 0
// Corpus pins, counted from the recordings' JSONL by the PR #37 reviewer
// (regexes over the joined content deltas): a fixture that loses content
// must fail here, not shrink the oracle and pass on less.
const PINNED = {
  'scene-linear-left': { Panel: 1, Math: 4, Equations: 0, Plot: 0 },
  'scene-quadratic-graph': { Panel: 2, Math: 3, Equations: 1, Plot: 1 },
} as const
type Rec = typeof LINEAR

/**
 * One render as one display received it, checked against the recording.
 *
 * Shaped by what /table actually does (apps/web/src/table/tableState.ts): a
 * display adopts a render only on its `start` line and ignores lines of any
 * other renderId, so a stream that delivers every event but loses `start`
 * leaves the real table blank. Hence the checks on the frame (start first,
 * with the scene; done last), not only on the events in between.
 */
function expectWhole(lines: (RenderStreamLine | OverlayLine)[], renderId: string, rec: Rec) {
  const mine = lines.filter((l): l is RenderStreamLine => l.kind !== 'overlay' && l.kind !== 'raw' && l.kind !== 'trace' && l.renderId === renderId)
  // Break caught: the hub dropping or reordering `start` (table never adopts the render).
  expect(mine[0]).toMatchObject({ kind: 'start', renderId })
  expect((mine[0] as Extract<RenderStreamLine, { kind: 'start' }>).scene?.objects.map((o) => o.id)).toEqual(rec.scene!.objects.map((o) => o.id))
  expect(mine.at(-1)).toMatchObject({ kind: 'done', renderId })
  const evs = events(lines, renderId)
  const pin = PINNED[rec.name as keyof typeof PINNED]
  for (const tag of ['Panel', 'Math', 'Equations', 'Plot'] as const) expect(count(rec.text, tag), `${rec.name} ${tag} pin`).toBe(pin[tag])
  // Break caught: pieces lost between the brain and the displays — every Math
  // and Equations body the model wrote, in order, and every Panel and Plot.
  expect(pieces(evs, 'Math').map((p) => p.body.trim())).toEqual(bodies(rec.text, 'Math'))
  expect(pieces(evs, 'Equations').map((p) => p.body.trim())).toEqual(bodies(rec.text, 'Equations'))
  expect(opens(evs, 'Panel')).toHaveLength(pin.Panel)
  expect(pieces(evs, 'Plot')).toHaveLength(pin.Plot)
  expect(evs.filter((e) => e.type === 'drop')).toEqual([])
  expect(evs.at(-1)).toEqual({ type: 'end', reason: 'complete' })
}

let emu: Awaited<ReturnType<typeof startEmulator>>
let room: Room
let server: Server
let base: string
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  emu = await startEmulator(0)
  room = createLiveRoom({ base: emu.url, token: emu.token, kind: 'emulator' })
  // The runtime exactly as index.ts builds it for ROOM=emulator, except the
  // public base (a fixed host, so the display URL is an exact oracle) and
  // no calibration file (the main checkout's .hubble/ must not leak in).
  app = createApp(config, {
    brain,
    room,
    runtime: (channels) => createRuntime({ ...channels, room, team: emu.team, publicBase: 'http://smoke.test:5173', calibrationFile: '/nonexistent/smoke-calibration.json' }),
  })
  // As index.ts starts it: the table only (the voice orb that TV 1 showed left
  // main on 7 Oct, branch archive/voice-orb).
  await app.runtime.start({ table: 'table' })
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  app?.runtime.stop()
  server?.close()
  room?.close()
  emu?.close()
})

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const render = async (intent: string, scene: unknown) => {
  const res = await post('/api/render', { intent, scene })
  expect(res.status).toBe(200)
  return (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as RenderStreamLine)
}

describe('demo smoke', () => {
  it('room: the table shows our page and the lights settle on idle', async () => {
    const state = await emulatorState(emu.url)
    // Break caught: the runtime no longer pointing the projector at /table
    // (the Pi would show the room's idle page all demo).
    expect(state.displays.table).toEqual({ type: 'url', url: 'http://smoke.test:5173/table' })
    // Before anyone asks, every room light shows the idle mood (≤ 8 commands/s
    // through the light player, so 10 lights take about 1.3 s).
    await vi.waitFor(
      async () => {
        const { lights } = await emulatorState(emu.url)
        const ids = Object.keys(lights).filter((k) => k !== '__scene')
        expect(ids).toHaveLength(10)
        // Break caught: the runtime never applying its mood to the room.
        for (const id of ids) expect(lights[id]).toMatchObject({ color: MOODS.idle.color })
      },
      { timeout: 5000, interval: 100 },
    )
  })

  it('act 1, math: the recorded answers reach every display whole, the late one by replay', async () => {
    const live = display(base)
    await live.ready

    const first = await render('solve the task in my notebook', LINEAR.scene)
    const id1 = first[0].renderId
    expect(first.at(-1)).toMatchObject({ kind: 'done' })
    // Break caught: an answer that never verified (the table would show the
    // failure notice instead of the worked math).
    expect(first.some((l) => l.kind === 'error')).toBe(false)
    await vi.waitFor(() => expect(live.lines.some((l) => l.kind === 'done' && l.renderId === id1)).toBe(true), { timeout: 5000 })
    expectWhole(live.lines, id1, LINEAR)

    // Lights follow the act: thinking, then answering, on every room light.
    await vi.waitFor(
      async () => {
        const { lights } = await emulatorState(emu.url)
        const ids = Object.keys(lights).filter((k) => k !== '__scene')
        expect(ids).toHaveLength(10)
        // Break caught: the runtime's mood never reaching the room's Hue lights.
        for (const id of ids) expect(lights[id]).toMatchObject({ color: MOODS.answering.color })
      },
      { timeout: 5000, interval: 100 },
    )

    // The presenter asks again; latest wins.
    const second = await render('graph it', GRAPH.scene)
    const id2 = second[0].renderId
    expect(second.some((l) => l.kind === 'error')).toBe(false)
    await vi.waitFor(() => expect(live.lines.some((l) => l.kind === 'done' && l.renderId === id2)).toBe(true), { timeout: 5000 })
    expectWhole(live.lines, id2, GRAPH)

    // A display that joins now (the Pi reloading after a slot reset) must
    // land on the current answer, not a blank table.
    const late = display(base)
    await late.ready
    await vi.waitFor(() => expect(late.lines.some((l) => l.kind === 'done' && l.renderId === id2)).toBe(true), { timeout: 5000 })
    // Break caught: the hub's snapshot replay dropped (late displays blank),
    // or replaying a different frame than the live display saw.
    expectWhole(late.lines, id2, GRAPH)
    expect(events(late.lines, id2)).toEqual(events(live.lines, id2))
    // Break caught: a replay that resurrects the superseded answer too.
    expect(late.lines.some((l) => l.kind !== 'overlay' && l.renderId === id1)).toBe(false)
    live.close()
    late.close()
  })

  it('act 2, lesson: next key green, wrong key red without advancing, right keys advance', async () => {
    // An axis-aligned keybed: near edge y=1000, far edge y=880, x 600..1500,
    // so each of the MiniLab's 15 white keys is exactly 60 px wide and the
    // oracle is plain arithmetic, not keyQuads.
    const corners = [{ x: 600, y: 1000 }, { x: 1500, y: 1000 }, { x: 1500, y: 880 }, { x: 600, y: 880 }]
    const LOWEST = 48 // C3, the MiniLab's lowest key at octave 0
    const WHITE_PC = [0, 2, 4, 5, 7, 9, 11]
    const whiteIndex = (note: number) => {
      let n = 0
      for (let m = LOWEST; m < note; m++) if (WHITE_PC.includes(m % 12)) n++
      return n
    }
    // Every note in this check is a white key: a 60 px column of the full
    // keybed depth (y 880..1000).
    const key = (color: string, note: number) => `${color} x${600 + whiteIndex(note) * 60}-${660 + whiteIndex(note) * 60} y880-1000`
    const box = (color: string, pts: { x: number; y: number }[]) => {
      const xs = pts.map((p) => Math.round(p.x))
      const ys = pts.map((p) => Math.round(p.y))
      return `${color} x${Math.min(...xs)}-${Math.max(...xs)} y${Math.min(...ys)}-${Math.max(...ys)}${pts.length === 4 ? '' : ` (${pts.length} corners)`}`
    }
    // Ode to Joy, written out: E4 E4 F4 G4 …, and D4 as the wrong key.
    const [E4, F4, G4, D4] = [64, 65, 67, 62]
    const [GREEN, RED, NEXT] = ['#36ff7a', '#ff3b3b', '#becaff']
    // The next key's marker: a ring over the whole key (10 points: outer
    // quad, bridge, inner quad), so its bounding box is the key's; on a
    // repeated note a 4-corner dot in the key's middle 30 %.
    const ring = (note: number) => `${key(NEXT, note)} (10 corners)`
    const dot = (note: number) => {
      const x0 = 600 + whiteIndex(note) * 60
      return `${NEXT} x${x0 + 21}-${x0 + 39} y922-958`
    }

    const tv = display(base)
    await tv.ready
    const lesson = () => tv.lines.filter((l): l is OverlayLine => l.kind === 'overlay' && l.layer === 'lesson')
    // Every shape of the latest lesson line, as its colour and bounding box,
    // sorted: a duplicate or a shape off the keybed shows up as a difference.
    const lit = () => (lesson().at(-1)?.shapes ?? []).map((s) => box(s.color, s.points)).sort()

    expect((await post('/api/lesson/keybed', { corners, lowestNote: LOWEST })).status).toBe(200)
    const started = await post('/api/lesson/start', { song: 'ode-to-joy' })
    expect(started.status).toBe(200)
    expect((await started.json()).act).toBe('lesson')
    await vi.waitFor(() => expect(lit()).toEqual([key(GREEN, E4), dot(E4)].sort()), { timeout: 2000 })

    const midi = async (note: number) => (await (await post('/api/input/midi', { type: 'note-on', note, velocity: 90 })).json()) as { result: { kind: string }; state: { lesson: { index: number } } }

    const wrong = await midi(D4)
    expect(wrong.result.kind).toBe('wrong')
    // Break caught: a wrong key advancing the lesson.
    expect(wrong.state.lesson.index).toBe(0)
    // Break caught: no red flash, the green moving off the expected key, or
    // light landing anywhere but on the key itself (both axes are checked).
    await vi.waitFor(() => expect(lit()).toEqual([key(GREEN, E4), dot(E4), key(RED, D4)].sort()), { timeout: 2000 })
    // Break caught: the red flash lingering (a learner reads a lit red key as
    // "still wrong"). The runtime clears it after 450 ms.
    await vi.waitFor(() => expect(lit()).toEqual([key(GREEN, E4), dot(E4)].sort()), { timeout: 2000, interval: 50 })

    expect((await midi(E4)).state.lesson.index).toBe(1)
    // The repeated E is a second press, not a copy of the first: the
    // runtime drops the same note again within 150 ms as a duplicate
    // (runtime.ts DUPLICATE_NOTE_MS), so wait as a real player would.
    await new Promise((r) => setTimeout(r, 200))
    const third = await midi(E4)
    // Break caught: the lesson not advancing on the right key.
    expect(third.state.lesson.index).toBe(2)
    // Break caught: no "next" ring, or the ring on the current key instead of
    // the one after it (Ode to Joy: F4 now, G4 next).
    await vi.waitFor(() => expect(lit()).toEqual([key(GREEN, F4), ring(G4)].sort()), { timeout: 2000 })
    expect((await midi(F4)).state.lesson.index).toBe(3)
    await vi.waitFor(() => expect(lit()).toEqual([key(GREEN, G4), dot(G4)].sort()), { timeout: 2000 })

    // The lesson's light lives in its own layer: the math answer is still on
    // the table, so a display joining now gets both.
    const joining = display(base)
    await joining.ready
    await vi.waitFor(() => {
      expect(joining.lines.some((l) => l.kind === 'overlay' && l.layer === 'lesson' && l.shapes.length === 2)).toBe(true)
      expect(joining.lines.some((l) => l.kind === 'done')).toBe(true)
    }, { timeout: 2000 })

    await post('/api/lesson/stop', {})
    await vi.waitFor(() => expect(lit()).toEqual([]), { timeout: 2000 })
    tv.close()
    joining.close()
  })
})
