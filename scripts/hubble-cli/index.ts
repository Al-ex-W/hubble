/**
 * `hubble`: the whole demo from a terminal (plan: docs/plans/2026-10-07-hubble-cli.md).
 *
 * Owner, 7 Oct: "make a CLI to control everything that we have … allowing
 * claude code to do complete controlling of all demos and everything."
 *
 * Why a thin HTTP client and nothing more: every control already exists as a
 * route on the running server, and the server is the one owner of the device
 * pool, the hardware window and arming. A CLI that opened a device itself
 * would be a second path around the pool (AGENTS.md, #73), and a CLI that
 * kept its own state would drift from the operating surface at :5173/. So
 * every command here is one or a few requests to HUBBLE_URL, nothing else.
 * The only local work is clock maths (the window line, from window.ts, the
 * window's one owner) and key geometry for `keyboard type` (from stage's
 * swipe layout, the one owner of where keys are).
 *
 * Why JSON on stdout by default: the main user is Claude Code, which parses
 * it. `--pretty` indents it for people. Errors go to stderr with a non-zero
 * exit, carrying the server's own error text, so an agent sees *why* (e.g.
 * "room pinch owns keyboard input") rather than a bare 409.
 *
 * Why one command table: dispatch and `help` both read COMMANDS, so a command
 * can't exist without help text or the other way round. Add a route to the
 * server → add one row here.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { windowAt, WINDOW_LABEL, WINDOW_TZ } from '../../packages/room/src/window.ts'
import { buildLayout, tableFromKeyboardMm } from '@hubble/stage/swipe'

const BASE = (process.env.HUBBLE_URL ?? 'http://localhost:8787').replace(/\/+$/, '')

class CliError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message)
  }
}

// ---- flags -------------------------------------------------------------
// Flags are pulled out of argv anywhere they appear, so `hubble --pretty
// status` and `hubble status --pretty` both work. Everything else stays
// positional: commands are short, and a real option parser would be one more
// thing to learn for very little.
interface Flags {
  pretty: boolean
  follow: boolean
  record: boolean
  /** Stop a --follow stream after this many events (so an agent's call ends). */
  limit: number | null
  /** Stop a --follow stream after this many seconds. */
  seconds: number | null
  out: string | null
  roi: string | null
}
function parseFlags(argv: string[]): { args: string[]; flags: Flags } {
  const flags: Flags = { pretty: false, follow: false, record: false, limit: null, seconds: null, out: null, roi: null }
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const value = () => {
      const eq = a.indexOf('=')
      if (eq > 0) return a.slice(eq + 1)
      const v = argv[++i]
      if (v === undefined) throw new CliError(`${a} needs a value`, 2)
      return v
    }
    const name = a.split('=')[0]
    if (name === '--pretty') flags.pretty = true
    else if (name === '--follow' || name === '-f') flags.follow = true
    else if (name === '--record') flags.record = true
    else if (name === '--limit') flags.limit = Number(value())
    else if (name === '--seconds') flags.seconds = Number(value())
    else if (name === '--out' || name === '-o') flags.out = value()
    else if (name === '--roi') flags.roi = value()
    else args.push(a)
  }
  return { args, flags }
}

// ---- HTTP --------------------------------------------------------------
async function request(method: string, path: string, body?: unknown): Promise<Response> {
  let res: Response
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (e) {
    // The commonest failure by far is "the server isn't running": say so
    // plainly instead of a fetch stack trace.
    throw new CliError(`cannot reach ${BASE} (${e instanceof Error ? (e.cause as Error | undefined)?.message ?? e.message : e}); is \`npm run dev\` running? set HUBBLE_URL to point elsewhere`)
  }
  if (!res.ok) {
    const text = await res.text()
    let msg = text
    try {
      const j = JSON.parse(text) as { error?: unknown }
      if (j && typeof j.error === 'string') msg = `${j.error}${text.length > j.error.length + 15 ? ` ${text}` : ''}`
    } catch {}
    throw new CliError(`${method} ${path} → ${res.status}: ${msg || res.statusText}`)
  }
  return res
}
async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await request(method, path, body)
  if (res.status === 204) return { ok: true }
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
const get = (path: string) => call('GET', path)
const post = (path: string, body: unknown = {}) => call('POST', path, body)

/** Server-sent events from one path, each `data:` parsed as JSON. */
async function* sse(path: string, signal: AbortSignal): AsyncGenerator<{ event: string; data: unknown }> {
  const res = await fetch(BASE + path, { signal, headers: { accept: 'text/event-stream' } }).catch((e) => {
    if (signal.aborted) return null
    throw new CliError(`cannot reach ${BASE}${path}: ${e instanceof Error ? e.message : e}`)
  })
  if (!res) return
  if (!res.ok || !res.body) throw new CliError(`GET ${path} → ${res.status}: ${await res.text()}`)
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      let end: number
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, end)
        buf = buf.slice(end + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
        }
        if (!data.length) continue // comments (": ping") and bare ids
        const raw = data.join('\n')
        let parsed: unknown = raw
        try {
          parsed = JSON.parse(raw)
        } catch {}
        yield { event, data: parsed }
      }
    }
  } catch (e) {
    if (!signal.aborted) throw e
  }
}

// ---- output ------------------------------------------------------------
let PRETTY = false
const print = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, PRETTY ? 2 : 0)}\n`)
const warn = (s: string) => process.stderr.write(`hubble: ${s}\n`)

/**
 * Runs a stream until --limit events, --seconds, or Ctrl-C. Without either
 * bound it runs until interrupted, which is what a person wants; an agent
 * should pass a bound so its shell call returns.
 */
async function follow(flags: Flags, sources: { name: string; path: string; map?: (d: unknown, ev: string) => unknown }[]) {
  const ctl = new AbortController()
  process.once('SIGINT', () => ctl.abort())
  if (flags.seconds !== null) setTimeout(() => ctl.abort(), flags.seconds * 1000).unref()
  let n = 0
  await Promise.all(
    sources.map(async (s) => {
      for await (const { event, data } of sse(s.path, ctl.signal)) {
        const out = s.map ? s.map(data, event) : data
        if (out === undefined) continue
        print(sources.length > 1 ? { stream: s.name, data: out } : out)
        if (flags.limit !== null && ++n >= flags.limit) ctl.abort()
      }
    }),
  )
}

// ---- argument helpers --------------------------------------------------
const need = (args: string[], i: number, what: string) => {
  const v = args[i]
  if (v === undefined) throw new CliError(`missing ${what}`, 2)
  return v
}
const num = (s: string, what: string) => {
  const n = Number(s)
  if (!Number.isFinite(n)) throw new CliError(`${what} must be a number, got ${JSON.stringify(s)}`, 2)
  return n
}
const onOff = (s: string | undefined, what = 'on|off') => {
  if (s === 'on' || s === 'true') return true
  if (s === 'off' || s === 'false') return false
  throw new CliError(`expected ${what}`, 2)
}
const json = (s: string, what: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    throw new CliError(`${what} is not valid JSON`, 2)
  }
}
const jsonFile = (path: string) => json(readFileSync(path, 'utf8'), path)
const rec = (flags: Flags) => (flags.record ? '?record=1' : '')

function hardwareWindow(now = Date.now()) {
  const w = windowAt(now)
  const at = (ms: number) => new Date(ms).toLocaleTimeString('sv-SE', { timeZone: WINDOW_TZ })
  return {
    open: w.open,
    rule: `${WINDOW_LABEL} ${WINDOW_TZ}`,
    ...(w.open ? { closesAt: at(w.closesAt), closesInMin: Math.round((w.closesAt - now) / 60000) } : { opensAt: at(w.opensAt), opensInMin: Math.round((w.opensAt - now) / 60000) }),
  }
}

/** Settled value or the error text: one dead part must not hide the rest of the snapshot. */
const part = (p: Promise<unknown>) => p.catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))

// ---- keyboard type -----------------------------------------------------
/**
 * Types text by tapping the projected keyboard's keys one at a time, through
 * the same /api/keyboard/stroke a hand or the bench's mouse uses. Why not a
 * "type text" route: the keyboard's reducer (stage's swipe/keyboard.ts) is the
 * one owner of what typing means; a second path that set the text directly
 * would skip its rules (space collapsing, delete, the SEND target). Key
 * centres come from stage's layout and the surface's live box, so a keyboard
 * someone moved still gets tapped where it is drawn.
 */
const LAYOUT = buildLayout()
async function keyboardBox(): Promise<{ x: number; y: number; w: number; h: number }> {
  const line = (await get('/api/surfaces')) as { surfaces?: { kind: string; box: { x: number; y: number; w: number; h: number } }[] }
  const kb = line.surfaces?.find((s) => s.kind === 'keyboard')
  if (!kb) throw new CliError('the keyboard is not open; run `hubble keyboard open` first')
  return kb.box
}
async function tapKey(box: { x: number; y: number; w: number }, id: string) {
  const k = LAYOUT.keys.find((k) => k.id === id)
  if (!k) throw new CliError(`no key ${JSON.stringify(id)}`, 2)
  const p = tableFromKeyboardMm(box, { x: k.x + k.w / 2, y: k.y + k.h / 2 })
  // A tap is one point: the reducer judges tap vs swipe by displacement.
  // ask:true so SEND behaves as it does for a hand (the server decides where
  // the text goes: a focused page, else the brain).
  return post('/api/keyboard/stroke', { points: [p], ask: true })
}
async function typeText(text: string) {
  const keys = [...text.toLowerCase()].map((c) => (c === ' ' ? 'space' : c))
  const bad = keys.filter((k) => k !== 'space' && !/^[a-z]$/.test(k))
  if (bad.length) throw new CliError(`the projected keyboard has only a–z and space; can't type ${JSON.stringify(bad.join(''))}`, 2)
  const box = await keyboardBox()
  let last: unknown = null
  for (const k of keys) last = await tapKey(box, k)
  return last
}

// ---- the command table -------------------------------------------------
interface Ctx {
  args: string[]
  flags: Flags
}
interface Command {
  /** Words that select it, e.g. 'keyboard open'. Longest match wins. */
  name: string
  usage?: string
  summary: string
  /** Writes to the shared room (projector, TVs, lights): help marks it. */
  room?: boolean
  run: (c: Ctx) => Promise<unknown>
}

const ARM_WARNING =
  'arming writes to the SHARED room projector, TVs and lights. Only with the owner\'s go, and only inside the hardware window (' +
  WINDOW_LABEL +
  ').'

const COMMANDS: Command[] = [
  // overview
  {
    name: 'status',
    summary: 'one snapshot: health, operator status, spatial summary, devices, hardware window',
    run: async () => {
      const [health, operator, spatial, devices] = await Promise.all([part(get('/api/health')), part(get('/api/operator/status')), part(get('/api/spatial')), part(get('/api/devices'))])
      const s = spatial as Record<string, any>
      const snapshot = {
        url: BASE,
        window: hardwareWindow(),
        health,
        operator,
        // The full frame carries raw lidar returns (hundreds of points): the
        // summary is what an operator decides on; `hubble spatial` has the rest.
        spatial: s?.error
          ? s
          : {
              state: s.state,
              calibrated: s.calibrated,
              touchEnabled: s.touchEnabled,
              reason: s.reason,
              camera: { state: s.camera?.state, source: s.camera?.source, ageMs: s.camera?.ageMs, fingers: s.camera?.fingers?.length ?? 0 },
              lidar: { health: s.lidar?.health, baseline: s.lidar?.baseline, touches: s.lidar?.touches?.length ?? 0 },
              surfaces: s.surfaces?.length ?? 0,
            },
        devices,
      }
      // The snapshot is printed either way (the window line is still useful),
      // but a dead server is a failed call, so a script can branch on it.
      if ((health as { error?: unknown }).error) {
        print(snapshot)
        throw new CliError(`server not healthy: ${(health as { error: string }).error}`)
      }
      return snapshot
    },
  },
  { name: 'window', summary: 'the hardware window (local clock maths, no request)', run: async () => hardwareWindow() },
  { name: 'health', summary: 'GET /api/health', run: () => get('/api/health') },
  { name: 'devices', summary: 'what the device pool holds (GET /api/devices)', run: () => get('/api/devices') },
  { name: 'runtime', summary: 'the runtime state (GET /api/runtime)', run: () => get('/api/runtime') },
  { name: 'operator', summary: 'operator status (GET /api/operator/status)', run: () => get('/api/operator/status') },

  // answers
  {
    name: 'ask',
    usage: '"<text>"',
    summary: 'one table-agent turn (POST /api/agent/turn)',
    run: ({ args }) => post('/api/agent/turn', { text: need(args, 0, 'text').trim() && args.join(' '), from: 'chat' }),
  },
  {
    name: 'solve-page',
    usage: '[n]',
    summary: 'read the page (camera, else the iPad) and solve problem n, or all of them (POST /api/solve-page)',
    run: ({ args }) => post('/api/solve-page', args[0] ? { n: num(args[0], 'n') } : {}),
  },
  { name: 'history', summary: 'the table agent\'s history', run: () => get('/api/agent/history') },
  {
    name: 'render',
    usage: '"<intent>"',
    summary: 'render an answer onto the table; prints the NDJSON stream line by line',
    run: async ({ args }) => {
      const res = await request('POST', '/api/render', { intent: need(args, 0, 'intent') && args.join(' ') })
      // Lines are passed through as the server wrote them (already JSON),
      // so the stream contract is stage's protocol.ts, not ours.
      const decoder = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (line) PRETTY ? print(JSON.parse(line)) : process.stdout.write(`${line}\n`)
        }
      }
      if (buf.trim()) process.stdout.write(`${buf.trim()}\n`)
      return undefined
    },
  },
  { name: 'action', usage: 'next|repeat|dismiss', summary: 'a tap on the projected answer\'s button', run: ({ args }) => post('/api/action', { action: need(args, 0, 'action') }) },
  { name: 'fallback', usage: '<answer>', summary: 'put a recorded fallback answer on the table (the server lists valid names on error)', run: ({ args }) => post('/api/operator/fallback', { answer: need(args, 0, 'answer') }) },

  // show controls
  { name: 'act', usage: 'math | lesson [song]', summary: 'switch act (lesson clears the table first)', run: ({ args }) => post('/api/operator/act', { act: need(args, 0, 'act'), ...(args[1] ? { song: args[1] } : {}) }) },
  { name: 'reset', summary: 'back to the start: empty table, math act, idle lights', run: () => post('/api/operator/reset') },
  { name: 'close-all', summary: 'close every surface, stay in the act', run: () => post('/api/operator/close-all') },
  {
    name: 'arm',
    usage: 'on|off',
    room: true,
    summary: 'arm or disarm writes to the shared room (the owner\'s go)',
    run: ({ args }) => {
      const armed = onOff(args[0])
      if (armed) warn(ARM_WARNING)
      return post('/api/operator/room', { armed })
    },
  },
  { name: 'piano', usage: '[on|off]', summary: 'the MiniLab piano checkbox (no arg: read it)', run: ({ args }) => (args[0] ? post('/api/operator/piano', { enabled: onOff(args[0]) }) : get('/api/operator/piano')) },

  // keyboard
  { name: 'keyboard open', usage: '[x y]', summary: 'open the projected keyboard (table px; default bottom-centre)', run: ({ args }) => post('/api/keyboard/open', args.length >= 2 ? { x: num(args[0]!, 'x'), y: num(args[1]!, 'y') } : {}) },
  { name: 'keyboard close', summary: 'close the projected keyboard', run: () => post('/api/keyboard/close') },
  { name: 'keyboard type', usage: '"<text>"', summary: 'tap the keys for a–z and spaces, one by one', run: ({ args }) => typeText(need(args, 0, 'text') && args.join(' ')) },
  { name: 'keyboard send', summary: 'tap SEND (a focused page takes the text, else the brain is asked)', run: async () => tapKey(await keyboardBox(), 'send') },
  { name: 'keyboard delete', summary: 'tap delete', run: async () => tapKey(await keyboardBox(), 'delete') },
  { name: 'keyboard stroke', usage: '\'[{"x":..,"y":..},…]\'', summary: 'post a raw stroke in table px', run: ({ args }) => post('/api/keyboard/stroke', { points: json(need(args, 0, 'points'), 'points'), ask: true }) },
  {
    name: 'keyboard input',
    usage: '[pointer | room-pinch [token]]',
    summary: 'which input owns the keyboard (no arg: read it)',
    run: ({ args }) => (args[0] ? post('/api/keyboard/input', { mode: args[0], ...(args[1] ? { token: args[1] } : {}) }) : get('/api/keyboard/input')),
  },

  // lesson + inputs
  { name: 'lesson start', usage: '<song>', summary: 'start a piano lesson (unknown song → the server lists them)', run: ({ args }) => post('/api/lesson/start', { song: need(args, 0, 'song') }) },
  { name: 'lesson stop', summary: 'stop the lesson', run: () => post('/api/lesson/stop') },
  { name: 'lesson keybed', usage: '<file.json>', summary: 'set the keybed corners ({ corners: [4×{x,y}], lowestNote })', run: ({ args }) => post('/api/lesson/keybed', jsonFile(need(args, 0, 'file'))) },
  {
    name: 'midi',
    usage: '<note> [on|off] [velocity]',
    summary: 'inject a MIDI note as if played on the MiniLab',
    run: ({ args }) => post('/api/input/midi', { type: args[1] === 'off' ? 'note-off' : 'note-on', note: num(need(args, 0, 'note'), 'note'), velocity: args[2] ? num(args[2], 'velocity') : 100 }),
  },
  { name: 'gesture', usage: '\'<json>\'', summary: 'inject a hand gesture (see GestureBody in runtimeRoutes.ts)', run: ({ args }) => post('/api/input/gesture', json(need(args, 0, 'gesture'), 'gesture')) },
  { name: 'hands', summary: 'the latest hand-tracker snapshot', run: () => get('/api/input/hands') },

  // worksheet (iPad)
  { name: 'worksheet on', summary: 'start the iPad worksheet', run: () => post('/api/operator/worksheet', { on: true }) },
  { name: 'worksheet off', summary: 'stop the iPad worksheet', run: () => post('/api/operator/worksheet', { on: false }) },
  { name: 'worksheet pick', usage: '<taskId…>', summary: 'show these tasks on the iPad', run: ({ args }) => post('/api/operator/worksheet', { taskIds: (need(args, 0, 'task id'), args) }) },
  { name: 'worksheet text', usage: '<mm>', summary: 'text size on the iPad, in mm', run: ({ args }) => post('/api/operator/worksheet', { textMm: num(need(args, 0, 'mm'), 'mm') }) },
  { name: 'worksheet ruler', usage: 'on|off', summary: 'the check ruler beside the iPad', run: ({ args }) => post('/api/operator/worksheet', { ruler: onOff(args[0]) }) },
  { name: 'worksheet status', summary: 'what the iPad shows', run: async () => ((await get('/api/operator/status')) as { worksheet?: unknown }).worksheet ?? null },

  // surfaces
  { name: 'surface list', summary: 'every surface on the table', run: () => get('/api/surfaces') },
  { name: 'surface open-asset', usage: '<assetId>', summary: 'open a library asset (`hubble assets` lists them)', run: ({ args }) => post('/api/surfaces/asset', { id: need(args, 0, 'asset id') }) },
  { name: 'surface open-web', usage: '<url>', summary: 'open an allow-listed web page as a surface', run: ({ args }) => post('/api/surfaces/web', { url: need(args, 0, 'url') }) },
  { name: 'surface move', usage: '<id> <dx> <dy>', summary: 'move a surface by table px', run: ({ args }) => post(`/api/surfaces/${encodeURIComponent(need(args, 0, 'id'))}/move`, { dx: num(need(args, 1, 'dx'), 'dx'), dy: num(need(args, 2, 'dy'), 'dy') }) },
  { name: 'surface raise', usage: '<id>', summary: 'bring a surface to the top', run: ({ args }) => post(`/api/surfaces/${encodeURIComponent(need(args, 0, 'id'))}/raise`) },
  { name: 'surface close', usage: '<id>', summary: 'close a surface', run: ({ args }) => post(`/api/surfaces/${encodeURIComponent(need(args, 0, 'id'))}/close`) },
  { name: 'assets', summary: 'the asset library', run: () => get('/api/assets') },
  {
    name: 'web',
    usage: '<id> click x y | scroll dy | type "<text>" | key <key> | back | forward | navigate <url>',
    summary: 'drive a web surface',
    run: ({ args }) => {
      const id = encodeURIComponent(need(args, 0, 'surface id'))
      const op = need(args, 1, 'op')
      const body =
        op === 'click' ? { x: num(need(args, 2, 'x'), 'x'), y: num(need(args, 3, 'y'), 'y') }
        : op === 'scroll' ? { dy: num(need(args, 2, 'dy'), 'dy') }
        : op === 'type' ? { text: need(args, 2, 'text') && args.slice(2).join(' ') }
        : op === 'key' ? { key: need(args, 2, 'key') }
        : op === 'navigate' ? { url: need(args, 2, 'url') }
        : {}
      return post(`/api/web/${id}/${encodeURIComponent(op)}`, body)
    },
  },

  // calibration
  { name: 'calibration calibrate', usage: '[--record]', room: true, summary: 'run the projector↔camera calibration (projects dots, reads the camera)', run: ({ flags }) => post(`/api/calibrate${rec(flags)}`) },
  { name: 'calibration status', summary: 'which calibration is in use', run: () => get('/api/calibration') },
  { name: 'calibration dot', usage: '[x y]', room: true, summary: 'one test dot at table px (no args clears it)', run: ({ args }) => post('/api/calibrate/dot', args.length >= 2 ? { x: num(args[0]!, 'x'), y: num(args[1]!, 'y') } : {}) },
  {
    name: 'calibration standard',
    summary: 'regenerate the committed standard calibration (local script, reads files only; restart the server to load it)',
    run: async () => {
      // Not a route: the standard calibration is a file the server reads at
      // boot (standardCalibration.ts). The script only reads committed
      // frames, never a device, so running it here doesn't go around the pool.
      const r = spawnSync('npx', ['tsx', 'scripts/standard-calibration.ts'], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
      if (r.status !== 0) throw new CliError(`calibration:standard exited ${r.status}`)
      return { ok: true, output: r.stdout.trim() }
    },
  },
  {
    name: 'calibration clear',
    summary: 'clear the lidar/table registration (DELETE /api/spatial/registration)',
    // Ruling: there is no route that drops the camera calibration (the server
    // falls back to the standard one only when nothing was measured). The one
    // calibration the server can clear is the spatial registration, so that's
    // what this does; the summary says so rather than pretending otherwise.
    run: () => call('DELETE', '/api/spatial/registration'),
  },
  { name: 'scene', summary: 'what the camera sees on the table (GET /api/scene/seen)', run: () => get('/api/scene/seen') },

  // spatial + lidar
  { name: 'spatial', usage: '[--follow]', summary: 'the full spatial frame (or its stream)', run: ({ flags }) => (flags.follow ? follow(flags, [{ name: 'spatial', path: '/api/spatial/events' }]) : get('/api/spatial')) },
  {
    name: 'lidar status',
    summary: 'lidar health, baseline and touches',
    run: async () => {
      const s = (await get('/api/spatial')) as { touchEnabled?: boolean; reason?: string; lidar?: { health: unknown; baseline: unknown; touches: unknown; calibrationRevision: unknown } }
      return { touchEnabled: s.touchEnabled, reason: s.reason, health: s.lidar?.health, baseline: s.lidar?.baseline, calibrationRevision: s.lidar?.calibrationRevision, touches: s.lidar?.touches }
    },
  },
  {
    name: 'lidar baseline',
    usage: '[ms] | clear',
    summary: 'take the empty-table baseline (1000–10000 ms, hands clear!) or clear it',
    run: ({ args }) => (args[0] === 'clear' ? call('DELETE', '/api/spatial/baseline') : post('/api/spatial/baseline', args[0] ? { ms: num(args[0], 'ms') } : {})),
  },
  { name: 'lidar register', usage: '<file.json>', summary: 'register lidar/table targets (POST /api/spatial/registration)', run: ({ args }) => post('/api/spatial/registration', jsonFile(need(args, 0, 'file'))) },
  {
    name: 'lidar touches',
    usage: '[--follow]',
    summary: 'live lidar touches (prints only when they change)',
    run: async ({ flags }) => {
      if (!flags.follow) return ((await get('/api/spatial')) as { lidar?: { touches?: unknown } }).lidar?.touches ?? []
      // The spatial stream publishes on any change; touches are a small part
      // of it, so repeats are dropped to keep the output about touches.
      let last = ''
      return follow(flags, [
        {
          name: 'touches',
          path: '/api/spatial/events',
          map: (d) => {
            const t = JSON.stringify((d as { lidar?: { touches?: unknown } }).lidar?.touches ?? [])
            if (t === last) return undefined
            last = t
            return { at: new Date().toISOString(), touches: JSON.parse(t) }
          },
        },
      ])
    },
  },
  { name: 'observe', usage: '<file.json>', summary: 'post a camera observation (POST /api/spatial/observations)', run: ({ args }) => post('/api/spatial/observations', jsonFile(need(args, 0, 'file'))) },
  { name: 'markers', usage: '<file.json>', summary: 'post detected reference markers (POST /api/spatial/markers)', run: ({ args }) => post('/api/spatial/markers', jsonFile(need(args, 0, 'file'))) },
  {
    name: 'markers print',
    usage: '[--out file.svg]',
    summary: 'the printable reference-marker sheet (SVG)',
    run: async ({ flags }) => binary(await request('GET', '/api/spatial/markers/print'), flags),
  },

  // reference points (#91)
  { name: 'reference start', usage: '[--record]', room: true, summary: 'project the reference marker grid', run: ({ flags }) => post(`/api/spatial/reference${rec(flags)}`, { on: true }) },
  { name: 'reference stop', summary: 'clear the reference grid', run: ({ flags }) => post(`/api/spatial/reference${rec(flags)}`, { on: false }) },
  { name: 'reference status', summary: 'the reference run\'s state', run: () => get('/api/spatial/reference') },
  { name: 'localization', summary: 'the marker localizer\'s state', run: () => get('/api/spatial/localization') },

  // camera
  {
    name: 'camera frame',
    usage: '[--roi r] [--out file.jpg] (or > file.jpg)',
    summary: 'one room-camera JPEG, through the server\'s pool (window-gated there)',
    run: async ({ flags }) => binary(await request('GET', `/api/camera/frame${flags.roi ? `?roi=${encodeURIComponent(flags.roi)}` : ''}`), flags),
  },
  { name: 'camera roi', summary: 'the camera crop for the open keyboard', run: () => get('/api/camera/roi') },

  // streams
  {
    name: 'events',
    usage: '--follow [--limit n] [--seconds s]',
    summary: 'the stage (answers, surfaces) and input (touches, buttons, gestures, midi) streams, merged',
    run: ({ flags }) =>
      follow(flags, [
        { name: 'stage', path: '/api/stage/events' },
        { name: 'input', path: '/api/input/events' },
      ]),
  },

  // escape hatch
  {
    name: 'raw',
    usage: '<METHOD> <path> [json]',
    summary: 'any request, for routes this table doesn\'t name yet',
    run: ({ args }) => call(need(args, 0, 'method').toUpperCase(), need(args, 1, 'path'), args[2] === undefined ? undefined : json(args[2], 'body')),
  },
  { name: 'help', summary: 'this list', run: async () => help() },
]

/** Bytes to --out or a redirected stdout; never JPEG noise onto a terminal. */
async function binary(res: Response, flags: Flags) {
  const bytes = Buffer.from(await res.arrayBuffer())
  if (flags.out) {
    writeFileSync(flags.out, bytes)
    return { ok: true, out: flags.out, bytes: bytes.length, type: res.headers.get('content-type') }
  }
  if (process.stdout.isTTY) throw new CliError('binary output: redirect it (> file) or pass --out <file>', 2)
  process.stdout.write(bytes)
  return undefined
}

function help() {
  const lines = [
    'hubble: drive the running Hubble server from a terminal.',
    `server: ${BASE} (set HUBBLE_URL to change it)`,
    'usage: npm run -s hubble -- <command> [args] [--pretty] [--follow] [--limit n] [--seconds s] [--out file] [--record]',
    'output: JSON on stdout; errors on stderr with a non-zero exit.',
    `[room] = projects onto or lights the shared room: owner's go, and only in the hardware window (${WINDOW_LABEL}).`,
    '',
  ]
  // Long usages (web, camera frame) get their own line, so one wide row
  // doesn't push every summary off a terminal.
  const WIDTH = 34
  for (const c of COMMANDS) {
    const head = `${c.name} ${c.usage ?? ''}`.trim()
    const summary = `${c.room ? '[room] ' : ''}${c.summary}`
    lines.push(head.length <= WIDTH ? `  ${head.padEnd(WIDTH)}  ${summary}` : `  ${head}\n  ${''.padEnd(WIDTH)}  ${summary}`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return undefined
}

/** Longest name whose words are a prefix of argv. */
function resolve(args: string[]): { cmd: Command; rest: string[] } | null {
  let best: { cmd: Command; rest: string[] } | null = null
  let bestLen = 0
  for (const cmd of COMMANDS) {
    const words = cmd.name.split(' ')
    if (words.length > bestLen && words.every((w, i) => args[i] === w)) {
      best = { cmd, rest: args.slice(words.length) }
      bestLen = words.length
    }
  }
  return best
}

async function main() {
  const { args, flags } = parseFlags(process.argv.slice(2))
  PRETTY = flags.pretty
  if (!args.length || args[0] === '--help' || args[0] === '-h') return help()
  const hit = resolve(args)
  if (!hit) {
    const group = COMMANDS.filter((c) => c.name.startsWith(`${args[0]} `)).map((c) => c.name)
    throw new CliError(group.length ? `${args[0]}: one of ${group.join(', ')}` : `unknown command ${JSON.stringify(args[0])}; try \`hubble help\``, 2)
  }
  const out = await hit.cmd.run({ args: hit.rest, flags })
  if (out !== undefined) print(out)
}

main().catch((e: unknown) => {
  warn(e instanceof Error ? e.message : String(e))
  process.exit(e instanceof CliError ? e.code : 1)
})
