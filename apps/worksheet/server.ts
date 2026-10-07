import express from 'express'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createWorksheetState } from './state.ts'
import { loadWorksheetTasks, type WorksheetTask } from './tasks.ts'

/**
 * The iPad worksheet server (hubble#60).
 *
 * Why it exists: on site the room camera can't read a paper worksheet well
 * enough (owner, 7 Oct; aixia-labs can't read small print even from a 4K
 * crop). So the task is shown on an iPad lying on the table instead, from a
 * page we serve, and Hubble knows exactly what it says.
 *
 * Why a separate server and not a route in apps/server or apps/web: the
 * owner asked for it to be "structural", a thing of its own that the main
 * server switches on from the operator page's checkbox (apps/server/
 * worksheet.ts spawns this file). It holds the one piece of state "what is
 * the iPad showing" and nothing else.
 *
 *   GET  /            the iPad page (public/index.html)
 *   GET  /ipad.js     its script (an ES module, also imported by the tests)
 *   GET  /api/state   -> WorksheetView
 *   POST /api/state   { taskId?, textMm? } -> WorksheetView | 400 { error }
 *   GET  /api/events  SSE: the WorksheetView now, then on every change
 *   POST /api/quit    loopback only: lets a restarted main server stop a
 *                     worksheet server it no longer holds the process of
 *
 * Bound to 127.0.0.1 only. The iPad reaches it as :5173/worksheet/, through
 * the web app's Vite proxy (apps/web/worksheetProxy.ts), which forwards
 * reads and refuses writes: the owner wants one port on the room network,
 * :5173, not a port per service. Until 7 Oct it listened on 0.0.0.0:8793 and
 * the iPad opened that directly. The loopback checks below stay as a second
 * line, because every proxied request arrives from loopback too.
 */

const loopback = (from: string | undefined) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(from ?? '')

const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url))
export const DEFAULT_PORT = 8793

export function createWorksheetApp(tasks: WorksheetTask[] = loadWorksheetTasks(), opts: { onQuit?: () => void } = {}) {
  const state = createWorksheetState(tasks)
  const app = express()
  app.use(express.json({ limit: '4kb' }))
  // No caching anywhere: the iPad must never show yesterday's page after a
  // change to it, and Safari caches aggressively on a home-screen web app.
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })
  app.use(express.static(PUBLIC))

  app.get('/api/state', (_req, res) => void res.json(state.get()))
  app.post('/api/state', (req, res) => {
    // Loopback only, like /api/quit: the server listens on the room network,
    // and a change from anywhere but the main server would put a task on the
    // iPad that the brain isn't told about (it remembers its own writes; review
    // round 1). The iPad only ever reads.
    if (!loopback(req.socket.remoteAddress)) return void res.status(403).json({ error: 'loopback only' })
    const r = state.set((req.body ?? {}) as object)
    if (!r.ok) return void res.status(400).json({ error: r.error })
    res.json(r.view)
  })

  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    const send = (v: unknown) => res.write(`data: ${JSON.stringify(v)}\n\n`)
    send(state.get())
    const off = state.onChange(send)
    // iPad Safari and proxies drop a silent connection; a comment line every
    // 15 s (as hub.ts does for the table displays) keeps it open.
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
    req.on('close', () => {
      clearInterval(ping)
      off()
    })
  })

  app.post('/api/quit', (req, res) => {
    // The server listens on the room network; only this laptop may stop it.
    if (!loopback(req.socket.remoteAddress)) return void res.status(403).json({ error: 'loopback only' })
    res.json({ ok: true })
    opts.onQuit?.()
  })

  return Object.assign(app, { state })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.WORKSHEET_PORT ?? DEFAULT_PORT)
  let server: Server | undefined = undefined
  // Exit at once, not after server.close(): close() waits for open
  // connections, and the iPad's SSE stream never ends, so a quit that waited
  // left the old server holding the iPad while a new one took the port
  // (review round 1).
  const app = createWorksheetApp(undefined, { onQuit: () => setImmediate(() => process.exit(0)) })
  server = app.listen(port, '127.0.0.1', () => console.log(`worksheet on 127.0.0.1:${port} (the iPad opens it as :5173/worksheet/)`))
  // SSE connections keep a server open forever; on quit they must not.
  const quit = () => process.exit(0)
  process.once('SIGTERM', quit)
  process.once('SIGINT', quit)
  // Spawned by the main server: die with it. Its stdin is a pipe from the
  // parent, and the pipe ends however the parent dies (tsx watch's SIGTERM
  // on every save, a crash, SIGKILL), where an 'exit' handler in the parent
  // only runs on a clean exit (review round 1: every save leaked a server).
  if (process.env.WORKSHEET_EXIT_WITH_PARENT === '1') {
    process.stdin.on('end', quit)
    process.stdin.on('close', quit)
    process.stdin.resume()
  }
  void server
}
