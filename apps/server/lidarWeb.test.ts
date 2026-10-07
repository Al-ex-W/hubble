import { once } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SURFACE } from '@hubble/stage'
import type { LidarFrame } from '@hubble/room'
import { createSpatialService, type SpatialService } from './spatial/service.ts'
import { tableToSensor, wireFrames, withFinger } from './spatial/lidarFixtures.ts'
import { createRuntime, type WebInput } from './runtime.ts'
import { WEB_SIZE } from './webRoutes.ts'

/*
 * A lidar finger on a projected web page, through the runtime
 * (docs/plans/2026-10-07-lidar-web.md): the real spatial service on a loopback
 * socket streams the wire rotations (recording) with a fingertip put in by
 * mechanical mutation; the registration is the schema-derived pose
 * (lidarFixtures), not a measurement. Oracle: box arithmetic, as
 * webBrowsing.test.ts (a point at box + (x, y) is page point (x, y)).
 */
const frames = wireFrames()
const mmPerPx = DEFAULT_SURFACE.mmPerPx

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

function register(service: SpatialService) {
  const pts = [{ x: 100, y: 100 }, { x: 1450, y: 100 }, { x: 1450, y: 870 }, { x: 100, y: 870 }]
  const check = [{ x: 775, y: 485 }, { x: 400, y: 600 }]
  const toPx = (p: { x: number; y: number }) => ({ x: p.x / mmPerPx, y: p.y / mmPerPx })
  service.calibration.register({
    table: pts.map((p) => ({ from: p, to: toPx(p) })),
    tableCheck: check.map((p) => ({ from: p, to: toPx(p) })),
    lidar: pts.map((p) => ({ from: tableToSensor(p), to: p })),
    lidarCheck: check.map((p) => ({ from: tableToSensor(p), to: p })),
    maxProjectorErrorPx: 1,
    maxTableErrorMm: 1,
  })
}

async function rig() {
  const server = new WebSocketServer({ port: 0 })
  await once(server, 'listening')
  const spatial = createSpatialService({ lidarUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
  const [socket] = (await once(server, 'connection')) as [WebSocket]
  let t = Date.now()
  const send = (f: LidarFrame) => socket.send(JSON.stringify({ t: (t += 100), points: f.points }))
  const calls: string[] = []
  const web: WebInput = {
    click: async (id, x, y) => void calls.push(`click ${id} ${x},${y}`),
    scroll: async (id, dy) => void calls.push(`scroll ${id} ${dy}`),
    type: async (id, text) => void calls.push(`type ${id} ${text}`),
    key: async (id, key) => void calls.push(`key ${id} ${key}`),
  }
  const rt = createRuntime({ overlay: () => {}, spatial, webInput: web, autoTick: false })
  register(spatial)
  let i = 0
  const pump = setInterval(() => send(frames[i++ % 40]!), 25)
  expect(await spatial.captureBaseline(1000)).toMatchObject({ ok: true })
  clearInterval(pump)
  const page = rt.surfaces.openWeb('web-1', 'https://www.amazon.se/', WEB_SIZE)
  cleanup = async () => {
    rt.stop()
    for (const ws of server.clients) ws.terminate()
    await new Promise<void>((r) => server.close(() => r()))
  }
  // A fingertip at projector px p for `n` rotations, then lifted for 3.
  const touch = async (path: { x: number; y: number }[]) => {
    for (const [k, p] of path.entries()) {
      send(withFinger(frames[50 + k]!, tableToSensor({ x: p.x * mmPerPx, y: p.y * mmPerPx })))
      await new Promise((r) => setTimeout(r, 30))
    }
    for (let k = 0; k < 3; k++) {
      send(frames[60 + k]!)
      await new Promise((r) => setTimeout(r, 30))
    }
  }
  return { rt, calls, page, touch }
}

describe('lidar on a web page', () => {
  // Break caught: lidar touches never reaching the page (the runtime only
  // rippled), or reaching it at the wrong point (the projector → page-local
  // step lost). The whole chain: socket → tracker → lidarGestures → gesture
  // → web handler → click.
  it('a fingertip held briefly on the page clicks it there, and focuses it', async () => {
    const { rt, calls, page, touch } = await rig()
    const at = { x: page.x + 300, y: page.y + 200 }
    await touch([at, at, at])
    expect(calls).toHaveLength(1)
    const [, , xy] = calls[0]!.split(' ')
    const [x, y] = xy!.split(',').map(Number)
    // Within a few px: the finger's sensor point goes through the pose and back.
    expect(Math.abs(x! - 300)).toBeLessThan(6)
    expect(Math.abs(y! - 200)).toBeLessThan(6)
    expect(rt.focusedWeb()).toBe('web-1')
  })

  // Break caught: a swipe on the page clicking instead of scrolling.
  it('a finger dragged down the page scrolls it, and does not click', async () => {
    const { calls, page, touch } = await rig()
    const x = page.x + 400
    await touch([0, 0, 60, 120, 180].map((dy) => ({ x, y: page.y + 150 + dy })))
    expect(calls.some((c) => c.startsWith('scroll web-1'))).toBe(true)
    expect(calls.some((c) => c.startsWith('click'))).toBe(false)
  })

  // Break caught (Ruling 7): lidar touches typing while the keyboard isn't in
  // room-lidar mode (a hover would type ghost letters), and not typing once
  // it is. Aimed at the D key's CENTRE from the layout in mm (stage
  // swipe/layout.ts: keys 44 mm, row 2 staggered half a key, so D spans
  // 110–154 mm across and 44–88 mm down, keys starting 80 mm down the
  // keyboard): 132, 66 + 80. Not its left edge (110, as webBrowsing.test.ts
  // uses for an exact pointer): a lidar finger is a few mm off, and at the edge
  // that is S. A person aims at the centre too.
  it('on the keyboard: types only in room-lidar mode', async () => {
    const { rt, touch } = await rig()
    rt.keyboard.open()
    const kb = rt.surfaces.list().find((s) => s.kind === 'keyboard')!.box
    const d = { x: kb.x + 132 / mmPerPx, y: kb.y + (66 + 80) / mmPerPx }
    await touch([d, d, d])
    expect(rt.keyboard.state()!.text).toBe('')
    expect(rt.keyboardInput.select('room-lidar')).toMatchObject({ mode: 'room-lidar' })
    expect(rt.keyboardInput.acceptsPointer()).toBe(false)
    await touch([d, d, d])
    expect(rt.keyboard.state()!.text).toBe('d')
  })

  // Break caught: room-lidar selectable before the lidar is registered, i.e. a
  // mode that silently never types.
  it('room-lidar is refused without a lidar registration', () => {
    const rt = createRuntime({ overlay: () => {}, autoTick: false })
    rt.keyboard.open()
    try {
      expect(() => rt.keyboardInput.select('room-lidar')).toThrow(/register the lidar/)
    } finally {
      rt.stop()
    }
  })
})

