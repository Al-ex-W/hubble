import type { Express, Response } from 'express'

/**
 * Where the operator is on the control panel, so TV 1's mirror can follow it.
 *
 * Owner, 7 Oct: "when i navigate around the control panel that is on one tv".
 * The mirror (/?mirror=1 on TV 1) is the SAME OperatingSurface drawn from this
 * state, with no input of its own; the operator's real browser publishes here.
 *
 * Why the latest POST simply wins, with no leader election: "exactly one
 * operator page leads, the most recent one to interact". A page posts on every
 * interaction, so the last poster IS the most recent to interact. A mirror
 * never posts (the client checks), so it can't steal the lead.
 *
 * Why the server holds it at all and not BroadcastChannel: the TV is another
 * machine (the room's Pi kiosk), so the state has to cross the network.
 * In memory only: after a server restart the mirror shows Show mode until the
 * operator next clicks, which is a fine default for a TV in a room of visitors.
 */
export type OperatorUi = {
  mode: 'show' | 'setup'
  /** ShowSteps' active step id, or null. */
  step: string | null
  /** That step's status line (running / done / error and its text), so the TV shows what the laptop shows. */
  stepPhase: string | null
  stepText: string | null
  /** Show's "More" drawer open. */
  more: boolean
  /** The activity feed's filter, when that feed exists (feat/show-feed); free-form so this needs no change then. */
  feed: string | null
  /** Which page last published (random per tab), so a page can tell it leads. */
  leader: string | null
  at: string
}

const INITIAL: OperatorUi = { mode: 'show', step: null, stepPhase: null, stepText: null, more: false, feed: null, leader: null, at: new Date(0).toISOString() }

/** Validates a POST body into a full state; null if it is not one. */
export function parseOperatorUi(body: unknown, now: Date): OperatorUi | null {
  const b = (body ?? {}) as Record<string, unknown>
  if (b.mode !== 'show' && b.mode !== 'setup') return null
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null)
  return { mode: b.mode, step: str(b.step, 64), stepPhase: str(b.stepPhase, 16), stepText: str(b.stepText, 500), more: b.more === true, feed: str(b.feed, 64), leader: str(b.leader, 64), at: now.toISOString() }
}

export function mountOperatorUi(app: Express, now: () => Date = () => new Date()) {
  let state = INITIAL
  const listeners = new Set<Response>()
  app.get('/api/operator/ui', (_req, res) => res.json(state))
  app.get('/api/operator/ui/events', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(`data: ${JSON.stringify(state)}\n\n`)
    listeners.add(res)
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
    res.on('close', () => {
      clearInterval(heartbeat)
      listeners.delete(res)
    })
  })
  app.post('/api/operator/ui', (req, res) => {
    const next = parseOperatorUi(req.body, now())
    if (!next) return void res.status(400).json({ error: "mode must be 'show' or 'setup'" })
    state = next
    for (const l of listeners) l.write(`data: ${JSON.stringify(state)}\n\n`)
    res.json(state)
  })
}
