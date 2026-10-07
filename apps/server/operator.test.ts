import type { AddressInfo } from 'node:net'
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { createBrain } from '@hubble/brain'
import { createLiveRoom, type Room } from '@hubble/room'
import { loadRecording } from '@hubble/stage/testing'
import type { OverlayLine, RenderStreamLine, StageEvent, SurfacesLine } from '@hubble/stage'
import { startEmulator } from '../room-emulator/index.ts'
import type { ServerConfig } from './config.ts'
import { createApp } from './index.ts'
import { createRuntime } from './runtime.ts'

/**
 * The operator panel's buttons, each over real HTTP against the real server
 * and the spec room emulator (ports 0), the way the page will press them.
 *
 * The server here has NO model configured: the fallback's whole point is
 * that it works when the uplink doesn't, so that is the honest setting.
 *
 * Fixtures: the replayed answer is `scene-linear-left` (label: recording);
 * oracles are regexes over its text. Lesson notes are written out by hand
 * (Ode to Joy opens on E4 = 64; label: schema-derived).
 */
const config: ServerConfig = {
  port: 0,
  llm: { baseUrl: 'https://llm.invalid/v1', apiKey: '', model: 'aixia-labs' },
  jevApiKey: undefined,
}
const LINEAR = loadRecording('scene-linear-left')
const GRAPH = loadRecording('scene-quadratic-graph')
const mathBodies = (text: string) => [...text.matchAll(/<Math(?:\s[^>]*)?>([\s\S]*?)<\/Math>/g)].map((m) => m[1].trim())

/** A /table display: every SSE line, parsed. (Same reader as the demo smoke's.) */
function display(base: string) {
  const lines: (RenderStreamLine | OverlayLine | SurfacesLine)[] = []
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

let emu: Awaited<ReturnType<typeof startEmulator>>
let room: Room
let server: Server
let base: string
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  emu = await startEmulator(0)
  room = createLiveRoom({ base: emu.url, token: emu.token, kind: 'emulator' })
  app = createApp(config, {
    room,
    runtime: (channels) => createRuntime({ ...channels, room, team: emu.team, publicBase: 'http://op.test:5173', calibrationFile: '/nonexistent/op-calibration.json', autoTick: false }),
  })
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

const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const status = async () => (await (await fetch(`${base}/api/operator/status`)).json()) as {
  act: string
  mode: string
  lesson: { index: number } | null
  room: { ok: boolean; kind: string; displays?: number }
  camera: { calibrated: boolean; source?: 'measured' | 'standard' | null; at?: string | null }
  midi: { lastAt: number | null }
  brain: { configured: boolean; lastRender: { ok: boolean; ms: number } | null }
}
type Line = RenderStreamLine | OverlayLine | SurfacesLine
const lastSurfaces = (lines: Line[]) => lines.filter((l): l is SurfacesLine => l.kind === 'surfaces').at(-1)
const keybed = { corners: [{ x: 600, y: 1000 }, { x: 1500, y: 1000 }, { x: 1500, y: 880 }, { x: 600, y: 880 }], lowestNote: 48 }
// The lit key only: the next-key ring (#120, #becaff) is drawn on the same layer.
const lessonLayer = (lines: Line[]) => {
  const l = lines.filter((x): x is OverlayLine => x.kind === 'overlay' && x.layer === 'lesson').at(-1)
  return l && { ...l, shapes: l.shapes.filter((x) => x.color !== '#becaff') }
}
const lastStart = (lines: Line[]) => lines.filter((l) => l.kind === 'start').at(-1) as Extract<RenderStreamLine, { kind: 'start' }> | undefined
const eventsOf = (lines: Line[], renderId: string): StageEvent[] =>
  lines.flatMap((l) => (l.kind === 'event' && l.renderId === renderId ? [l.event] : []))

describe('operator panel (server + emulator over HTTP)', () => {
  it('status: room reachable, no model, nothing pressed yet', async () => {
    const s = await status()
    // Break caught: the room tile lying (green with no room, or red with one).
    expect(s.room).toMatchObject({ ok: true, kind: 'emulator', displays: 3 })
    expect(s.brain).toEqual({ configured: false, lastRender: null })
    expect(s.midi.lastAt).toBeNull()
    // Break caught: pretending a missing measured file means uncalibrated.
    // Since #85 the runtime boots calibrated from the committed standard
    // (the 7 Oct recording) when `.hubble/calibration.json` is absent, and
    // says so, rather than leaving the room on no map at all.
    expect(s.camera.calibrated).toBe(true)
    expect(s.camera.source).toBe('standard')
    expect(s.act).toBe('math')
  })

  it('fallback: a recorded answer reaches the table with no model at all, and the status records it', async () => {
    const tv = display(base)
    await tv.ready
    const res = await post('/api/operator/fallback', { answer: 'linear' })
    expect(res.status).toBe(202)
    await vi.waitFor(() => expect(tv.lines.some((l) => l.kind === 'done')).toBe(true), { timeout: 3000 })
    const start = lastStart(tv.lines)!
    // The table adopts a render on its start line, with the scene it was verified on.
    expect(start.scene?.objects.map((o) => o.id)).toEqual(LINEAR.scene!.objects.map((o) => o.id))
    const evs = eventsOf(tv.lines, start.renderId)
    // Break caught: the replay not reaching displays, or losing pieces on the way.
    expect(evs.filter((e) => e.type === 'piece' && e.tag === 'Math').map((e) => (e as { body: string }).body.trim())).toEqual(mathBodies(LINEAR.text))
    expect(mathBodies(LINEAR.text)).toHaveLength(4) // corpus pin
    expect(evs.at(-1)).toEqual({ type: 'end', reason: 'complete' })
    // Break caught: a fallback that bypasses the runtime (lights and status
    // would still say the table is idle).
    const s = await status()
    expect(s.mode).toBe('answering')
    expect(s.brain.lastRender).toMatchObject({ ok: true })
    tv.close()
  })

  it('refuses a fallback name that is not on the list (no file names from the room network)', async () => {
    for (const answer of ['../../../etc/passwd', 'scene-linear-left', 'constructor', '']) {
      // Break caught: the name used as a file path, or prototype keys passing the check.
      expect((await post('/api/operator/fallback', { answer })).status, answer).toBe(400)
    }
  })

  it('keyboard act: the answer leaves the table and only the next key is lit', async () => {
    const tv = display(base)
    await tv.ready
    await post('/api/lesson/keybed', keybed)
    const res = await post('/api/operator/act', { act: 'lesson' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { act: string }).act).toBe('lesson')
    await vi.waitFor(() => {
      // Break caught: the math answer staying up under the lesson (owner: key highlights only).
      const start = lastStart(tv.lines)!
      expect(start.renderId.startsWith('dismiss-')).toBe(true)
      expect(eventsOf(tv.lines, start.renderId)).toEqual([])
      const layer = lessonLayer(tv.lines)!
      expect(layer.shapes).toHaveLength(1)
      expect(layer.shapes[0]!.color).toBe('#36ff7a')
    }, { timeout: 2000 })
    // E4 is the 10th white key from C3: x 1140..1200 on this 60 px grid.
    const xs = lessonLayer(tv.lines)!.shapes[0]!.points.map((p) => Math.round(p.x))
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([1140, 1200])

    // A key press shows up in the status's MIDI tile.
    await post('/api/input/midi', { type: 'note-on', note: 64, velocity: 90 })
    const s = await status()
    // Break caught: the MIDI tile never updating (operator can't tell a dead keyboard).
    expect(s.midi.lastAt).not.toBeNull()
    expect(s.lesson?.index).toBe(1)
    tv.close()
  })

  it('close-all clears the answer but keeps the act; reset clears everything', async () => {
    const tv = display(base)
    await tv.ready
    await post('/api/operator/act', { act: 'lesson', song: 'twinkle' })
    await post('/api/operator/fallback', { answer: 'graph' })
    await vi.waitFor(() => expect(tv.lines.some((l) => l.kind === 'done' && l.renderId.startsWith('replay-'))).toBe(true), { timeout: 3000 })
    expect(lastSurfaces(tv.lines)!.surfaces.map((x) => x.id)).toEqual(['answer'])
    // Break caught (review #40 surviving mutant): a graph fallback that
    // reaches the table blank. Oracle: a regex over the recording's text.
    const graphId = lastStart(tv.lines)!.renderId
    const plots = (GRAPH.text.match(/<Plot[\s>]/g) ?? []).length
    expect(plots).toBe(1) // corpus pin
    expect(eventsOf(tv.lines, graphId).filter((e) => e.type === 'piece' && e.tag === 'Plot')).toHaveLength(plots)
    expect(eventsOf(tv.lines, graphId).filter((e) => e.type === 'piece' && e.tag === 'Math')).toHaveLength(mathBodies(GRAPH.text).length)

    const closed = (await (await post('/api/operator/close-all')).json()) as { act: string }
    expect(closed.act).toBe('lesson')
    await vi.waitFor(() => expect(lastStart(tv.lines)!.renderId.startsWith('dismiss-')).toBe(true), { timeout: 2000 })
    // Break caught: close-all clearing the hub but not the surface manager
    // (a window left in the list for a hand to hit, the pre-#38 dismiss).
    await vi.waitFor(() => expect(lastSurfaces(tv.lines)!.surfaces).toEqual([]), { timeout: 2000 })
    // One owner dismissed, once: counted after the replayed answer's done
    // (earlier dismisses are the act switch and the snapshot on connect).
    const afterReplay = tv.lines.slice(tv.lines.findIndex((l) => l.kind === 'done' && l.renderId.startsWith('replay-')))
    expect(afterReplay.filter((l) => l.kind === 'start' && l.renderId.startsWith('dismiss-'))).toHaveLength(1)
    // Break caught: close-all ending the lesson (its lit key is the act, not a surface).
    expect(lessonLayer(tv.lines)!.shapes).toHaveLength(1)

    const reset = (await (await post('/api/operator/reset')).json()) as { act: string; mode: string; lesson: unknown }
    // Break caught: reset leaving the lesson running or the lights in "answering".
    expect(reset).toMatchObject({ act: 'math', mode: 'idle', lesson: null })
    await vi.waitFor(() => expect(lessonLayer(tv.lines)!.shapes).toHaveLength(0), { timeout: 2000 })
    tv.close()
  })

  it('math act stops the lesson; bad acts and songs are refused', async () => {
    await post('/api/operator/act', { act: 'lesson' })
    expect(((await (await post('/api/operator/act', { act: 'math' })).json()) as { act: string; lesson: unknown })).toMatchObject({ act: 'math', lesson: null })
    // Break caught (review #40 surviving mutant): MIDI health counted only
    // during a lesson, so a live keyboard looks dead all through the math act.
    const before = (await status()).midi.lastAt ?? 0
    await new Promise((r) => setTimeout(r, 5))
    await post('/api/input/midi', { type: 'note-on', note: 60, velocity: 90 })
    expect((await status()).midi.lastAt).toBeGreaterThan(before)
    expect((await post('/api/operator/act', { act: 'disco' })).status).toBe(400)
    expect((await post('/api/operator/act', { act: 'lesson', song: 'nope' })).status).toBe(404)
  })

  it('inherited names are not songs, on either route, and the status poll survives them', async () => {
    const tv = display(base)
    await tv.ready
    await post('/api/operator/fallback', { answer: 'linear' })
    await vi.waitFor(() => expect(lastStart(tv.lines)?.renderId.startsWith('replay-')).toBe(true), { timeout: 3000 })
    for (const song of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      // Break caught (review #40, finding 1): a plain lookup accepting
      // Object.prototype keys; the next status poll then crashed the server.
      expect((await post('/api/operator/act', { act: 'lesson', song })).status, song).toBe(404)
      expect((await post('/api/lesson/start', { song })).status, song).toBe(404)
      expect((await fetch(`${base}/api/operator/status`)).status).toBe(200)
    }
    // Break caught: the table cleared before the song was refused.
    expect(lastStart(tv.lines)!.renderId.startsWith('replay-')).toBe(true)
    expect((await status()).act).toBe('math')
    tv.close()
  })
})

describe('switching act while an answer is still being written', () => {
  it('settles the mode to idle instead of leaving the lights on thinking', async () => {
    // A model that never answers until aborted (label: schema-derived, the
    // same hanging mock as index.test.ts): the render stays mid-flight.
    let aborted = false
    const hanging = createBrain({
      llm: config.llm as { baseUrl: string; apiKey: string; model: string },
      model: () =>
        new MockLanguageModelV4({
          doGenerate: (opts) =>
            new Promise((_, reject) =>
              opts.abortSignal?.addEventListener('abort', () => {
                aborted = true
                reject(opts.abortSignal!.reason)
              }),
            ),
        }),
    })
    const a = createApp(config, { brain: hanging, runtime: (channels) => createRuntime({ ...channels, calibrationFile: '/nonexistent/op.json' }) })
    const s = a.listen(0)
    await new Promise((r) => s.once('listening', r))
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
    const ctl = new AbortController()
    try {
      const res = await fetch(`${b}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intent: 'x' }), signal: ctl.signal })
      await res.body!.getReader().read() // the start line: the model is now running
      const st = async () => (await (await fetch(`${b}/api/operator/status`)).json()) as { mode: string; act: string; brain: { lastRender: unknown } }
      expect((await st()).mode).toBe('thinking')
      await fetch(`${b}/api/operator/act`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ act: 'lesson' }) })
      await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 2000 })
      // Break caught (review #40, finding 4): the aborted render never sends
      // done, so nothing left "thinking" (status and lights stuck on it).
      const after = await st()
      expect(after).toMatchObject({ mode: 'idle', act: 'lesson' })
      // Neither a success nor a failure: health doesn't count it.
      expect(after.brain.lastRender).toBeNull()
    } finally {
      ctl.abort()
      a.runtime.stop()
      s.close()
    }
  })
})

describe('operator status with a dead room', () => {
  let hang: TcpServer
  afterAll(() => hang?.close())

  it('answers within the deadline and says the room is down', async () => {
    // A room that accepts the connection and never answers: the worst case,
    // worse than a refused port, because nothing ever errors on its own.
    hang = createTcpServer(() => {}).listen(0)
    await new Promise((r) => hang.once('listening', r))
    const dead = createLiveRoom({ base: `http://127.0.0.1:${(hang.address() as AddressInfo).port}`, token: 't', kind: 'live' })
    const a = createApp(config, { room: dead, runtime: (channels) => createRuntime({ ...channels, calibrationFile: '/nonexistent/op.json' }) })
    const s = a.listen(0)
    await new Promise((r) => s.once('listening', r))
    try {
      const t0 = Date.now()
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/operator/status`)
      const body = (await res.json()) as { room: { ok: boolean; error?: string } }
      // Break caught: the status route waiting on a hung room (the operator page freezes mid-show).
      expect(Date.now() - t0).toBeLessThan(3000)
      expect(body.room.ok).toBe(false)
      expect(body.room.error).toMatch(/no answer/)
    } finally {
      s.close()
      dead.close()
    }
  })
})
