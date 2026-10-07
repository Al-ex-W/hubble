import type { Express, Response } from 'express'
import { isProjectorMode, type ProjectorMode, type ProjectorModeState } from '../web/src/studio/projectorMode.ts'

/**
 * What the projector shows, held by the server (in memory).
 *
 * Why here: the projector page is a kiosk nobody can click and a reload loses
 * the running studio components, so the mode is switched remotely (the bench's
 * Setup tab, the studio, or a curl) and the projector follows over SSE. In
 * memory is enough: a server restart (tsx watch restarts on every save) means
 * `canvas`, which is the safe default for a table that must not be left
 * showing a test pattern to visitors.
 */
export function createProjectorModeStore(now: () => Date = () => new Date()) {
  let state: ProjectorModeState = { mode: 'canvas', since: now().toISOString() }
  const listeners = new Set<Response>()
  const publish = () => { for (const response of listeners) response.write(`data: ${JSON.stringify(state)}\n\n`) }
  return {
    get: () => state,
    set(mode: ProjectorMode) {
      // Only a real change moves `since` and wakes subscribers: re-POSTing the
      // current mode must not re-stamp the legend the person is photographing.
      if (mode === state.mode) return state
      state = { mode, since: now().toISOString() }
      publish()
      return state
    },
    subscribe(response: Response) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      response.write(`data: ${JSON.stringify(state)}\n\n`)
      listeners.add(response)
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000)
      response.on('close', () => { clearInterval(heartbeat); listeners.delete(response) })
    },
  }
}

export function mountProjectorMode(app: Express, store = createProjectorModeStore()) {
  app.get('/api/projector/mode', (_req, res) => res.json(store.get()))
  app.get('/api/projector/events', (_req, res) => store.subscribe(res))
  app.post('/api/projector/mode', (req, res) => {
    const mode = (req.body as { mode?: unknown } | undefined)?.mode
    // Validated against the shared list: an unknown mode must never reach the
    // projector, where it would render as an unexplained blank or stale page.
    if (!isProjectorMode(mode)) return res.status(400).json({ error: "mode must be 'canvas' or 'calibrate'." })
    res.json(store.set(mode))
  })
  return store
}
