import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createPiRoom } from '@hubble/room'
import type { ServerConfig } from './config.ts'
import { createApp } from './index.ts'
import { createRuntime } from './runtime.ts'

/**
 * ROOM=live from the operator's switch to the Pi, over real HTTP: the real
 * runtime, routes and Pi transport, with stand-in Pis. Fixtures: the display
 * /status bodies are recordings (packages/room/fixtures/pis, 7 Oct); the
 * /show body shape is schema-derived (display/README.md).
 *
 * The break it guards: Hubble taking the shared projector at boot. On 7 Oct
 * the real projector was showing another laptop's page; a /show from us
 * would have taken it (owner's rule: no writes without the owner's go).
 */
const config: ServerConfig = { agentId: undefined, port: 0, llm: { baseUrl: 'https://llm.invalid/v1', apiKey: '', model: 'aixia-labs' }, jevApiKey: undefined } as ServerConfig
const status = JSON.parse(readFileSync(new URL('../../packages/room/fixtures/pis/pi-projector-status.json', import.meta.url), 'utf8'))

const open: Server[] = []
afterEach(() => {
  for (const s of open.splice(0)) s.close()
})
async function listen(handler: Parameters<typeof createServer>[1]) {
  const s = createServer(handler)
  s.listen(0, '127.0.0.1')
  open.push(s)
  await new Promise((r) => s.once('listening', r))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}

describe('room output on the real room', () => {
  it('sends nothing until armed, puts our table page up on arming, and stops on disarming', async () => {
    const shows: string[] = []
    const projector = await listen((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/show') shows.push(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(req.url === '/status' ? status : {}))
      })
    })
    const room = createPiRoom({ hosts: { table: projector, 'tv-1': 'http://127.0.0.1:9', 'tv-2': 'http://127.0.0.1:9', hue: 'http://127.0.0.1:9' }, lidarPose: { x: 775, y: 0, rotation: 90 } })
    const app = createApp(config, { room, runtime: (ch) => createRuntime({ ...ch, room, requireArm: true, publicBase: 'http://192.168.42.18:5173', autoTick: false, calibrationFile: '/nonexistent/c.json' }) })
    const base = await listen(app)
    const post = async (path: string, body: unknown) => (await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()

    await app.runtime.start({ table: 'table' })
    expect(shows).toEqual([])
    expect((await (await fetch(`${base}/api/operator/status`)).json()).output).toEqual({ room: 'live', requiresArm: true, active: false })

    expect(await post('/api/operator/room', { armed: true })).toMatchObject({ active: true })
    await new Promise((r) => setTimeout(r, 50))
    expect(shows).toEqual(['{"url":"http://192.168.42.18:5173/table"}'])

    expect(await post('/api/operator/room', { armed: false })).toMatchObject({ active: false })
    await app.runtime.start({ table: 'table' })
    expect(shows).toHaveLength(1)
  })
})
