/**
 * The Show activity feed's store and its channel readers (owner, 7 Oct: "all
 * channels that is going in so we can see what is happening").
 *
 * Why a module store and not React state: a busy demo can push dozens of lines
 * a second (MIDI, gestures, spatial). Keeping the log outside React and reading
 * it with useSyncExternalStore means only <ActivityFeed> re-renders per line,
 * never ShowView or the steps. One EventSource per channel is opened by the
 * first mounted feed and closed by the last (ref-counted), so Show/Setup
 * switching never stacks connections.
 *
 * Deliberately NOT subscribed: /api/puppet/input/events. That channel keeps
 * ONE listener and tells older ones they are "superseded" (puppetInput.ts), so
 * a second subscriber here would steal keyboard SEND from the puppet master.
 * Typed input still shows up, as the assistant's user turn (ActivityFeed logs
 * the hook's turns).
 *
 * Summaries are deliberately lossy one-liners: this is for a person glancing
 * mid-demo, not a debugger (the bench's debug drawer has the raw events).
 */

export const CHANNELS = ['stage', 'assistant', 'input', 'spatial', 'operator', 'error'] as const
export type Channel = (typeof CHANNELS)[number]
export interface FeedLine {
  id: number
  at: number
  channel: Channel
  text: string
}

export const MAX_LINES = 300

type Listener = () => void

export function createFeed(max = MAX_LINES) {
  let lines: FeedLine[] = []
  let nextId = 1
  const listeners = new Set<Listener>()
  return {
    /**
     * Inserted by time, not appended: sources arrive on their own sockets and
     * the operator poll is up to 2 s late, so append order is not event order.
     * Most lines are newest, so the scan from the end is O(1) in practice.
     */
    push(channel: Channel, text: string, at = Date.now()) {
      const line = { id: nextId++, at, channel, text }
      let i = lines.length
      while (i > 0 && lines[i - 1]!.at > at) i--
      const next = [...lines.slice(0, i), line, ...lines.slice(i)]
      lines = next.length > max ? next.slice(next.length - max) : next
      for (const l of listeners) l()
    },
    lines: () => lines,
    subscribe(l: Listener) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
}
export type Feed = ReturnType<typeof createFeed>

/** The page's one feed. */
export const feed = createFeed()

// ---------------------------------------------------------------- summaries

type Obj = Record<string, unknown>
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** One /api/stage/events line → text, or null for the noisy per-piece events. */
export function stageText(line: unknown): string | null {
  const l = o(line)
  switch (l.type) {
    case 'start':
      return `answer started${typeof l.question === 'string' ? `: ${clip(l.question, 60)}` : ''}`
    case 'done':
      return 'answer done'
    case 'error':
      return `answer failed: ${clip(String(l.message ?? l.error ?? ''))}`
    case 'overlay': {
      const layer = String(l.layer ?? 'overlay')
      const keys = Array.isArray(l.keys) ? l.keys.length : null
      return `overlay ${layer}${keys !== null ? ` · ${keys} keys` : ''}`
    }
    case 'surfaces': {
      const set = Array.isArray(l.surfaces) ? l.surfaces : Array.isArray(o(l.set).surfaces) ? (o(l.set).surfaces as unknown[]) : null
      return set ? `surfaces: ${set.map((s) => String(o(s).kind ?? o(s).id ?? '?')).join(', ') || 'none'}` : 'surfaces changed'
    }
    case 'touch':
      return `touch ${String(l.phase ?? '')}`.trim()
    default:
      return null // 'event', 'raw', 'trace': one per parsed piece, too many to read
  }
}

/** /api/puppet/speech/events → text; level/words/playing are per-frame noise. */
export function speechText(line: unknown): string | null {
  const l = o(line)
  if (l.type === 'speech' && !l.replay) return `says: ${clip(String(l.text ?? ''))}`
  if (l.type === 'turn') return `turn ${String(l.phase)}`
  return null
}

/** /api/input/events → text. Pen/drag moves are per-frame, so skipped. */
export function inputText(line: unknown): string | null {
  const l = o(line)
  if (l.kind === 'midi') return l.type === 'note-on' ? `MIDI key ${String(l.note)} down` : null
  if (l.kind === 'button') return `room button ${String(l.id)}`
  if (l.kind === 'gesture') {
    const g = o(l.gesture)
    if (g.type === 'pen-move' || g.type === 'drag-move') return null
    return `gesture ${String(g.type)}${g.region ? ` on ${String(g.region)}` : ''}${g.flick ? ' (flick)' : ''}`
  }
  return null
}

/**
 * Spatial frames publish on every state change, which includes every finger
 * move. Only these facts are logged, and only when one differs from the last.
 */
export function spatialFacts(frame: unknown): Record<string, string> {
  const f = o(frame)
  const cam = o(f.camera)
  const lidar = o(f.lidar)
  const src = cam.source ? String(cam.source) : 'none'
  const fps = (Array.isArray(cam.sources) ? cam.sources : []).map(o).find((s) => s.id === cam.source)?.fps
  const touches = Array.isArray(lidar.touches) ? lidar.touches.map(o) : []
  return {
    lidar: String(o(lidar.health).state ?? 'unavailable'),
    touch: f.touchEnabled ? 'enabled' : `off (${String(f.reason ?? '')})`,
    // fps rounded to 5 so normal jitter does not log a line every frame.
    camera: `${src}${typeof fps === 'number' ? ` · ${Math.round(fps / 5) * 5} fps` : ''} · ${String(cam.state ?? '?')}`,
    calibration: `rev ${String(o(f.calibration).revision ?? '?')}${f.calibrated ? '' : ' (uncalibrated)'}`,
    baseline: String(o(lidar.baseline).state ?? 'none'),
    touches: touches.length ? touches.map((t) => `#${String(t.id)} ${String(t.phase)}`).join(', ') : 'none',
  }
}

/** /api/operator/status → the facts the operator acts on, diffed by the poller. */
export function operatorFacts(status: unknown): Record<string, string> {
  const s = o(status)
  const lesson = o(s.lesson)
  const ws = o(s.worksheet)
  const shown = o(ws.shown)
  const out = o(s.output)
  const last = o(o(s.brain).lastRender)
  return {
    act: String(s.act ?? '?'),
    mode: String(s.mode ?? '?'),
    lesson: s.lesson ? `${String(lesson.song)} ${String(lesson.index)}/${String(lesson.total)}` : 'none',
    keys: `${String(s.keys ?? 0)} (${String(s.keySource ?? 'none')})`,
    worksheet: s.worksheet ? (ws.on ? `on · ${Array.isArray(shown.taskIds) ? shown.taskIds.join(', ') : String(shown.taskId ?? 'nothing')}` : 'off') : 'n/a',
    'room output': out.requiresArm ? (out.active ? 'ARMED' : 'safe') : 'n/a',
    'last render': s.brain && o(s.brain).lastRender ? `${last.ok ? 'ok' : 'FAILED'} ${String(last.ms)} ms` : 'none',
  }
}

/** Logs `key: value` for each fact that changed since the last call. */
export function differ(push: (text: string) => void) {
  let prev: Record<string, string> | null = null
  return (next: Record<string, string>) => {
    for (const [k, v] of Object.entries(next)) if (!prev || prev[k] !== v) push(`${k}: ${v}`)
    prev = next
  }
}

// ---------------------------------------------------------------- sources

let users = 0
let stop: (() => void) | null = null

/**
 * Open every channel once for the page. Returns a release; the last release
 * closes them. EventSource reconnects on its own; we log the drop (error) and
 * the reconnect (on open) so a dead channel is visible, not silent.
 */
export function startFeedSources(f: Feed = feed): () => void {
  users++
  if (users === 1) stop = openAll(f)
  return () => {
    users--
    if (users === 0) {
      stop?.()
      stop = null
    }
  }
}

function openAll(f: Feed): () => void {
  const closers: (() => void)[] = []
  const sse = (url: string, channel: Channel, onData: (data: unknown) => void, event?: string) => {
    if (typeof EventSource === 'undefined') return
    const es = new EventSource(url)
    let wasDown = false
    es.onopen = () => {
      if (wasDown) f.push(channel, `reconnected ${url}`)
      wasDown = false
    }
    es.onerror = () => {
      if (!wasDown) f.push('error', `${channel}: lost ${url}`)
      wasDown = true
    }
    const handler = (e: MessageEvent) => {
      try {
        onData(JSON.parse(e.data as string))
      } catch {
        /* a non-JSON line is not ours to show */
      }
    }
    if (event) es.addEventListener(event, handler as EventListener)
    else es.onmessage = handler
    closers.push(() => es.close())
  }
  const line = (channel: Channel, summarize: (d: unknown) => string | null) => (d: unknown) => {
    const t = summarize(d)
    if (t) f.push(channel, t)
  }

  sse('/api/stage/events', 'stage', line('stage', stageText))
  sse('/api/puppet/speech/events', 'assistant', line('assistant', speechText))
  sse('/api/input/events', 'input', line('input', inputText))
  const spatial = differ((t) => f.push('spatial', t))
  sse('/api/spatial/events', 'spatial', (d) => spatial(spatialFacts(d)), 'spatial')

  // Operator status has no stream; poll it and log only what changed.
  const operator = differ((t) => f.push('operator', t))
  let failing = false
  const poll = () =>
    fetch('/api/operator/status')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((j) => {
        if (failing) f.push('operator', 'status back')
        failing = false
        operator(operatorFacts(j))
      })
      .catch((e: unknown) => {
        if (!failing) f.push('error', `operator status failed: ${e instanceof Error ? e.message : String(e)}`)
        failing = true
      })
  void poll()
  const timer = setInterval(() => void poll(), 2000)
  closers.push(() => clearInterval(timer))

  return () => closers.forEach((c) => c())
}
