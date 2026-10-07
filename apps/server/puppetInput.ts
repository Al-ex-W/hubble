import type { Response } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { MAX_CLIENT_BUFFER_BYTES } from './hub.ts'

/**
 * Typed text from Julius's inputs on its way to the puppet master.
 *
 * Owner, 7 Oct 2026: "pinch typing will be updated, but what's written there
 * will be fed to puppet master." The projected keyboard's SEND (and the pinch
 * typing that ends in the same SEND) used to ask Julius's brain or table
 * agent. Now it publishes here, and the landing page, which is the one place
 * that can play the puppet master's speech, turns each input into a normal
 * typed turn (usePuppetAssistant({ followTableInput: true })).
 *
 * Why a browser has to drive the turn: the `say` tool waits for a browser to
 * acknowledge playback (puppetMaster.ts), so a turn without a listening page
 * would just time out after 45 s. The server cannot run it alone.
 *
 * Replay rule (the "~10 s"): an input published while NO page listens is
 * held for 10 s and handed to the next subscriber once. That covers the
 * landing page reconnecting its EventSource at the moment of a SEND, without
 * the opposite failure: a page reload replaying an input that was already
 * turned into a turn (so it would be asked twice). Anything older is dropped:
 * answering a sentence typed a minute ago, out of the blue, is worse than
 * losing it.
 *
 * One page only (owner's rig, 7 Oct 2026): each input goes to exactly ONE
 * page, the most recently connected. Every landing page that follows table
 * input runs its own turn, so with two `/` tabs open (a laptop browser and a
 * second pane) one keyboard SEND produced two different answers, spoken on
 * the real TVs. A new subscriber takes over; the older ones get one
 * `{type:'superseded'}` event and are then not written to again. Their
 * connection is deliberately NOT closed by us: closing would make
 * EventSource reconnect, win the "newest" slot back and the two pages would
 * steal the conversation from each other forever. The page itself closes
 * its stream on `superseded` (usePuppetAssistant).
 */
export type InputFrom = 'keyboard' | 'pinch' | 'chat' | 'operator'
/** Told to a page that another page took over (see the "one page" rule above). */
export type PuppetInputSuperseded = { type: 'superseded'; at: number }
export type PuppetInput = { type: 'input'; id: string; text: string; from: InputFrom; at: number }

export const MAX_INPUT_CHARS = 2000
export const INPUT_REPLAY_MS = 10_000
const FROM = ['keyboard', 'pinch', 'chat', 'operator'] as const
const Body = z.object({ text: z.string().trim().min(1).max(MAX_INPUT_CHARS), from: z.enum(FROM).default('chat') })

export function createPuppetInputChannel(opts: { now?: () => number; replayMs?: number } = {}) {
  const now = opts.now ?? Date.now
  const replayMs = opts.replayMs ?? INPUT_REPLAY_MS
  const clients = new Set<Response>()
  let held: PuppetInput[] = []

  const send = (client: Response, input: PuppetInput) => {
    client.write(`data: ${JSON.stringify(input)}\n\n`)
    if (client.writableLength > MAX_CLIENT_BUFFER_BYTES) { clients.delete(client); client.destroy() }
  }

  function publish(text: string, from: InputFrom): { id: string; delivered: boolean } {
    const input: PuppetInput = { type: 'input', id: randomUUID(), text, from, at: now() }
    const delivered = clients.size > 0
    if (delivered) for (const c of clients) send(c, input) // `clients` holds only the newest page
    else held = [...held.filter(h => now() - h.at <= replayMs), input].slice(-5)
    return { id: input.id, delivered }
  }

  return {
    publish,
    /** A landing page is listening right now (merge, 7 Oct: index.ts's seam falls back to the table agent when none is, so SEND is never lost). */
    hasListener: () => clients.size > 0,
    listeners: () => clients.size,
    /** The HTTP body's validation lives here, so the route and tests share it. */
    publishChecked(body: unknown): { ok: true; id: string; delivered: boolean } | { ok: false; error: string } {
      const p = Body.safeParse(body)
      if (!p.success) return { ok: false, error: `Provide { text } of 1 to ${MAX_INPUT_CHARS} characters; from is one of ${FROM.join(', ')}.` }
      return { ok: true, ...publish(p.data.text, p.data.from) }
    },
    subscribe(res: Response) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(': connected\n\n')
      const fresh = held.filter(h => now() - h.at <= replayMs)
      held = []
      for (const h of fresh) send(res, h)
      // The newest page takes over: tell every older one, then forget it (not close it, see above).
      for (const old of [...clients]) {
        old.write(`data: ${JSON.stringify({ type: 'superseded', at: now() } satisfies PuppetInputSuperseded)}\n\n`)
        clients.delete(old)
      }
      clients.add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), 15000)
      res.on('close', () => { clearInterval(ping); clients.delete(res) })
    },
  }
}
export type PuppetInputChannel = ReturnType<typeof createPuppetInputChannel>
