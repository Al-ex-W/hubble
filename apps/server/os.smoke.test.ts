import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { createBrain } from '@hubble/brain'
import { apply, createLiveRoom, type H, type Room } from '@hubble/room'
import { hitTest, type OverlayLine, type RenderStreamLine, type StageEvent, type SurfacesLine, type TableSurface } from '@hubble/stage'
import { buildLayout, KEY_MM, type KeyboardSurfaceState, type Pt } from '@hubble/stage/swipe'
import { loadRecording } from '@hubble/stage/testing'
import { startEmulator } from '../room-emulator/index.ts'
import { fromPrintout, keyboardToTable } from '../web/src/hands/calibration.ts'
import { createHandPipeline } from '../web/src/hands/pipeline.ts'
import { createGesturePoster } from '../web/src/hands/gesturePoster.ts'
import type { Frame, Hand, Trace } from '../web/src/hands/types.ts'
import { createTableKeyboardClient, keyboardAtMm } from '../web/src/swipe/tableKeyboard.ts'
import type { ServerConfig } from './config.ts'
import { createApp } from './index.ts'
import { createKeybedClient } from './keybed.ts'
import { createRuntime } from './runtime.ts'
import { hasKeybedPython, loadKeybedFixtures, pts, startKeybedSidecar } from './testing/keybed.ts'

/**
 * THE OS SMOKE (#50): `npm run os:smoke`. One run of the projection OS the
 * way the demo drives it, hand to table, through the real product path.
 *
 * Why one long run and not more unit tests: every piece has its own tests,
 * and the demo can still break between them (a keyboard that types but
 * whose SEND never becomes a question, an answer laid over the keys, a
 * lesson that lights the right key only on a fresh server). This runs the
 * pieces in the demo's order on one server.
 *
 * Real: server, hub, runtime, surface manager, the room client against the
 * spec emulator, the keybed sidecar (python), the hand pipeline (#42) and
 * the bench's stroke client (#47). Stubbed, and why it is the honest seam:
 * the model (a recorded answer, so the real parser / layout report / verify
 * loop run on what the model really wrote) and the camera's pixels (the
 * emulator serves a fixture frame, as the room's camera will serve a real
 * one).
 *
 * What is asserted is what /table receives: the hub's SSE stream (render
 * lines, the surface set, the lesson overlay), read like a display reads it.
 *
 * Fixtures:
 * - IMG_3537.trace.json (label: recording): a real hand pinch-swiping "my
 *   name is julie" over a printed keyboard, MediaPipe landmarks per frame.
 * - "hello hubble": synthetic landmark frames whose pen traces each word's
 *   key-centre template (label: synthetic; the pipeline tests' hand builder).
 * - math-pythagoras (label: recording): the model's answer; it verifies with
 *   no repair beside the open keyboard (#47's probe).
 * - apps/keybed/fixtures/static.jpg (label: mechanical mutation of a product
 *   shot) as the camera frame; its manifest's true key quads are the oracle,
 *   through a fixed synthetic camera→projector homography.
 *
 * Determinism (#44): nothing asserts on time. Waits use budgets far above
 * what each step takes, so load only makes the run slower, never red.
 */
const WAIT = { timeout: 20_000, interval: 25 }
const config: ServerConfig = { port: 0, llm: { baseUrl: 'https://llm.invalid/v1', apiKey: 'sk-os', model: 'aixia-labs' }, jevApiKey: undefined }
const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } as never
const ANSWER = loadRecording('math-pythagoras')
const TRACE = JSON.parse(readFileSync(new URL('../web/src/hands/fixtures/IMG_3537.trace.json', import.meta.url), 'utf8')) as Trace
// What the person in IMG_3537 said (the trace's own meta.truth is empty;
// the words are the video's, as in hands/replay.test.ts).
const SAID = 'my name is julie'
const H_C2P: H = [1.6, 0.04, 60, -0.03, 1.6, 40, 0.00001, 0.000005, 1]
const GREEN = '#36ff7a'
const RED = '#ff3b3b'

/** Every user turn the model was shown (each SEND must become one). */
const asked: string[] = []
const brain = createBrain({
  llm: config.llm as { baseUrl: string; apiKey: string; model: string },
  model: () =>
    new MockLanguageModelV4({
      doGenerate: async (opts) => {
        asked.push(JSON.stringify(opts.prompt.filter((m) => m.role === 'user')))
        return { content: [{ type: 'text', text: ANSWER.text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
      },
    }),
})

type Line = RenderStreamLine | OverlayLine | SurfacesLine
/** A /table display: every SSE line, parsed. */
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
        // aborted at the end
      }
    })()
  })
  return { lines, ready, close: () => ctl.abort() }
}
const surfacesOf = (lines: Line[]): readonly TableSurface[] => lines.filter((l): l is SurfacesLine => l.kind === 'surfaces').at(-1)?.surfaces ?? []
const starts = (lines: Line[]) => lines.filter((l): l is Extract<RenderStreamLine, { kind: 'start' }> => l.kind === 'start')
const eventsOf = (lines: Line[], renderId: string): StageEvent[] => lines.flatMap((l) => (l.kind === 'event' && l.renderId === renderId ? [l.event] : []))
const lesson = (lines: Line[]) => lines.filter((l): l is OverlayLine => l.kind === 'overlay' && l.layer === 'lesson').at(-1)
const mathBodies = (text: string) => [...text.matchAll(/<Math(?:\s[^>]*)?>([\s\S]*?)<\/Math>/g)].map((m) => m[1]!.trim())

// ---- the synthetic hand ("hello hubble") ----
const I: H = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const DT = 33
function hand(pen: Pt, pinch: number): Hand {
  const lm: [number, number][] = Array.from({ length: 21 }, () => [pen.x, pen.y + 60] as [number, number])
  lm[0] = [pen.x, pen.y + 160] // wrist
  lm[9] = [pen.x, pen.y + 60] // middle knuckle: palm length 100
  const half = (pinch * 100) / 2
  lm[4] = [pen.x - half, pen.y] // thumb tip
  lm[8] = [pen.x + half, pen.y] // index tip
  return { handedness: 'Right', score: 0.95, lm }
}
const layout = buildLayout()
/** The polyline through a word's key centres (keyboard mm), sampled every 4 mm. */
function template(word: string): Pt[] {
  const corners = [...word].filter((c, i) => c !== word[i - 1]).map((c) => layout.centre(c))
  const out = [corners[0]!]
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1]!
    const b = corners[i]!
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4))
    for (let j = 1; j <= n; j++) out.push({ x: a.x + ((b.x - a.x) * j) / n, y: a.y + ((b.y - a.y) * j) / n })
  }
  return out
}
// SEND spans keys 7.5–10 of the 4th row: its centre, written out.
const SEND_MM = { x: 8.75 * KEY_MM, y: 3.5 * KEY_MM }
/** Pinch along each path, release between them: one press per path. */
function handFrames(paths: Pt[][], t0: number): Frame[] {
  const steps: Hand[] = []
  for (const path of paths) {
    for (let i = 0; i < 3; i++) steps.push(hand(path[0]!, 0.08))
    for (const p of path) steps.push(hand(p, 0.08))
    for (let i = 0; i < 4; i++) steps.push(hand(path.at(-1)!, 0.33))
  }
  return steps.map((h, i) => ({ t: t0 + i * DT, hands: [h] }))
}

/** An open palm (fingers straight, thumb out: pinch ratio ~1.5) centred near `at`, held still. */
function openPalm(at: Pt): Hand {
  const lm: [number, number][] = Array.from({ length: 21 }, () => [at.x, at.y] as [number, number])
  lm[0] = [at.x, at.y + 100] // wrist
  lm[9] = [at.x, at.y] // middle knuckle (palm length 100)
  for (const [pip, tip, dx] of [[6, 8, -40], [10, 12, 0], [14, 16, 40], [18, 20, 80]] as const) {
    lm[pip] = [at.x + dx, at.y - 40]
    lm[tip] = [at.x + dx, at.y - 120]
  }
  lm[4] = [at.x - 130, at.y] // thumb out to the side
  for (const i of [5, 13, 17]) lm[i] = [at.x, at.y]
  return { handedness: 'Right', score: 0.95, lm }
}

/**
 * The product's own gesture poster (apps/web/src/hands/gesturePoster.ts, what
 * the bench's hand panel uses), with its fetch pointed at this server. Review
 * #53: a hand-written HTTP adapter here let a broken poster pass.
 */
const poster = () => createGesturePoster((url, init) => fetch(`${base}${String(url)}`, init))
async function postGestures(events: Parameters<ReturnType<typeof createGesturePoster>['post']>[0][]) {
  const p = poster()
  for (const e of events) await p.post(e)
}

function calibrationFile() {
  const dir = mkdtempSync(join(tmpdir(), 'hubble-os-'))
  const file = join(dir, 'calibration.json')
  writeFileSync(file, JSON.stringify({ cameraToProjector: H_C2P }))
  return file
}

let emu: Awaited<ReturnType<typeof startEmulator>>
let room: Room
let side: { url: string; stop: () => void } | null = null
let app: ReturnType<typeof createApp>
let server: Server
let base: string
let tv: ReturnType<typeof display>

beforeAll(async () => {
  emu = await startEmulator(0)
  room = createLiveRoom({ base: emu.url, token: emu.token, kind: 'emulator' })
  side = hasKeybedPython ? await startKeybedSidecar() : null
  app = createApp(config, {
    brain,
    room,
    runtime: (channels) =>
      createRuntime({ ...channels, room, team: emu.team, publicBase: 'http://os.test:5173', calibrationFile: calibrationFile(), autoTick: false, keybed: side ? createKeybedClient({ url: side.url, deadlineMs: 15_000 }) : undefined }),
  })
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  tv = display(base)
  await tv.ready
}, 60_000)

afterAll(() => {
  tv?.close()
  app?.runtime.stop()
  server?.close()
  room?.close()
  emu?.close()
  side?.stop()
})

const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const keyboard = () => surfacesOf(tv.lines).find((s) => s.kind === 'keyboard') ?? null

/**
 * The bench, as far as the pen goes: its stroke client, with SEND becoming
 * the bench's own chat turn (POST /api/render), exactly as ChatPreview wires it.
 */
const bench = createTableKeyboardClient({
  box: () => keyboard()?.box ?? null,
  onSent: (text) => void post('/api/render', { intent: text }).then((r) => r.text()),
  onError: (m) => {
    throw new Error(`keyboard client: ${m}`)
  },
  fetch: (url, init) => fetch(`${base}${String(url)}`, init),
})

/** One answer as a display received it: whole, from the recording, beside the keyboard. */
async function expectAnswerFor(intent: string) {
  await vi.waitFor(() => expect(starts(tv.lines).some((s) => s.intent === intent)).toBe(true), WAIT)
  const start = starts(tv.lines).filter((s) => s.intent === intent).at(-1)!
  await vi.waitFor(() => expect(tv.lines.some((l) => l.kind === 'done' && l.renderId === start.renderId)).toBe(true), WAIT)
  const evs = eventsOf(tv.lines, start.renderId)
  // Break caught: the typed question reaching the model but its answer not
  // reaching the table, or arriving in pieces.
  expect(evs.filter((e): e is Extract<StageEvent, { type: 'piece' }> => e.type === 'piece' && e.tag === 'Math').map((e) => e.body.trim())).toEqual(mathBodies(ANSWER.text))
  expect(mathBodies(ANSWER.text)).toHaveLength(4) // corpus pin
  expect(evs.at(-1)).toEqual({ type: 'end', reason: 'complete' })
  // Break caught: the answer laid out over the open keyboard.
  expect(start.scene?.objects.find((o) => o.id === 'swipe-keyboard')?.box).toEqual(keyboard()!.box)
  return start
}

describe('the projection OS, hand to table (os:smoke)', { timeout: 60_000 }, () => {
  it('1. an open palm opens the launcher; a pinch on "Keyboard" opens the keyboard on the table', async () => {
    // Camera px = keyboard mm = table px here (identity maps): the hand is
    // above the open table, away from where the keyboard will open.
    const p = createHandPipeline({ camToKb: I, scale: 1, kbToTable: I })
    const palm = { x: 960, y: 640 }
    const wake: Parameters<ReturnType<typeof createGesturePoster>['post']>[0][] = []
    for (let i = 0; i < 45; i++) wake.push(...p.push({ t: i * DT, hands: [openPalm(palm)] }).table)
    // Break caught: an open palm that never becomes the "home" gesture.
    expect(wake.filter((e) => e.type === 'wake')).toHaveLength(1)
    await postGestures(wake)
    await vi.waitFor(() => expect(surfacesOf(tv.lines).some((x) => x.kind === 'launcher')).toBe(true), WAIT)
    const launcher = surfacesOf(tv.lines).find((x) => x.kind === 'launcher')!
    const item = (launcher.state as { items: { id: string; box: { x: number; y: number; w: number; h: number } }[] }).items.find((i) => i.id === 'keyboard')!
    const at = { x: launcher.box.x + item.box.x + item.box.w / 2, y: launcher.box.y + item.box.y + item.box.h / 2 }
    // A short, still pinch on the item, then release (hand frames go on after the palm).
    const pick: Parameters<ReturnType<typeof createGesturePoster>['post']>[0][] = []
    const frames = [...Array.from({ length: 4 }, () => hand(at, 0.08)), ...Array.from({ length: 4 }, () => hand(at, 0.33))]
    frames.forEach((h, i) => pick.push(...p.push({ t: 45 * DT + 500 + i * DT, hands: [h] }).table))
    await postGestures(pick)
    // Break caught: the launcher's pick not opening the keyboard (the demo's
    // only way to type would be the bench's checkbox).
    await vi.waitFor(() => expect(keyboard()).not.toBeNull(), WAIT)
    expect(surfacesOf(tv.lines).some((x) => x.kind === 'launcher')).toBe(false)
  })

  it('2. a recorded hand types "my name is julie"; SEND puts the answer on the table', async () => {
    const box = keyboard()!.box
    // The hand's keyboard→table map is the open surface's box, as the bench joins it.
    const p = createHandPipeline({ camToKb: fromPrintout(TRACE.meta.calibration), scale: TRACE.meta.sheet.scale, kbToTable: keyboardToTable(keyboardAtMm(box, { widthPx: 1920, heightPx: 1080, mmPerPx: 1500 / 1920 }), 1500 / 1920) })
    let presses = 0
    const downs: Pt[] = []
    for (const f of TRACE.frames) {
      const step = p.push(f)
      for (const e of step.table) if (e.type === 'pen-down') downs.push(e.p)
      for (const press of step.presses) {
        presses++
        await bench.stroke(press)
      }
    }
    expect(TRACE.frames).toHaveLength(330) // corpus pin
    expect(presses).toBe(4)
    // The mapped route too (review #53): every pen-down, mapped camera →
    // keyboard mm → table px, lands on the keyboard surface's box. Break
    // caught: a broken keyboard-to-table placement (e.g. the keyboard mapped
    // to the table's origin) that the press route alone never notices.
    expect(downs).toHaveLength(4)
    for (const d of downs) expect(d.x >= box.x && d.x <= box.x + box.w && d.y >= box.y && d.y <= box.y + box.h, JSON.stringify(d)).toBe(true)
    // Break caught: presses lost or mis-mapped between the camera and the runtime's keyboard.
    await vi.waitFor(() => expect((keyboard()!.state as KeyboardSurfaceState).text).toBe(SAID), WAIT)
    await bench.stroke([SEND_MM])
    await expectAnswerFor('my name is julie')
    // The answer and the keyboard share the table.
    expect(surfacesOf(tv.lines).map((s) => s.kind).sort()).toEqual(['answer', 'keyboard'])
  })

  it('3. a hand swipes "hello hubble"; SEND becomes the next question', async () => {
    const p = createHandPipeline({ camToKb: I, scale: 1 })
    const frames = handFrames([template('hello'), template('hubble'), [SEND_MM, SEND_MM]], 100_000)
    // Baseline BEFORE anything is sent (review #53: taken after SEND, a
    // model call that won the race made a correct run fail).
    const n = asked.length
    let sent = 0
    for (const f of frames)
      for (const press of p.push(f).presses) {
        sent++
        await bench.stroke(press)
      }
    expect(sent).toBe(3)
    await expectAnswerFor('hello hubble')
    // Break caught: SEND typed on the table never reaching the model.
    // (The bench's own turn carries no history: the bench never sends any.
    // Recorded as a gap for the manager, not asserted here.)
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(n), WAIT)
    expect(asked.at(-1)).toContain('hello hubble')
  })

  it('4. an asset opens as a surface, and a point on it hits it', async () => {
    expect((await post('/api/surfaces/asset', { id: 'right-triangle' })).status).toBe(200)
    await vi.waitFor(() => expect(surfacesOf(tv.lines).some((s) => s.kind === 'asset')).toBe(true), WAIT)
    const set = surfacesOf(tv.lines)
    const a = set.find((s) => s.kind === 'asset')!
    // Break caught: an asset drawn but not in the set a hand is hit-tested
    // against (it could never be moved or closed by hand).
    expect(hitTest(set, { x: a.box.x + a.box.w / 2, y: a.box.y + a.box.h / 2 })).toBe(a.id)
  })

  it('4b. a hand pinch-drags the asset to a new place, then flicks it off the table', async () => {
    // Through the real path (review #53): synthetic landmark frames → the
    // product hand pipeline → the product gesture poster → the server. The
    // keyboard→table map is deliberately NOT the identity: table = 2·kb +
    // (−200, 100). Expected moves come from that arithmetic, not from code.
    const K2T: H = [2, 0, -200, 0, 2, 100, 0, 0, 1]
    const toKb = (t: Pt) => ({ x: (t.x + 200) / 2, y: (t.y - 100) / 2 })
    const p = createHandPipeline({ camToKb: I, scale: 1, kbToTable: K2T })
    const a = surfacesOf(tv.lines).find((s) => s.kind === 'asset')!
    const start = toKb({ x: a.box.x + a.box.w / 2, y: a.box.y + a.box.h / 2 })
    // The pinch must be beside the keyboard widget, or it is a key press.
    expect(start.x).toBeGreaterThan(440 + 22)
    const events: Parameters<ReturnType<typeof createGesturePoster>['post']>[0][] = []
    let t = 300_000
    const push = (pen: Pt, pinch: number) => {
      events.push(...p.push({ t, hands: [hand(pen, pinch)] }).table)
      t += DT
    }
    // Slow drag: +60, +20 keyboard mm over 12 frames (~170 mm/s, far below a flick), hold, open.
    for (let i = 0; i < 3; i++) push(start, 0.08)
    for (let i = 1; i <= 12; i++) push({ x: start.x + (60 * i) / 12, y: start.y + (20 * i) / 12 }, 0.08)
    for (let i = 0; i < 4; i++) push({ x: start.x + 60, y: start.y + 20 }, 0.08)
    for (let i = 0; i < 4; i++) push({ x: start.x + 60, y: start.y + 20 }, 0.33)
    await postGestures(events)
    // Break caught: a drag that never reaches the surface manager, a wrong
    // keyboard→table map, or a slow release mistaken for a flick.
    await vi.waitFor(() => {
      const moved = surfacesOf(tv.lines).find((s) => s.id === a.id)
      expect(moved?.box.x).toBeCloseTo(a.box.x + 120, 0)
      expect(moved?.box.y).toBeCloseTo(a.box.y + 40, 0)
    }, WAIT)
    // Flick: pinch, then 150 kb mm in 3 frames (~1500 mm/s) and let go while moving.
    events.length = 0
    const from = { x: start.x + 60, y: start.y + 20 }
    for (let i = 0; i < 3; i++) push(from, 0.08)
    for (let i = 1; i <= 3; i++) push({ x: from.x + 50 * i, y: from.y }, 0.08)
    for (let i = 1; i <= 3; i++) push({ x: from.x + 150 + 10 * i, y: from.y }, 0.33)
    await postGestures(events)
    // Break caught: the hand pipeline never recognising a flick, or a flick
    // treated as a drop (the "dismiss" gesture doing nothing).
    await vi.waitFor(() => expect(surfacesOf(tv.lines).some((s) => s.id === a.id)).toBe(false), WAIT)
  })

  it.skipIf(!hasKeybedPython)('5. the keyboard act: the table clears and the camera\'s keyboard lights each note on its own key', async () => {
    const f = loadKeybedFixtures().frames.find((x) => x.file === 'static.jpg')!
    await fetch(`${emu.url}/emulator/camera`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array(loadKeybedFixtures().jpeg(f)) })
    expect((await post('/api/operator/act', { act: 'lesson' })).status).toBe(200)
    // Key highlights only (owner): every surface leaves the table.
    await vi.waitFor(() => expect(surfacesOf(tv.lines)).toEqual([]), WAIT)
    expect(starts(tv.lines).at(-1)!.renderId.startsWith('dismiss-')).toBe(true)
    // The operator explicitly enables detection; switching acts alone must
    // not silently start camera processing after it was turned off.
    expect((await post('/api/operator/piano', { enabled: true })).status).toBe(200)
    await vi.waitFor(async () => expect(((await (await fetch(`${base}/api/runtime`)).json()) as { keySource: string }).keySource).toBe('camera'), WAIT)
    const truth = (note: number) => pts(f.keys.find((k) => k.note === note)!.corners).map((p) => apply(H_C2P, p))
    // Ode to Joy, written out here (review #53: reading the product's own
    // song let an emptied song pass with zero checks). Pinned: 15 notes.
    const ODE = [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62]
    expect(ODE).toHaveLength(15)
    // A lit key is right when it is the ONLY shape (key highlights only) and
    // every corner is within 8 projector px of the fixture key's corner
    // (review #53: a centroid check let a tenfold-enlarged polygon, or an
    // extra light elsewhere, pass).
    const onKey = (shape: { points: Pt[] }, note: number) => {
      const t = truth(note)
      return shape.points.length === t.length && shape.points.every((q, i) => Math.hypot(q.x - t[i]!.x, q.y - t[i]!.y) <= 8)
    }
    const bad: string[] = []
    let previous: number | null = null
    for (const note of ODE) {
      await vi.waitFor(() => expect(lesson(tv.lines)?.shapes.some((s) => s.color === GREEN)).toBe(true), WAIT)
      const ov = lesson(tv.lines)!
      if (ov.shapes.length !== 1 || ov.shapes[0]!.color !== GREEN || !onKey(ov.shapes[0]!, note)) bad.push(`${note}: ${JSON.stringify(ov.shapes.map((x) => x.color))}`)
      // A repeated note is a second press, not a copy of the first: since #80
      // the runtime drops the same note again within 150 ms as a duplicate,
      // so wait as a real player would (as #80 did in demo.smoke.test.ts).
      if (note === previous) await new Promise((r) => setTimeout(r, 200))
      previous = note
      await post('/api/input/midi', { type: 'note-on', note, velocity: 90 })
      // Progress is a NEW lesson overlay (not any SSE line).
      await vi.waitFor(() => expect(lesson(tv.lines)).not.toBe(ov), WAIT)
    }
    expect(bad).toEqual([])
    // Break caught: a lesson that never finishes (its last key left lit).
    await vi.waitFor(() => expect(lesson(tv.lines)?.shapes).toEqual([]), WAIT)
    // A wrong note flashes red on THAT key, while green stays on the expected one.
    await post('/api/operator/act', { act: 'lesson', song: 'twinkle' })
    await vi.waitFor(() => expect(lesson(tv.lines)?.shapes.some((s) => s.color === GREEN && onKey(s, 60))).toBe(true), WAIT)
    // The song above ended on this same D (62): pressed again within #80's
    // 150 ms it would be dropped as a duplicate, not judged as a wrong note.
    // A real player's next press comes later.
    await new Promise((r) => setTimeout(r, 200))
    await post('/api/input/midi', { type: 'note-on', note: 62, velocity: 90 })
    await vi.waitFor(() => {
      const sh = lesson(tv.lines)!.shapes
      expect(sh).toHaveLength(2)
      expect(sh.some((x) => x.color === RED && onKey(x, 62))).toBe(true)
      expect(sh.some((x) => x.color === GREEN && onKey(x, 60))).toBe(true)
    }, WAIT)
  })
})
