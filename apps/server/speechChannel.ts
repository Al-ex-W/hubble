import type { Response } from 'express'
import { MAX_CLIENT_BUFFER_BYTES } from './hub.ts'
import type { TimedWord } from './wordTiming.ts'

/**
 * What the TV's speech bubble listens to: every line the puppet master says,
 * from every session, plus when a turn starts and ends (so a display can show
 * a "thinking" state between the two).
 *
 * Why a channel of its own and not the stage hub: the hub's stream is "what
 * the table shows" and replays an active render to a reconnecting display;
 * speech is a different owner with a different replay rule (the last few
 * lines, not a render). Mixing them would make a table display parse lines it
 * ignores and make the hub know about conversations. Why not the per-turn
 * NDJSON response: that goes only to the client that asked, and the TV is a
 * second, passive screen that never makes a request (the TV rig is not built
 * yet; this is the publishing side only).
 *
 * Fan-out and slow-client policy are hub.ts's: SSE, a comment ping to keep
 * proxies from closing an idle stream, and a display more than
 * MAX_CLIENT_BUFFER_BYTES behind is dropped (EventSource reconnects, and the
 * replay below puts it back on the recent conversation).
 */
export type SpeechLine =
  | { type: 'speech'; id: string; text: string; at: number; /** set only on lines replayed to a (re)connecting display */ replay?: true }
  | { type: 'turn'; phase: 'start' | 'end'; at: number }
  /** The landing page's audio for this line actually started (the browser's 'playing' event). */
  | { type: 'playing'; id: string; startedAt: number; at: number }
  /** Word timings for a line, only ever sent after `playing`. `words` is everything known so far; `done` once the audio stream ended. */
  | { type: 'words'; id: string; words: TimedWord[]; startedAt: number; done: boolean; at: number }
  /** The voice's loudness 0..1 for the TV orb. Never replayed. */
  | { type: 'level'; level: number; at: number }

/** Forward at most one level per this many ms (the TV orb needs ~20 Hz; more is wasted SSE). */
export const LEVEL_MIN_INTERVAL_MS = 50

export function createSpeechChannel(opts: { replay?: number; now?: () => number } = {}) {
  const keep = opts.replay ?? 5
  const now = opts.now ?? Date.now
  const clients = new Set<Response>()
  // Only speech is replayed: a replayed turn-start would leave a reconnecting
  // display "thinking" forever for a turn that ended while it was away.
  const recent: SpeechLine[] = []

  const send = (client: Response, line: SpeechLine) => {
    client.write(`data: ${JSON.stringify(line)}\n\n`)
    if (client.writableLength > MAX_CLIENT_BUFFER_BYTES) {
      clients.delete(client)
      client.destroy()
    }
  }

  const broadcast = (line: SpeechLine) => { for (const client of clients) send(client, line) }
  let lastLevelAt = -Infinity
  let lastLevel = 0

  return {
    /**
     * Word timing for one say line, gated on the browser's `playing` signal.
     * Why gated: timings are offsets from the START OF AUDIO. Until the page
     * that plays it reports that audio started, a TV cannot know what "0 ms"
     * is, and revealing against the moment the speech was published would run
     * ahead of the voice by the whole TTS start-up. Timings that arrive first
     * are held and the latest set is flushed at `playing`.
     *
     * Clock skew: events carry the server's `at` (publish) and `startedAt`
     * (playing). A TV computes elapsed-at-arrival = at - startedAt (two server
     * readings, so no TV clock is involved) and anchors that to its OWN clock
     * at SSE arrival. LAN latency (milliseconds) is the only error.
     */
    timeline(id: string) {
      let startedAt: number | undefined
      let pending: { words: TimedWord[]; done: boolean } | undefined
      const emit = (words: TimedWord[], done: boolean) => broadcast({ type: 'words', id, words, startedAt: startedAt!, done, at: now() })
      return {
        playing() {
          if (startedAt !== undefined) return // a stall/resume fires 'playing' again; the first one is the start
          startedAt = now()
          broadcast({ type: 'playing', id, startedAt, at: startedAt })
          if (pending) { emit(pending.words, pending.done); pending = undefined }
        },
        addWords(words: TimedWord[], done: boolean) {
          if (startedAt === undefined) pending = { words, done }
          else emit(words, done)
        },
      }
    },
    /** One voice-level frame for the TV orb (`at` is when it was measured). Throttled to <= 20 Hz by frame time; the drop to silence always passes so the orb never freezes lit. Not replayed. */
    level(frame: { level: number; at: number }) {
      const silence = frame.level === 0 && lastLevel !== 0
      if (!silence && frame.at - lastLevelAt < LEVEL_MIN_INTERVAL_MS) return
      lastLevelAt = frame.at; lastLevel = frame.level
      broadcast({ type: 'level', level: frame.level, at: frame.at })
    },
    publish(line: { type: 'speech'; id: string; text: string } | { type: 'turn'; phase: 'start' | 'end' }) {
      const full = { ...line, at: now() } as SpeechLine
      if (full.type === 'speech') {
        recent.push(full)
        if (recent.length > keep) recent.shift()
      }
      for (const client of clients) send(client, full)
    },
    /** Pages listening right now (the /api/puppet/instance route reports it). */
    listeners: () => clients.size,
    subscribe(res: Response) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(': connected\n\n')
      // Tagged so a display can show them as history instead of popping a bubble for a line said minutes ago.
      for (const line of recent) send(res, { ...line, replay: true } as SpeechLine)
      clients.add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), 15000)
      res.on('close', () => {
        clearInterval(ping)
        clients.delete(res)
      })
    },
  }
}
export type SpeechChannel = ReturnType<typeof createSpeechChannel>
