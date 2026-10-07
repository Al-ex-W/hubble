import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import express from 'express'
import { afterEach, expect, it, vi } from 'vitest'
import { solveHomography } from '@hubble/room'
import type { OverlayLine, SurfacesLine } from '@hubble/stage'
import type { Trace } from '../../shared/hands/types.ts'
import { createRuntime } from '../runtime.ts'
import { mountRuntime } from '../runtimeRoutes.ts'
import { createSpatialService } from '../spatial/service.ts'
import { mountSpatial } from '../spatial/routes.ts'
import type { HandObservation } from '../spatial/observations.ts'
import { createStageHub } from '../hub.ts'

// Recording: every original IMG_3537 landmark frame. Mechanical mutation: its
// measured print corners are registered onto the current projected keyboard.
// The cap coordinates and 440×256 layout are independent literal geometry;
// neither production box conversion nor browser printout mapping is the oracle.
const trace = JSON.parse(readFileSync(new URL('../../web/src/hands/fixtures/IMG_3537.trace.json', import.meta.url), 'utf8')) as Trace
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(f => f()))

function setup(lidarUrl?: string) {
  let time = 0
  const overlays: OverlayLine[] = []
  const surfaces: SurfacesLine[] = []
  const ask = vi.fn(() => true)
  const hub = createStageHub()
  const spatial = createSpatialService({ now: () => time, lidarUrl })
  const runtime = createRuntime({ spatial, now: () => time, autoTick: false, calibrationFile: '/nonexistent-keyboard-replay',
    overlay: l => { overlays.push(l); hub.overlay(l) }, surfaces: l => { surfaces.push(l); hub.surfaces(l) }, ask })
  cleanups.push(() => runtime.stop())
  runtime.keyboard.open()
  const box = { ...runtime.surfaces.list()[0]!.box }
  const at = (p: { x: number; y: number }) => ({ x: box.x + p.x * box.w / 440, y: box.y + (80 + p.y) * box.w / 440 })
  const caps = [{ x: 3, y: 3 }, { x: 437, y: 3 }, { x: 437, y: 173 }, { x: 69, y: 173 }]
  const h = solveHomography(trace.meta.calibration.map((from, i) => ({ from, to: at(caps[i]!) })))
  spatial.calibration.setCamera({ h, width: 1920, height: 1080, geometry: 'recorded-print' })
  let grant = runtime.keyboardInput.select('room-pinch')
  const frame = (i: number): HandObservation => {
    const f = trace.frames[i]!
    return { session: 'take', seq: i, capturedAt: f.t, geometry: 'recorded-print', width: 1920, height: 1080,
      input: { token: grant.token, revision: grant.revision }, hands: f.hands.map(h => {
        const p = (j: number) => ({ x: h.lm[j]![0], y: h.lm[j]![1] })
        return { index: p(8), pinch: { thumb: p(4), wrist: p(0), middle: p(9) } }
      }) }
  }
  const feed = (i: number, mutate: (f: HandObservation) => void = () => {}) => {
    const f = frame(i); mutate(f); time = Math.max(time, trace.frames[i]!.t)
    return spatial.observe(f)
  }
  const range = (a: number, b: number) => { for (let i = a; i < b; i++) feed(i) }
  const overlay = () => overlays.filter(l => l.layer === 'keyboard-input').at(-1)
  return { runtime, spatial, hub, ask, overlays, surfaces, overlay, frame, feed, range, box, at, h,
    advance(ms: number) { time += ms; runtime.keyboardInput.tick() },
    select() { grant = runtime.keyboardInput.select('room-pinch'); return grant },
    get grant() { return grant },
  }
}

async function display(base: string) {
  const abort = new AbortController()
  const response = await fetch(base + '/api/stage/events', { signal: abort.signal })
  const reader = response.body!.getReader()
  const lines: (SurfacesLine | OverlayLine)[] = []
  const decoder = new TextDecoder()
  void (async () => {
    let pending = ''
    try {
      for (;;) {
        const r = await reader.read()
        if (r.done) break
        pending += decoder.decode(r.value, { stream: true })
        let end: number
        while ((end = pending.indexOf('\n\n')) !== -1) {
          const frame = pending.slice(0, end)
          pending = pending.slice(end + 2)
          if (frame.startsWith('data: ')) lines.push(JSON.parse(frame.slice(6)))
        }
      }
    } catch { /* display disconnected at test teardown */ }
  })()
  return { lines, close: () => abort.abort() }
}

it('types the spoken phrase from all 330 raw frames through HTTP and the runtime, once', async () => {
  // Break caught: diagnostic observations never reach a reducer, map twice, or
  // share the legacy pointer path and append each word twice. The text is the
  // speaker's phrase; four draft updates are the four recorded gestures.
  expect(trace.frames).toHaveLength(330)
  const s = setup()
  const app = express().use(express.json())
  mountRuntime(app, s.runtime)
  mountSpatial(app, s.spatial)
  app.get('/api/stage/events', (_req, res) => s.hub.subscribe(res))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(r => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const displays = await Promise.all([display(base), display(base)])
  try {
    for (let i = 0; i < trace.frames.length; i++) {
      // Advance receipt time independently of browser source time; both must
      // progress, but the service never subtracts clocks on different machines.
      s.advance(i ? trace.frames[i]!.t - trace.frames[i - 1]!.t : 0)
      const response = await post('/api/spatial/observations', s.frame(i))
      expect(response.status).toBe(202)
    }
    expect(s.runtime.keyboard.state()?.text).toBe('my name is julie')
    const texts = s.surfaces.flatMap(l => l.surfaces.filter(x => x.kind === 'keyboard').map(x => x.state.text)).filter(Boolean)
    expect(texts).toEqual(['my', 'my name', 'my name is', 'my name is julie'])
    expect(s.overlays.some(l => l.layer === 'keyboard-input' && l.shapes.length > 10)).toBe(true)
    expect(s.overlay()?.shapes).toEqual([]) // recorded hand leaves; all displays clear
    for (const display of displays) {
      await vi.waitFor(() => expect(display.lines.filter(l => l.kind === 'overlay').at(-1)?.shapes).toEqual([]))
      const final = display.lines.filter(l => l.kind === 'surfaces').at(-1)
      expect(final?.surfaces.find(s => s.kind === 'keyboard')?.state.text).toBe('my name is julie')
      expect(display.lines.some(l => l.kind === 'overlay' && l.shapes.length > 10)).toBe(true)
    }
    const reconnect = await display(base)
    displays.push(reconnect)
    await vi.waitFor(() => expect(reconnect.lines.some(l => l.kind === 'surfaces')).toBe(true))
    expect(reconnect.lines.some(l => l.kind === 'overlay' && l.shapes.length)).toBe(false)
    expect((await post('/api/keyboard/stroke', { points: [s.at({ x: 385, y: 154 })] })).status).toBe(409)
    expect(s.ask).not.toHaveBeenCalled()
    const selected = await post('/api/keyboard/input', { mode: 'pointer', token: s.grant.token })
    expect(selected.status).toBe(200)
    expect((await post('/api/keyboard/stroke', { points: [s.at({ x: 385, y: 154 })] })).status).toBe(200)
    expect(s.ask).toHaveBeenCalledTimes(1)
    expect(s.ask.mock.calls[0]).toMatchObject([{ intent: 'my name is julie' }])
  } finally { displays.forEach(d => d.close()); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
})

it.each(['missing', 'two hands', 'geometry', 'token', 'revision', 'silence', 'source gap', 'session', 'move', 'reopen', 'cover', 'calibration'] as const)('cancels a recorded in-progress word on %s', (change) => {
  // Mechanical mutation of the first recorded swipe (closed frames 37–82).
  // The interrupted first word must stay absent; subsequent real words still
  // work after an open pinch, proving cancellation isn't simply disabling input.
  const s = setup()
  s.range(0, 60)
  expect(s.runtime.keyboardInput.state().reason).toBe('pinching')
  if (change === 'move') { s.runtime.surfaces.move('keyboard', { dx: 10, dy: 0 }); s.runtime.surfaces.move('keyboard', { dx: -10, dy: 0 }) }
  else if (change === 'reopen') { s.runtime.keyboard.close(); s.runtime.keyboard.open() }
  else if (change === 'cover') {
    s.runtime.surfaces.openWeb('cover', 'https://example.invalid', { widthMm: 1550, heightMm: 970 })
    s.runtime.surfaces.close('cover')
  } else if (change === 'calibration') {
    s.spatial.calibration.setCamera({ h: [...s.h.slice(0, 2), s.h[2]! + 1, ...s.h.slice(3)], width: 1920, height: 1080, geometry: 'recorded-print' })
    s.runtime.keyboardInput.tick()
    s.select()
  } else if (change === 'silence') s.advance(250)
  else s.feed(60, f => {
    if (change === 'missing') f.hands = []
    if (change === 'two hands') f.hands.push(structuredClone(f.hands[0]!))
    if (change === 'geometry') f.geometry = 'crop'
    if (change === 'token') f.input!.token = 'old-mode'
    if (change === 'revision') f.input!.revision++
    if (change === 'source gap') f.capturedAt += 250
    if (change === 'session') { f.session = 'new-source'; f.capturedAt += 550; s.advance(550) }
  })
  expect(s.overlay()?.shapes).toEqual([])
  s.range(61, 106)
  expect(s.runtime.keyboard.state()?.text).toBe('')
  s.range(106, 330)
  expect(s.runtime.keyboard.state()?.text).toBe('name is julie')
  expect(s.ask).not.toHaveBeenCalled()
})

it('requires an open pinch after activation, rejects duplicates and stale grant teardown', () => {
  // Mechanical take suffix begins already pinched; adopting it would invent a
  // word. Repeated/reordered original frames cannot supply confirmation votes.
  const s = setup()
  s.range(50, 106)
  expect(s.runtime.keyboard.state()?.text).toBe('')
  s.range(106, 169)
  expect(s.runtime.keyboard.state()?.text).toBe('') // release needs two frames
  // Schema-derived interleaving: several *spatial* publications still contain
  // recorded camera frame 168. They must not supply its second release vote.
  s.runtime.surfaces.openLaid('unrelated', 'launcher', { x: 0, y: 0, w: 10, h: 10 }, {})
  s.runtime.surfaces.move('unrelated', { dx: 1, dy: 0 })
  s.runtime.surfaces.close('unrelated')
  expect(s.runtime.keyboard.state()?.text).toBe('')
  expect(s.feed(168)).toBe(false)
  expect(s.feed(167)).toBe(false)
  expect(s.runtime.keyboard.state()?.text).toBe('')
  s.feed(169)
  expect(s.runtime.keyboard.state()?.text).toBe('name')
  const old = s.grant.token
  s.select()
  expect(() => s.runtime.keyboardInput.select('pointer', old)).toThrow('replaced')
  expect(s.runtime.keyboardInput.acceptsPointer()).toBe(false)
})

it.each(['duration', 'samples'] as const)('cancels an indefinitely held recorded pinch at its %s limit', limit => {
  // Mechanical mutation: hold frame 50's real closed hand indefinitely while
  // timestamps/sequence keep advancing. This bounds memory and delayed commits.
  const s = setup()
  s.range(0, 60)
  let f = s.frame(59)
  for (let i = 0; i < (limit === 'duration' ? 100 : 1000); i++) {
    f = { ...f, seq: f.seq + 1, capturedAt: f.capturedAt + (limit === 'duration' ? 100 : 3) }
    s.advance(limit === 'duration' ? 100 : 3)
    s.spatial.observe(f)
    if (s.runtime.keyboardInput.state().reason.includes('too long')) break
  }
  expect(s.runtime.keyboardInput.state().reason).toContain('too long')
  expect(s.overlay()?.shapes).toEqual([])
  expect(s.runtime.keyboard.state()?.text).toBe('')
})

it('cannot start on a covering surface and clears feedback on stop without another frame', () => {
  // Mechanical surface overlay over the recorded word; the hit-test must use
  // current stacking order at acquisition, not only cancel an existing press.
  const s = setup()
  s.runtime.surfaces.openWeb('cover', 'https://example.invalid', { widthMm: 1550, heightMm: 970 })
  s.range(0, 106)
  expect(s.runtime.keyboard.state()?.text).toBe('')
  s.runtime.surfaces.close('cover')
  s.range(106, 150)
  expect(s.overlay()?.shapes.length).toBeGreaterThan(0)
  s.runtime.stop()
  expect(s.overlay()?.shapes).toEqual([])
  s.range(150, 330)
  expect(s.runtime.keyboard.state()?.text).toBe('')
})

it('selects a displayed candidate and emits exactly one SEND on a progressing pinch release', () => {
  // Real recorded text followed by schema-derived candidate and SEND taps.
  // Frame geometry uses an identity map; no physical touch is implied.
  const s = setup()
  s.range(0, 330)
  s.spatial.calibration.setCamera({ h: [1, 0, 0, 0, 1, 0, 0, 0, 1], width: 1920, height: 1080, geometry: 'tap' })
  const grant = s.select()
  expect(s.runtime.keyboard.state()?.candidates).toEqual(['julie', 'implies', 'inputs'])
  // Left candidate slot shows rank 1, the centre shows rank 0 (SLOT_ORDER).
  for (let i = 0; i < 12; i++) {
    const point = s.at(i < 6 ? { x: 73, y: -23 } : { x: 385, y: 154 })
    const gap = i % 6 === 2 || i % 6 === 3 ? 5 : 20
    const f: HandObservation = { session: 'take', seq: 400 + i, capturedAt: 12000 + i * 33, width: 1920, height: 1080, geometry: 'tap', input: grant,
      hands: [{ index: { x: point.x + gap, y: point.y }, pinch: { thumb: { x: point.x - gap, y: point.y }, wrist: { x: 0, y: 0 }, middle: { x: 100, y: 0 } } }] }
    // The ratio is .1 closed / .4 open, matching the recorded threshold bands.
    s.advance(i ? 33 : 1033)
    expect(s.spatial.observe(f)).toBe(true)
    expect(s.spatial.observe(f)).toBe(false)
  }
  expect(s.ask).toHaveBeenCalledTimes(1)
  expect(s.runtime.keyboard.state()?.sent).toEqual({ n: 1, text: 'my name is implies' })
})

it('does not use interleaved recorded lidar scans as camera pinch confirmation votes', async () => {
  // Mechanical interleaving of two independent recordings, NOT paired contact
  // truth. The first release frame for “name” needs the next CAMERA sample;
  // spatial publications from actual lidar transport must not complete it.
  const scans = readFileSync(new URL('../../../packages/room/fixtures/lidar/2026-10-07-wire/scans.jsonl', import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l).raw)
  const wire = new WebSocketServer({ port: 0 })
  await once(wire, 'listening')
  const s = setup(`http://127.0.0.1:${(wire.address() as { port: number }).port}`)
  try {
    const [socket] = await once(wire, 'connection')
    s.range(0, 169)
    expect(s.runtime.keyboard.state()?.text).toBe('my')
    for (let i = 0; i < 2; i++) {
      socket.send(scans[i])
      await vi.waitFor(() => expect(s.spatial.snapshot().lidar.frame?.seq).toBe(i + 1), { interval: 1 })
      expect(s.runtime.keyboard.state()?.text).toBe('my')
    }
    s.range(169, 330)
    expect(s.runtime.keyboard.state()?.text).toBe('my name is julie')
  } finally {
    s.runtime.stop()
    for (const socket of wire.clients) socket.terminate()
    await new Promise<void>(r => wire.close(() => r()))
  }
})
