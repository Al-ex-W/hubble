import type { RenderRequest, RenderStreamLine, Scene, StageEvent } from '@hubble/stage'

/**
 * One render attempt from POST /api/render, as the debug/chat UI sees it.
 * `raw` is the model's verbatim text; `events` are the parsed stage events the
 * table would receive.
 */
export interface RenderRun {
  renderId: string
  request: RenderRequest
  /**
   * The table this run was rendered for, from its `start` line. Replays must
   * use it: the bench's live scene may have changed since (objects dragged or
   * toggled), and object-relative marks would then land on the wrong things.
   */
  scene?: Scene
  events: StageEvent[]
  raw: string
  status: 'streaming' | 'done' | 'error'
  error?: string
  firstContentMs: number | null
  totalMs: number | null
  answer?: string
  drops: StageEvent[]
  /** Arrival time (ms) parallel to `events`, so the debug tab can show `t`. */
  eventTimeMs: number[]
  /** The brain's loop steps (draft, verify, edit), for the agent tab. */
  trace: Extract<RenderStreamLine, { kind: 'trace' }>[]
}

/**
 * Everything one call to run() owns. Before this existed the request, the
 * line buffer and the "active render id" were single shared refs, so a
 * replacement request could (a) commit the old stream's buffered lines under
 * the new request and (b) leave the old run spinning forever, because the old
 * attempt's cancel handler read an id the new attempt had already reset.
 * Keeping them per attempt makes each stream's lines and its ending land on
 * its own run, whatever order the two streams finish in.
 */
interface Attempt {
  request: RenderRequest
  pending: RenderStreamLine[]
  renderId: string | null
  controller: AbortController
}

export interface RenderClientDeps {
  fetch?: typeof fetch
  /**
   * Batches stream lines into one state update. The browser uses
   * requestAnimationFrame: at ~350 tokens/s a per-line React render would
   * dominate the main thread. Tests pass a timer.
   */
  schedule?: (flush: () => void) => void
}

/** Follow-ups carry only the last few turns: enough context, bounded payload. */
const MAX_HISTORY = 4

/**
 * The bench's render state, kept out of React so the stream handling (where
 * the races live) can be tested in node against recorded streams. useRender
 * subscribes to it.
 */
export function createRenderClient(deps: RenderClientDeps = {}) {
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const schedule = deps.schedule ?? ((flush: () => void) => void requestAnimationFrame(flush))
  let runs: RenderRun[] = []
  const listeners = new Set<() => void>()
  const dirty = new Set<Attempt>()
  let scheduled = false
  let latest: Attempt | null = null

  const setRuns = (next: RenderRun[]) => {
    runs = next
    for (const l of listeners) l()
  }
  const flush = () => {
    scheduled = false
    if (dirty.size === 0) return
    let next = runs
    for (const attempt of dirty) {
      next = applyLines(next, attempt.pending, attempt.request)
      attempt.pending = []
    }
    dirty.clear()
    setRuns(next)
  }
  /** End an attempt: settle its run if it never got to `done`. */
  const finish = (attempt: Attempt, error: string | null) => {
    flush()
    if (error === null) return
    if (attempt.renderId) {
      setRuns(runs.map((r) => (r.renderId === attempt.renderId && r.status === 'streaming' ? { ...r, status: 'error', error } : r)))
      return
    }
    // It failed before any `start` line, so there is no server id to settle.
    if (error === 'cancelled') return
    setRuns([...runs, { ...emptyRun(`local-${Date.now().toString(36)}`, attempt.request), status: 'error', error }])
  }

  return {
    getRuns: () => runs,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    cancel() {
      latest?.controller.abort()
    },
    run(req: RenderRequest) {
      latest?.controller.abort()
      const history = req.history ?? historyFrom(runs)
      const request: RenderRequest = history.length > 0 ? { ...req, history } : req
      const attempt: Attempt = { request, pending: [], renderId: null, controller: new AbortController() }
      latest = attempt
      const { signal } = attempt.controller

      void (async () => {
        try {
          const res = await doFetch('/api/render', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
            signal,
          })
          if (!res.ok) throw new Error(`render failed (${res.status})`)
          if (!res.body) throw new Error('render response has no stream body')
          await readNdjson(
            res.body,
            (line) => {
              if (line.kind === 'start') attempt.renderId = line.renderId
              attempt.pending.push(line)
              dirty.add(attempt)
              if (!scheduled) {
                scheduled = true
                schedule(flush)
              }
            },
            signal,
          )
          // Fetch ended while the run still looked live: surface it instead of hanging.
          finish(attempt, signal.aborted ? 'cancelled' : 'stream ended without done')
        } catch (err) {
          finish(attempt, signal.aborted ? 'cancelled' : err instanceof Error ? err.message : 'render failed')
        }
      })()
    },
  }
}

function historyFrom(runs: RenderRun[]): { intent: string; answer: string }[] {
  return runs
    .filter((r) => r.status === 'done' && typeof r.answer === 'string')
    .slice(-MAX_HISTORY)
    .map((r) => ({ intent: r.request.intent, answer: r.answer as string }))
}

function emptyRun(renderId: string, request: RenderRequest): RenderRun {
  return { renderId, request, events: [], raw: '', status: 'streaming', firstContentMs: null, totalMs: null, drops: [], eventTimeMs: [], trace: [] }
}

/** Apply one attempt's batch of stream lines to the run list, creating its run on `start`. */
function applyLines(runs: RenderRun[], lines: RenderStreamLine[], request: RenderRequest): RenderRun[] {
  if (lines.length === 0) return runs
  const next = runs.slice()
  const index = new Map(next.map((r, i) => [r.renderId, i]))
  for (const line of lines) {
    const at = index.get(line.renderId)
    if (at === undefined) {
      if (line.kind !== 'start') continue
      next.push({ ...emptyRun(line.renderId, request), scene: line.scene ?? request.scene })
      index.set(line.renderId, next.length - 1)
      continue
    }
    next[at] = applyLine(next[at], line)
  }
  return next
}

function applyLine(run: RenderRun, line: RenderStreamLine): RenderRun {
  switch (line.kind) {
    case 'start':
      return { ...run, status: 'streaming' }
    case 'raw':
      return { ...run, raw: run.raw + line.text }
    case 'event': {
      const event = line.event
      const isContent = event.type === 'open' || event.type === 'text' || event.type === 'piece'
      return {
        ...run,
        events: [...run.events, event],
        eventTimeMs: [...run.eventTimeMs, line.t],
        firstContentMs: run.firstContentMs ?? (isContent ? line.t : null),
        drops: event.type === 'drop' ? [...run.drops, event] : run.drops,
      }
    }
    case 'trace':
      return { ...run, trace: [...run.trace, line] }
    case 'error':
      return { ...run, status: 'error', error: line.message, totalMs: line.t }
    case 'done':
      // A `done` after an `error` (the server's superseded/failed shape) must
      // not flip the run back to a success with an empty answer.
      if (run.status === 'error') return run
      return {
        ...run,
        status: 'done',
        answer: line.answer,
        firstContentMs: line.firstContentMs ?? run.firstContentMs,
        totalMs: line.t,
      }
  }
}

/** NDJSON reader that tolerates a JSON object split across chunk boundaries. */
async function readNdjson(
  body: ReadableStream<Uint8Array>,
  onLine: (line: RenderStreamLine) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const text = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (text) onLine(JSON.parse(text) as RenderStreamLine)
        nl = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    const tail = buffer.trim()
    if (tail && !signal.aborted) onLine(JSON.parse(tail) as RenderStreamLine)
  } finally {
    reader.releaseLock()
  }
}
