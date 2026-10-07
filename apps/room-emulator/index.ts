import { createServer } from 'node:http'
import express from 'express'
import jpeg from 'jpeg-js'
import { WebSocketServer, type WebSocket } from 'ws'
import { simulateScan, type DisplayCommand, type DisplayId, type LightCommand, type RoomInfo, type SimShape, type SlotInfo } from '@hubble/room'

/**
 * The Aixia room, as its spec describes it, on our laptop.
 *
 * Exists so every hardware path (display commands, the projector page, lidar,
 * camera, buttons, lights, slots, auth, 423) runs end to end before the room
 * does. It implements the spec's endpoints and semantics and nothing more;
 * sensor data comes from a scene the bench posts (`/emulator/*`), so the
 * emulator owns physical ground truth and never shares it with perception.
 *
 * Deliberately lean: one C1 model (packages/room/src/simulate.ts), the bench's
 * frames as the camera, no physics beyond that.
 */
const PORT = Number(process.env.EMULATOR_PORT ?? 8790)
const TOKEN = process.env.EMULATOR_TOKEN ?? 'dev-token'
const TEAM = process.env.EMULATOR_TEAM ?? 'hubble'

// ---- state ----------------------------------------------------------------
const info: RoomInfo = {
  displays: [
    { id: 'table', width: 1920, height: 1080 },
    { id: 'tv-1', width: 1920, height: 1080 },
    { id: 'tv-2', width: 1920, height: 1080 },
  ],
  lights: ['spot-1', 'spot-2', 'spot-3', 'spot-4', 'spot-5', 'spot-6', 'spot-7', 'spot-8', 'strip-tv-1', 'strip-tv-2'].map((id) => ({ id, kind: id.startsWith('strip') ? 'strip' : 'spot' })),
  // Middle of the back edge, looking into the table (spec default mount).
  lidar: { x: 750, y: 5, rotation: 0 },
  table: { width: 1500, height: 1500 },
}
let slots: SlotInfo[] = [{ team: TEAM, from: new Date(Date.now() - 3600_000).toISOString(), until: new Date(Date.now() + 8 * 3600_000).toISOString() }]
const displays: Partial<Record<DisplayId, DisplayCommand>> = {}
const lights: Record<string, LightCommand> = {}
let shapes: SimShape[] = []
let pitchDeg = 0
let frame: Buffer = blankJpeg()
const lightTimes: number[] = []

// Things beyond the table the real lidar sees too: TV stands and a person.
const SURROUNDINGS: SimShape[] = [
  { kind: 'rect', x: -650, y: 600, w: 60, h: 300, heightMm: 900 },
  { kind: 'rect', x: 2090, y: 600, w: 60, h: 300, heightMm: 900 },
  { kind: 'rect', x: 600, y: 1650, w: 300, h: 250, heightMm: 1700 },
]

function blankJpeg(): Buffer {
  const w = 320
  const h = 180
  const data = Buffer.alloc(w * h * 4, 12)
  return Buffer.from(jpeg.encode({ width: w, height: h, data }, 70).data)
}

const ourSlot = () => slots.some((s) => s.team === TEAM && Date.parse(s.from) <= Date.now() && Date.now() < Date.parse(s.until))
const nextSlot = () => slots.filter((s) => s.team === TEAM && Date.parse(s.from) > Date.now()).sort((a, b) => Date.parse(a.from) - Date.parse(b.from))[0] ?? null

// ---- app -------------------------------------------------------------------
const app = express()
app.use(express.json({ limit: '20mb' }))
app.use(express.raw({ type: 'image/jpeg', limit: '20mb' }))

// The bench (our own control channel) needs no token; the spec API does.
const bench = new Set<express.Response>()
const pushBench = () => {
  const msg = `data: ${JSON.stringify({ displays, lights, slots, ourSlot: ourSlot() })}\n\n`
  for (const r of bench) r.write(msg)
}

app.use('/api', (req, res, next) => {
  const ok = req.headers.authorization === `Bearer ${TOKEN}` || req.query.token === TOKEN
  if (!ok) return void res.status(401).json({ error: 'missing or wrong team token' })
  next()
})
app.get('/api/room', (_req, res) => res.json({ ...info, slot: slots.find((s) => Date.parse(s.from) <= Date.now() && Date.now() < Date.parse(s.until)) ?? null }))
app.get('/api/slots', (_req, res) => res.json(slots))
app.get('/api/camera/frame', (_req, res) => res.type('image/jpeg').send(frame))
app.get('/api/camera/stream', (req, res) => {
  // MJPEG: the same multipart stream an <img> tag and OpenCV read.
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-cache' })
  const send = () => res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`) && res.write(frame) && res.write('\r\n')
  const t = setInterval(send, 1000 / 15)
  req.on('close', () => clearInterval(t))
})
const writeGate: express.RequestHandler = (_req, res, next) => {
  if (!ourSlot()) return void res.status(423).json({ error: 'not your slot', next_slot: nextSlot() })
  next()
}
app.post('/api/displays/:id', writeGate, (req, res) => {
  const id = req.params.id as DisplayId
  if (!info.displays.some((d) => d.id === id)) return void res.status(404).json({ error: `no display ${id}` })
  displays[id] = req.body as DisplayCommand
  pushBench()
  res.json({ ok: true })
})
const hueGate: express.RequestHandler = (_req, res, next) => {
  // The Hue bridge behind the room: about 10 light commands a second.
  const now = Date.now()
  while (lightTimes.length && now - lightTimes[0] > 1000) lightTimes.shift()
  if (lightTimes.length >= 10) return void res.status(429).set('Retry-After', '1').json({ error: 'hue rate limit' })
  lightTimes.push(now)
  next()
}
app.post('/api/lights/scene', writeGate, hueGate, (req, res) => {
  lights.__scene = { on: true, color: String((req.body as { scene?: string }).scene ?? '') }
  pushBench()
  res.json({ ok: true })
})
app.post('/api/lights/:id', writeGate, hueGate, (req, res) => {
  lights[req.params.id] = { ...lights[req.params.id], ...(req.body as LightCommand) }
  pushBench()
  res.json({ ok: true })
})

// ---- bench control ------------------------------------------------------------
app.get('/emulator/state', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  bench.add(res)
  pushBench()
  req.on('close', () => bench.delete(res))
})
app.post('/emulator/scene', (req, res) => {
  const b = req.body as { shapes?: SimShape[]; pitchDeg?: number }
  shapes = Array.isArray(b.shapes) ? b.shapes.slice(0, 50) : []
  pitchDeg = Number.isFinite(b.pitchDeg) ? Number(b.pitchDeg) : pitchDeg
  res.json({ ok: true })
})
app.post('/emulator/camera', (req, res) => {
  if (Buffer.isBuffer(req.body) && req.body.length > 100) frame = req.body
  res.json({ ok: true })
})
app.post('/emulator/button', (req, res) => {
  broadcast(events, { type: 'button', id: String((req.body as { id?: string }).id ?? 'hue-button-1'), action: 'press' })
  res.json({ ok: true })
})
app.post('/emulator/slot', (req, res) => {
  // Hand the room to another team (or back): exercises 423 and the reset.
  const team = String((req.body as { team?: string }).team ?? TEAM)
  const until = new Date(Date.now() + Number((req.body as { minutes?: number }).minutes ?? 30) * 60_000).toISOString()
  slots = [{ team, from: new Date().toISOString(), until }]
  if (team !== TEAM) {
    // Spec: at slot end the room resets displays to idle and lights to default.
    for (const k of Object.keys(displays)) delete displays[k as DisplayId]
    for (const k of Object.keys(lights)) delete lights[k]
  }
  broadcast(events, { type: 'slot', team, until })
  pushBench()
  res.json({ ok: true })
})

// ---- sockets -------------------------------------------------------------------
const server = createServer(app)
const lidar = new Set<WebSocket>()
const events = new Set<WebSocket>()
const draws = new Map<WebSocket, DisplayId>()
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.searchParams.get('token') !== TOKEN) return void socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === '/api/lidar/scan') lidar.add(ws)
    else if (url.pathname === '/api/events') events.add(ws)
    else if (/^\/api\/displays\/[\w-]+\/draw$/.test(url.pathname)) draws.set(ws, url.pathname.split('/')[3] as DisplayId)
    else return void ws.close()
    ws.on('close', () => (lidar.delete(ws), events.delete(ws), draws.delete(ws)))
    ws.on('message', (m) => {
      const id = draws.get(ws)
      if (id && ourSlot()) {
        displays[id] = { type: 'image', data: `draw:${m.toString().slice(0, 50_000)}` }
        pushBench()
      }
    })
  })
})
function broadcast(set: Set<WebSocket>, msg: unknown) {
  const s = JSON.stringify(msg)
  for (const ws of set) if (ws.readyState === 1) ws.send(s)
}

// The C1 spins at about 10 Hz: one scan per rotation, like the real socket.
let seed = 1
setInterval(() => {
  if (!lidar.size) return
  // Unref'd below so tests and dev shutdowns aren't held open by the spinner.
  broadcast(lidar, simulateScan([...SURROUNDINGS, ...shapes], { pose: info.lidar, pitchDeg, seed: seed++ }))
}, 100).unref()

/** Tests start it on a free port; `npm run dev:emulator` runs it directly. */
export function startEmulator(port = PORT): Promise<{ url: string; token: string; team: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = server.listen(port, '0.0.0.0', () => {
      const p = (s.address() as { port: number }).port
      resolve({ url: `http://127.0.0.1:${p}`, token: TOKEN, team: TEAM, close: () => s.close() })
    })
  })
}

if (process.argv[1]?.endsWith('room-emulator/index.ts')) {
  void startEmulator().then((e) => console.log(`room emulator on ${e.url} (token ${e.token}, team ${e.team})`))
}
