/**
 * Smoke test for the `hubble` CLI against a fake server (fixture: synthetic,
 * a stand-in Express app that records what it was asked). The real routes are
 * covered by the server's own tests; this only proves the CLI's contract:
 * the right request goes out, JSON comes back on stdout, an HTTP error is a
 * non-zero exit carrying the server's text, and help can't drift from the table.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildLayout, keyboardMmFromTable } from '@hubble/stage/swipe'

const CLI = new URL('./index.ts', import.meta.url).pathname
const seen: { method: string; path: string; body: unknown }[] = []
const KB_BOX = { x: 400, y: 600, w: 880, h: 320 }
let server: Server
let url = ''

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => (seen.push({ method: req.method, path: req.url, body: req.body }), next()))
  app.get('/api/health', (_q, r) => r.json({ ok: true }))
  app.get('/api/operator/status', (_q, r) => r.json({ act: 'math' }))
  app.get('/api/spatial', (_q, r) => r.json({ state: 'running', calibrated: true, lidar: { touches: [{ id: 1 }], baseline: { state: 'ready' } }, camera: { state: 'receiving', fingers: [] }, surfaces: [] }))
  app.get('/api/devices', (_q, r) => r.json({ connections: [] }))
  app.post('/api/operator/room', (q, r) => r.json({ armed: q.body.armed }))
  app.post('/api/lesson/start', (_q, r) => r.status(404).json({ error: 'unknown song; try ode-to-joy' }))
  app.get('/api/surfaces', (_q, r) => r.json({ kind: 'surfaces', rev: 1, surfaces: [{ id: 'keyboard', kind: 'keyboard', box: KB_BOX }] }))
  app.post('/api/keyboard/stroke', (_q, r) => r.json({ hit: true }))
  await new Promise<void>((done) => (server = app.listen(0, '127.0.0.1', done)))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((done) => server.close(() => done())))

function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) =>
    execFile(process.execPath, ['--import', 'tsx', CLI, ...args], { env: { ...process.env, HUBBLE_URL: url } }, (e, out, err) => done({ code: e ? (e.code as number) : 0, out, err })),
  )
}

describe('hubble CLI', () => {
  // Catches: status losing a part, or the window line, or printing non-JSON.
  it('status combines health, operator, spatial summary, devices and the window', async () => {
    const r = await run('status')
    expect(r.code).toBe(0)
    const s = JSON.parse(r.out)
    expect(s.health).toEqual({ ok: true })
    expect(s.operator).toEqual({ act: 'math' })
    expect(s.spatial).toMatchObject({ state: 'running', lidar: { touches: 1 } })
    expect(s.devices).toEqual({ connections: [] })
    expect(typeof s.window.open).toBe('boolean')
  }, 20_000)

  // Catches: arm sending the wrong field, or dropping the shared-room warning.
  it('arm on posts { armed: true } and warns on stderr', async () => {
    const r = await run('arm', 'on')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toEqual({ armed: true })
    expect(seen.at(-1)).toMatchObject({ method: 'POST', path: '/api/operator/room', body: { armed: true } })
    expect(r.err).toMatch(/SHARED room/)
  }, 20_000)

  // Catches: a 4xx exiting 0, or the server's reason being swallowed.
  it('an HTTP error exits non-zero with the server\'s error text', async () => {
    const r = await run('lesson', 'start', 'nope')
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/404.*unknown song; try ode-to-joy/)
  }, 20_000)

  // Catches: keys tapped off the drawn keyboard (wrong box maths). Oracle:
  // stage's own keyAt over the posted point, i.e. which key the server's
  // reducer would see.
  it('keyboard type taps each key at its centre inside the live box', async () => {
    seen.length = 0
    const r = await run('keyboard', 'type', 'hi', 'x')
    expect(r.code).toBe(0)
    const layout = buildLayout()
    const hit = seen.filter((s) => s.path === '/api/keyboard/stroke').map((s) => layout.keyAt(keyboardMmFromTable(KB_BOX, (s.body as { points: { x: number; y: number }[] }).points[0]!))?.id)
    expect(hit).toEqual(['h', 'i', 'space', 'x'])
  }, 20_000)

  // Catches: a command added to the table without showing in help. Oracle: a
  // regex over the source (a command row is a name followed by usage/summary/room,
  // which the stream sources' { name, path } are not), not the CLI's own table.
  it('help lists every command in the table', async () => {
    const names = [...readFileSync(CLI, 'utf8').matchAll(/^\s+(?:\{ )?name: '([^']+)',\s*(?:usage|summary|room):/gm)].map((m) => m[1]!)
    expect(names.length).toBeGreaterThan(50)
    const r = await run('help')
    for (const n of names) expect(r.out).toContain(`  ${n}`)
  }, 20_000)
})
