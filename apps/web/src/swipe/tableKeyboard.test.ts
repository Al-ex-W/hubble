import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Box, SurfacesLine } from '@hubble/stage'
import type { KeyboardSurfaceState, Pt } from '@hubble/stage/swipe'
import { createApp } from '../../../server/index.ts'
import { createRuntime } from '../../../server/runtime.ts'
import { fromPrintout } from '../hands/calibration.ts'
import { createHandPipeline } from '../hands/pipeline.ts'
import type { Trace } from '../hands/types.ts'
import { createTableKeyboardClient, keyboardAtMm } from './tableKeyboard.ts'

/**
 * A real recorded hand typing on the table's keyboard, through the product
 * path end to end (#29): the hands pipeline (#42) turns the recording into
 * presses, the bench's client posts them, the real server's runtime runs the
 * keyboard reducer on its surface, and SEND comes back as the bench's chat
 * turn. The server is created in-process on port 0 (no model: the bench
 * sends with ask: false, so none is needed).
 *
 * Fixture: hands/fixtures/IMG_3537.trace.json (label: recording; 330 frames
 * of MediaPipe landmarks from a real video, with its 4-tap calibration).
 * Oracle: what the person said, "my name is julie". The SEND key's centre
 * (385, 154) keyboard mm is written out from the layout (label:
 * schema-derived: send spans 7.5-10 keys of 44 mm on the 4th row).
 */
const trace = JSON.parse(readFileSync(new URL('../hands/fixtures/IMG_3537.trace.json', import.meta.url), 'utf8')) as Trace
const SEND_MM = { x: 385, y: 154 }
const config = { port: 0, llm: { baseUrl: 'https://llm.invalid/v1', apiKey: '', model: 'aixia-labs' }, jevApiKey: undefined }

let app: ReturnType<typeof createApp>
let server: ReturnType<ReturnType<typeof createApp>['listen']>
let base: string
beforeAll(async () => {
  app = createApp(config, { runtime: (channels) => createRuntime({ ...channels, calibrationFile: '/nonexistent/tk.json' }) })
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  app.runtime.stop()
  server.close()
})

const keyboardSurface = async () => ((await (await fetch(`${base}/api/surfaces`)).json()) as SurfacesLine).surfaces.find((s) => s.kind === 'keyboard') ?? null

describe('the bench typing on the table keyboard with a recorded hand', () => {
  it('opens the keyboard on the first press, types "my name is julie", and SEND becomes the bench\'s turn', async () => {
    expect(trace.frames.length).toBe(330) // corpus pin
    let box: Box | null = null
    const sent: { text: string; box: Box }[] = []
    const errors: string[] = []
    const client = createTableKeyboardClient({
      box: () => box,
      onSent: (text, b) => sent.push({ text, box: b }),
      onError: (m) => errors.push(m),
      fetch: (url, init) => fetch(`${base}${String(url)}`, init),
    })
    const p = createHandPipeline({ camToKb: fromPrintout(trace.meta.calibration), scale: trace.meta.sheet.scale })
    let presses = 0
    for (const frame of trace.frames) {
      for (const press of p.push(frame).presses) {
        presses++
        await client.stroke(press)
        // The bench's box comes from the surface set; here, from the server.
        box = (await keyboardSurface())?.box ?? null
      }
    }
    expect(presses).toBe(4)
    expect(errors).toEqual([])
    // Break caught: the first press dropped while the keyboard opens (the
    // text would start at "name"), or presses posted in keyboard mm instead
    // of table px (they'd miss the keyboard: nothing typed).
    expect(((await keyboardSurface())!.state as KeyboardSurfaceState).text).toBe('my name is julie')

    await client.stroke([SEND_MM])
    // Break caught: SEND not reaching the bench (no chat turn), or reaching
    // it with another box than the keyboard's (the answer laid over it).
    expect(sent).toEqual([{ text: 'my name is julie', box: box! }])
    expect((await keyboardSurface())!.state).toMatchObject({ text: '', sent: { n: 1, text: 'my name is julie' } })
  })
})

describe('the client on its own (stand-in fetch, label: schema-derived)', () => {
  it('posts table px through the current box, with ask: false', async () => {
    const posted: { url: string; body: { points: { x: number; y: number }[]; ask: boolean } }[] = []
    const box = { x: 100, y: 200, w: 880, h: 512 } // 2 px per mm: 440 × 256 mm
    const client = createTableKeyboardClient({
      box: () => box,
      onSent: () => {},
      fetch: async (url, init) => {
        posted.push({ url: String(url), body: JSON.parse(String(init!.body)) })
        return new Response(JSON.stringify({ output: { kind: 'key' } }))
      },
    })
    await client.stroke([{ x: 22, y: 22 }])
    // q's centre (22, 22) keyboard mm → 100 + 44, 200 + (22 + 80) × 2.
    // Break caught: the 80 mm strip above the keys forgotten, or the scale
    // taken from the projector instead of the box.
    expect(posted).toEqual([{ url: '/api/keyboard/stroke', body: { points: [{ x: 144, y: 404 }], ask: false } }])
  })

  it('says so when the keyboard cannot open, instead of typing nowhere', async () => {
    const errors: string[] = []
    const client = createTableKeyboardClient({ box: () => null, onSent: () => {}, onError: (m) => errors.push(m), fetch: async () => new Response('{}', { status: 503 }) })
    await client.stroke([{ x: 1, y: 1 }])
    expect(errors).toEqual(['could not open the keyboard (503)'])
  })
})

describe('strokes in pen order, whatever the network does (review #47)', () => {
  const strokes = (JSON.parse(readFileSync(new URL('../../../../packages/stage/src/swipe/fixtures/IMG_3537.strokes.json', import.meta.url), 'utf8')) as { strokes: { points: Pt[] }[] }).strokes

  it('a word fired while the keyboard is still opening lands after the first, and SEND after both', async () => {
    await fetch(`${base}/api/keyboard/close`, { method: 'POST' })
    // Hold the open's reply until the later strokes have been fired (label:
    // timing mutation of the recorded IMG_3537 strokes, the review's probe).
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let opened!: () => void
    const isOpen = new Promise<void>((r) => (opened = r))
    const sent: string[] = []
    // The bench's real sequence: the server opens the keyboard and the
    // surface set (SSE) shows its box at once, while the open's own reply is
    // still on its way. So a later stroke sees the box and could post
    // straight through, ahead of the first.
    let box: Box | null = null
    const client = createTableKeyboardClient({
      box: () => box,
      onSent: (t) => sent.push(t),
      fetch: async (url, init) => {
        const res = await fetch(`${base}${String(url)}`, init)
        if (String(url) === '/api/keyboard/open') {
          box = (await keyboardSurface())!.box
          opened()
          await held
        }
        return res
      },
    })
    // Fired like pointer and hand events are: nobody awaits.
    void client.stroke(strokes[0]!.points)
    await isOpen // the keyboard is on the table; the first stroke's reply is held
    void client.stroke(strokes[1]!.points)
    const last = client.stroke([SEND_MM])
    await new Promise((r) => setTimeout(r, 50)) // let anything that would overtake, overtake
    release()
    await last
    // Break caught: "name my" (the second word overtaking the first while
    // the keyboard opened), a second open, or SEND overtaking a word.
    expect(sent).toEqual(['my name'])
  })

  it('a dropped connection is reported, not lost silently', async () => {
    const errors: string[] = []
    const client = createTableKeyboardClient({ box: () => ({ x: 0, y: 0, w: 563.2, h: 327.68 }), onSent: () => {}, onError: (m) => errors.push(m), fetch: async () => Promise.reject(new TypeError('Failed to fetch')) })
    await client.stroke([{ x: 1, y: 1 }])
    // Break caught: a rejected fetch escaping as an unhandled rejection the
    // fire-and-forget callers never see.
    expect(errors).toEqual(['stroke failed (Failed to fetch)'])
  })

  it('after the keyboard is closed under it, the next stroke opens it again', async () => {
    await fetch(`${base}/api/keyboard/close`, { method: 'POST' })
    const errors: string[] = []
    let box: Box | null = null
    const client = createTableKeyboardClient({ box: () => box, onSent: () => {}, onError: (m) => errors.push(m), fetch: (url, init) => fetch(`${base}${String(url)}`, init) })
    await client.stroke([{ x: 22, y: 22 }]) // opens, types q
    await fetch(`${base}/api/keyboard/close`, { method: 'POST' }) // someone else closes it…
    box = null // …and the surface set says so
    await client.stroke([{ x: 22, y: 22 }]) // opens again (fresh draft) and types q
    // Break caught: a client posting to a keyboard that no longer exists.
    expect(errors).toEqual([])
    expect(((await keyboardSurface())!.state as KeyboardSurfaceState).text).toBe('q')
  })
})

describe("the hand's keyboard placement (review #47)", () => {
  it('is the open box, else where the runtime opens it', () => {
    const s = { widthPx: 1920, heightPx: 1080, mmPerPx: 1500 / 1920 }
    // Written out: 440 mm wide, centred on 1500 mm; 256 mm tall, 40 mm off the
    // 843.75 mm near edge. Open: a box at (100, 200) px is (78.125, 156.25) mm.
    // Break caught: the bench's hand mapping fixed at the origin, or using
    // another placement than the runtime's (strokes land off the keys).
    const def = keyboardAtMm(null, s)
    expect(def.xMm).toBeCloseTo(530, 6)
    expect(def.yMm).toBeCloseTo(843.75 - 256 - 40, 6)
    expect(keyboardAtMm({ x: 100, y: 200, w: 563.2, h: 327.68 }, s)).toEqual({ xMm: 78.125, yMm: 156.25 })
  })
})
