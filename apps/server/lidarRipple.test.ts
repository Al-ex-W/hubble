import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { expect, it } from 'vitest'
import { DEFAULT_SURFACE, type TouchLine } from '@hubble/stage'
import type { ServerConfig } from './config.ts'
import { createApp } from './index.ts'
import { tableToSensor, wireFrames, withFinger } from './spatial/lidarFixtures.ts'

/*
 * Lidar touch → ripple line, through the real server (#89): the lidar socket
 * on loopback (the device pool never gates loopback), registration and
 * baseline over the operator's HTTP routes, and the display stream a /table
 * page reads. Fixture: the real wire rotations (recording) with a finger put
 * in by mechanical mutation; schema-derived registration (lidarFixtures.ts).
 * Oracle: table mm / mm-per-px, computed here.
 */
const frames = wireFrames()
const mmPerPx = DEFAULT_SURFACE.mmPerPx

/** A display: reads /api/stage/events and collects its data lines. */
async function display(base: string) {
  const ctrl = new AbortController()
  const res = await fetch(`${base}/api/stage/events`, { signal: ctrl.signal })
  const lines: { kind?: string }[] = []
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          if (chunk.startsWith('data: ')) lines.push(JSON.parse(chunk.slice(6)))
        }
      }
    } catch {
      /* aborted */
    }
  })()
  return { lines, close: () => ctrl.abort() }
}

it('a finger on the table reaches every display as one touch line, and is not replayed to a later one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hubble-lidar-'))
  const lidar = new WebSocketServer({ port: 0 })
  await once(lidar, 'listening')
  const config: ServerConfig = {
    port: 0,
    llm: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'aixia-labs' },
    jevApiKey: undefined,
    lidarUrl: `http://127.0.0.1:${(lidar.address() as AddressInfo).port}`,
    spatialRegistrationFile: join(dir, 'registration.json'),
  }
  const app = createApp(config)
  const server = app.listen(0)
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let pump: ReturnType<typeof setInterval> | undefined
  try {
    const [socket] = (await once(lidar, 'connection')) as [WebSocket]
    let t = Date.now()
    const send = (points: unknown) => socket.send(JSON.stringify({ t: (t += 100), points }))
    let i = 0
    pump = setInterval(() => send(frames[i++ % 40].points), 25)

    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const fit = [{ x: 100, y: 100 }, { x: 1450, y: 100 }, { x: 1450, y: 870 }, { x: 100, y: 870 }]
    const check = [{ x: 775, y: 485 }, { x: 400, y: 600 }]
    const px = (p: { x: number; y: number }) => ({ x: p.x / mmPerPx, y: p.y / mmPerPx })
    const reg = await post('/api/spatial/registration', {
      table: fit.map((p) => ({ from: p, to: px(p) })),
      tableCheck: check.map((p) => ({ from: p, to: px(p) })),
      lidar: fit.map((p) => ({ from: tableToSensor(p), to: p })),
      lidarCheck: check.map((p) => ({ from: tableToSensor(p), to: p })),
      maxProjectorErrorPx: 1,
      maxTableErrorMm: 1,
    })
    expect(reg.status).toBe(200)
    const baseline = await post('/api/spatial/baseline', { ms: 1000 })
    expect(await baseline.json()).toMatchObject({ ok: true })
    expect(await (await fetch(`${base}/api/spatial`)).json()).toMatchObject({ touchEnabled: true })

    const table = await display(base)
    await new Promise((r) => setTimeout(r, 50))
    clearInterval(pump)
    const at = { x: 775, y: 400 }
    send(withFinger(frames[50], tableToSensor(at)).points)
    await new Promise((r) => setTimeout(r, 100))
    const touches = table.lines.filter((l): l is TouchLine => l.kind === 'touch')
    // Break caught: anything between the spatial service and the display
    // stream dropping or doubling the ripple, or putting it in the wrong place.
    expect(touches).toHaveLength(1)
    expect(touches[0]).toMatchObject({ phase: 'down' })
    expect(touches[0].p.x).toBeCloseTo(at.x / mmPerPx, -1)
    expect(touches[0].p.y).toBeCloseTo(at.y / mmPerPx, -1)

    // A projector that (re)connects now must not ripple at that old spot.
    const late = await display(base)
    await new Promise((r) => setTimeout(r, 50))
    expect(late.lines.filter((l) => l.kind === 'touch')).toEqual([])
    table.close()
    late.close()
  } finally {
    clearInterval(pump)
    ;(app as unknown as { runtime: { stop(): void } }).runtime.stop()
    server.closeAllConnections()
    server.close()
    for (const ws of lidar.clients) ws.terminate()
    await new Promise<void>((r) => lidar.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  }
})
