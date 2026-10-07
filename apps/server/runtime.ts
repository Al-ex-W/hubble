import { createSpatialService, type SpatialService } from './spatial/service.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { DEFAULT_SURFACE, hitTest, type Box, type OverlayLine, type OverlayShape, type RenderRequest, type SceneObject, type SurfacesLine, type TouchLine } from '@hubble/stage'
import { touchLineFor } from './touchLines.ts'
import { apply, createLightPlayer, createSlotWriter, keyQuads, MOODS, observe, pool as devicePool, WINDOW_LABEL, type DisplayId, type HardwareWindow, type Keybed, type KeyQuad, type Room } from '@hubble/room'
import { bootDots, dotShape, runCalibration, type CalibrationRun } from './calibration.ts'
import { resolveCalibration, type CalibrationSource } from './standardCalibration.ts'
import { createLesson, SONGS, type Song } from './lesson/lesson.ts'
import type { KeybedClient } from './keybed.ts'
import { createPianoDetection } from './piano.ts'
import { createSurfaceManager } from './surfaces.ts'
import { createSurfaceGestures } from './surfaceGestures.ts'
import { createSwipeKeyboard } from './swipeKeyboard.ts'
import { createKeyboardInput } from './input/keyboardInput.ts'
import { createLauncher } from './launcher.ts'
import type { TableGesture } from './inputs.ts'
import { rulerShapes } from './worksheet.ts'
import { createReferenceRun } from './spatial/reference.ts'
import { createLidarRegistration } from './spatial/lidarWizard.ts'
import { createRegistrationRun } from './spatial/registrationRun.ts'
import { createLidarGestures } from './input/lidarGestures.ts'
import { commandFor, DEFAULT_DISPLAYS, type DisplayMap, type DisplayPage } from './displays.ts'

/**
 * The runtime: the one owner of product state outside a single answer.
 *
 * The hub owns *which answer* is on the table (latest request wins). The
 * runtime owns everything around it: the act (math or lesson), the mode the
 * lights show, the lesson and its lit keys, where the keyboard lies, and what
 * the room's displays are pointed at. One owner, so the lights, the lesson and
 * the displays can never disagree about what is going on.
 */

// No 'listening': only the voice orb listened, and it left main on 7 Oct
// (branch archive/voice-orb). The room's MOODS still has a listening mood for
// when voice comes back; nothing here reaches it.
export type Mode = 'idle' | 'thinking' | 'answering' | 'error'
export type Act = 'math' | 'lesson'

export interface RuntimeDeps {
  /** The display hub's overlay channel (the lesson's key light). */
  overlay(line: OverlayLine): void
  /** The display hub's touch channel (#89): broadcast, never stored. Optional: a lesson-only runtime has no ripples. */
  touch?(line: TouchLine): void
  /**
   * The display hub's surface channel. Optional so a runtime built only for
   * the lesson or the room (tests) needs no hub; the set is still kept.
   */
  surfaces?(line: SurfacesLine): void
  /** Clear the answer from every display (the hub's dismiss); closing the answer surface calls it. */
  dismissAnswer?(): void
  /**
   * Put a question to the brain and its answer on the table (index.ts's
   * renderToTable): what SEND on the projected keyboard does (#29). False
   * when there is no model. Optional so a lesson-only runtime needs no brain.
   */
  ask?(request: RenderRequest): boolean
  room?: Room
  team?: string
  /**
   * The real room (ROOM=live): nothing reaches its shared projector, TVs or
   * lights until the operator arms output (owner's rule; the room has no
   * slots or tokens in code since 5 Oct, so nothing else would stop us).
   */
  requireArm?: boolean
  /** Base URL displays load our pages from (the laptop's LAN address). */
  publicBase?: string
  now?: () => number
  /** Tests run the light loop by hand. */
  autoTick?: boolean
  /** Where the calibration is saved; camera, lidar and projector stay fixed all day (spec). */
  calibrationFile?: string
  /** Shared location owner; independent of detector execution and display writes. */
  spatial?: SpatialService
  /**
   * The keybed sidecar (apps/keybed, #36): finds every MiniLab key in a
   * camera frame. Optional: without it, or when it fails, the keys come from
   * perceive.ts's keybed as before.
   */
  keybed?: KeybedClient
  /**
   * The room camera's newest frame (JPEG). On site this is pi-projector's
   * /camera/frame (organisers' spec Draft 0.4); without it the room client's
   * camera (the emulator) is used. One source for calibration and look(), so
   * the map and the keys it is applied to come from the same camera.
   */
  cameraFrame?: () => Promise<Uint8Array>
  /** Wait between drawing a calibration dot and reading the camera (kiosk paint + frame delivery). */
  calibrationSettleMs?: number
  /**
   * Input into the web pages on the table (web.ts's host, wired in index.ts):
   * what a tap, a drag and the keyboard's SEND do to a page. Optional: a
   * runtime without a browser (most tests, a lesson-only run) has no pages
   * and gives web surfaces no handler, as before.
   */
  webInput?: WebInput
  /**
   * The hardware window (#73), for what reaches the room without a device
   * connection (the reference grid on /table). Defaults to the device
   * pool's own window() on the real room (requireArm), so the minutes have
   * one owner (window.ts). Tests pass their own clock.
   */
  hardwareWindow?: () => HardwareWindow
}

/** The web host's input ops the runtime drives. Each resolves when done; failures are the page's own state, never a throw. */
export interface WebInput {
  click(id: string, x: number, y: number): Promise<unknown>
  scroll(id: string, dy: number): Promise<unknown>
  type(id: string, text: string): Promise<unknown>
  key(id: string, key: 'Enter'): Promise<unknown>
}

/**
 * Where the lesson's keys come from, best first: the keybed detector's 25
 * measured keys; else the 4 keybed corners from perceive.ts (or set by hand
 * through /api/lesson/keybed) spread into evenly spaced keys.
 */
export type KeySource = 'camera' | 'camera-stale' | 'perceive' | 'manual' | null

// Colours chosen for projected light on white keycaps: saturated, so they
// read under ambient light and on white plastic.
const GREEN = '#36ff7a'
const RED = '#ff3b3b'
// The NEXT key's marker: Liquid lavender at half strength. Light, never dark:
// the projector can only add light to a white table, so a "dark" marker would
// simply not show. Quieter than the green so the key to press now still wins.
const NEXT = '#becaff'
const NEXT_INTENSITY = 0.5
const FLASH_MS = 450
const DUPLICATE_NOTE_MS = 150

export function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  return null
}

/**
 * The web app's port: the one port people and the room's devices open (the
 * owner, 7 Oct: "we only have a 5173"). The projector's /table and the iPad's
 * /worksheet/ are both served from it; the server's own port (8787) and the
 * sidecars' stay behind Vite's proxy. Must match apps/web/vite.config.ts.
 */
export const WEB_PORT = 5173

/**
 * Where the room's devices reach our pages: PUBLIC_BASE when set, otherwise
 * this laptop's LAN address on WEB_PORT; null when the laptop has no LAN
 * address (not on the room network). The one owner of that answer, so the
 * projector's URL and the iPad's can't disagree.
 */
export function webOrigin(publicBase?: string): string | null {
  if (publicBase) return publicBase.replace(/\/+$/, '')
  const lan = lanAddress()
  return lan ? `http://${lan}:${WEB_PORT}` : null
}

export function createRuntime(d: RuntimeDeps) {
  const now = d.now ?? Date.now
  const piano = createPianoDetection(now)
  let mode: Mode = 'idle'
  let act: Act = 'math'
  let keybed: Keybed | null = null
  // The detector's keys, in projector px. When present they win over
  // `keybed`: they are measured key by key (black keys sit off the white-key
  // boundaries on the real MiniLab, which keyQuads' even spacing misses).
  let keys: KeyQuad[] | null = null
  let keySource: KeySource = null
  // When the sidecar last answered with keys. A measurement that is only
  // old (the sidecar failed since) is shown as camera-stale with its age.
  let measuredAt: number | null = null
  // Bumped by every look and every manual placement. A look commits only if
  // it is still the latest thing that happened: two looks overlap (the 2 s
  // interval doesn't wait, /api/scene/seen looks too) and the sidecar can
  // answer the older one last, and a placement made while a look is in
  // flight must not be overwritten by that look's old frame (review #41).
  let generation = 0
  // Explicit looks may supersede each other, but a periodic tick is only a
  // refresh request. If it supersedes a 2.2 s capture every 2 s, no frame ever
  // reaches detection (the room allows 5 s). Count all pending looks so the
  // timer yields to both its own work and the operator's immediate capture.
  let looksInFlight = 0
  // The one in-flight look, shared by every concurrent caller. Two looks at
  // once used to bump `generation` against each other: the second invalidated
  // the first mid-capture, the first then returned without committing, and at
  // slow frame rates (the room allows 5 s) the 2 s tick and /api/scene/seen
  // kept cancelling each other, so no look ever committed the keys. Joining
  // the in-flight promise means the second caller waits for the same frame
  // instead of discarding it. A manual placement still bumps `generation` and
  // wins over the shared result, which is the existing review #41 rule.
  let lookInFlight: Promise<SceneObject[]> | null = null
  let lesson: ReturnType<typeof createLesson> | null = null
  let wrong: { note: number; until: number } | null = null
  let flashTimer: ReturnType<typeof setTimeout> | null = null
  const stops: (() => void)[] = []
  // Health, for the operator panel (#34): kept here because the runtime is
  // already told about every render and every key press, so nothing else has
  // to watch for them a second time.
  let renderT0: number | null = null
  let lastRender: { ok: boolean; ms: number; at: number } | null = null
  let lastMidiAt: number | null = null
  // The last accepted note-on, for dropping duplicates (see midi()).
  let lastNoteOn: { note: number; at: number } | null = null
  let duplicateNotes = 0
  // Camera px → projector px, measured once on site with projected dots. A
  // live run writes `calFile`; when that file is missing or broken we fall
  // back to the committed standard derived from the 7 Oct recording — losing
  // the file (as happened on 7 Oct, with a deleted worktree) must not leave
  // the room uncalibrated. `resolveCalibration` is the one owner of which map
  // wins; nothing else may decide it a second time.
  const calFile = d.calibrationFile ?? '.hubble/calibration.json'
  const resolved = resolveCalibration(calFile)
  let calibrationSource: CalibrationSource = resolved?.source ?? null
  const spatial = d.spatial ?? createSpatialService({ now: d.now })
  // The on-site legacy file was recorded at full-frame 1080p (H28 fixture).
  // New observations must match that geometry; no implicit second 180° flip.
  if (resolved) spatial.calibration.setCamera({ h:resolved.data.cameraToProjector, width:resolved.data.cameraGeometry.width, height:resolved.data.cameraGeometry.height, geometry:'room:full-frame' })
  // At boot `seen` is taken from the file's own dot list (a saved run keeps
  // every dot, seen or not); a live run below overwrites it with the count
  // that actually showed. The standard file's dots came from the recording.
  let lastCalibration: { rms: number; at: string; dots: number; seen: number; source: Exclude<CalibrationSource, null> } | null = resolved ? { rms: resolved.data.rms ?? NaN, at: resolved.data.measuredAt, dots: resolved.data.dots.length, seen: resolved.data.dots.length, source: resolved.source } : null
  let calibrating = false
  // The camera: the room's own (pi-projector) when configured, else the room client's.
  const camera = (): (() => Promise<Uint8Array>) | null => d.cameraFrame ?? (d.room ? () => d.room!.cameraFrame() : null)
  // What the camera last saw on the table, in projector px: the brain's scene
  // when a request arrives without one (the room), and the lesson's keybed.
  let seen: SceneObject[] = []

  // Everything on the table (answers, assets, web pages, the keyboard, the
  // launcher) has one owner, here beside the rest of the product state.
  // `keyboard` is created just below (it needs the set); the closure only
  // runs when a surface closes, long after both exist.
  const surfaces = createSurfaceManager({ publish: (l) => d.surfaces?.(l), bounds: DEFAULT_SURFACE, onCloseAnswer: () => d.dismissAnswer?.(), onCloseKeyboard: () => keyboard.discardDraft() })
  spatial.followSurfaces(surfaces)
  // What a hand does to those surfaces (#32): beside the set it acts on, so
  // "which surface did that drag grab" has one owner.
  //
  // Web pages (7 Oct, docs/plans/2026-10-07-web-browsing.md): a tap clicks
  // the page at that point and focuses it, a drag below the title strip
  // scrolls it. This is the touch side of browsing on the table, built as a
  // consumer only: whatever produces taps (the hand tracker today, the
  // lidar contact work when it lands, a curl to /api/input/gesture) clicks
  // pages through here without knowing they are pages.
  //
  // One focused page: where the keyboard's SEND goes. Set by a tap on a page
  // and by a page opening (index.ts → focusWeb); cleared by a tap on another
  // surface; a closed page is dropped when SEND reads it (focusedWeb()).
  let focused: string | null = null
  const focusedWeb = () => (focused && surfaces.list().some((s) => s.id === focused && s.kind === 'web') ? focused : null)
  const web = d.webInput
  const gestures = createSurfaceGestures({
    surfaces,
    handlers: web
      ? {
          web: {
            activate: (s, p) => {
              focused = s.id
              void web.click(s.id, Math.round(p.x), Math.round(p.y))
            },
            // A drag down the table (finger moving toward the person) pulls
            // the page down to reveal what is above, as on a phone: the page
            // scrolls opposite to the finger.
            scroll: (s, { dy }) => void web.scroll(s.id, Math.round(-dy)),
          },
        }
      : undefined,
  })
  // The swipe keyboard's text, candidates and send (#29). Here, next to the
  // surface set it lives in, because it is product state like the lesson:
  // every display draws the same draft, whoever holds the pen.
  const keyboard = createSwipeKeyboard({
    surfaces,
    ask: (r) => d.ask?.(r) ?? false,
    seen: () => seen,
    // Compose, then SEND types into the focused page and presses Enter (the
    // 7 Oct ruling): a search box submits, a form field moves on. The type
    // and the Enter run in order on the page's own op queue (web.ts).
    sendTo: () => {
      const id = web ? focusedWeb() : null
      if (!id || !web) return null
      return (text) => {
        void web.type(id, text).then(() => web.key(id, 'Enter'))
        return true
      }
    },
  })
  const keyboardInput = createKeyboardInput({ spatial, keyboard, overlay: d.overlay, now: d.now, autoTick: d.autoTick })
  // A finger on the table → a ripple of light there (#89). The spatial service
  // says where fingers are; what a touch DOES is decided here, in
  // touchLines.ts. The keyboard doesn't consume lidar touches yet (plan
  // stage 2, gated on the on-site hover recordings).
  // What a CONFIRMED lidar touch does (docs/plans/2026-10-07-lidar-web.md):
  // taps and drags go through api.gesture like a hand's, so web pages click
  // and scroll by the same rules (#100); strokes on the keyboard type only in
  // the explicitly selected room-lidar mode. The ripple above stays the
  // immediate feedback; this acts only from the tracker's `down` on.
  const lidarGestures = createLidarGestures({
    kindAt: (p) => {
      const id = hitTest(surfaces.list(), p)
      return id ? (surfaces.list().find((s) => s.id === id)?.kind ?? null) : null
    },
    // `api` is declared below; this runs only when a touch arrives, long after.
    gesture: (g) => void api.gesture(g),
    lidarTyping: () => keyboardInput.state().mode === 'room-lidar',
    keyboardStroke: (points) => void keyboard.stroke(points),
    mmPerPx: DEFAULT_SURFACE.mmPerPx,
    now,
  })
  const stopTouches = spatial.onTouch((e) => {
    const line = touchLineFor(e)
    if (line) d.touch?.(line)
    lidarGestures.touch(e)
  })

  // ---- lights and displays, all through the slot-gated, Hue-safe path ----
  const lights = d.room ? createLightPlayer({ light: (id, c) => d.room!.light(id, c), scene: (n) => d.room!.scene(n) }) : null
  const writer = d.room && lights ? createSlotWriter(d.room, { team: d.team, lights, armed: d.requireArm ? false : undefined }) : null
  let lightIds: string[] = []
  // Set for real by start(); the defaults until then, so GET shows a sensible map.
  let displayMap: DisplayMap = { ...DEFAULT_DISPLAYS }
  // The "reference points" run (#91): the marker grid on the table for a
  // few seconds. Here because the runtime holds the three things it needs:
  // the overlay channel, the room camera, and whether we may write to the
  // projector (the owner's arm). The fit itself is the spatial service's.
  const reference = createReferenceRun({
    overlay: d.overlay,
    spatial,
    frame: camera(),
    mayProject: () => !d.requireArm || (writer?.isActive() ?? false),
    // Only the real room has a window: the emulator and tests rehearse any time (AGENTS.md).
    window: d.requireArm ? (d.hardwareWindow ?? (() => devicePool.window())) : undefined,
    settleMs: d.calibrationSettleMs,
    log: (l) => console.log(`[reference] ${l}`),
  })
  // The lidar registration wizard (#lidar-wizard): numbered targets on the
  // table, a finger held on each, then the lidar → table fit. Same three
  // needs and the same gates as the reference run above.
  const lidarRegistration = createLidarRegistration({
    overlay: d.overlay,
    spatial,
    mayProject: () => !d.requireArm || (writer?.isActive() ?? false),
    window: d.requireArm ? (d.hardwareWindow ?? (() => devicePool.window())) : undefined,
    log: (l) => console.log(`[lidar-registration] ${l}`),
  })

  // The lidar registration run (#89 T4): targets on the table one at a time,
  // a held fingertip on each, the fit through the spatial service. The same
  // projector rules as the reference run: the owner's arm and the window.
  const registration = createRegistrationRun({
    overlay: d.overlay,
    spatial,
    mayProject: () => !d.requireArm || (writer?.isActive() ?? false),
    window: d.requireArm ? (d.hardwareWindow ?? (() => devicePool.window())) : undefined,
    log: (l) => console.log(`[registration] ${l}`),
  })

  const applyMood = () => {
    if (!writer) return
    const mood = MOODS[mode === 'error' ? 'idle' : mode]
    for (const id of lightIds) writer.light(id, mood)
  }
  const setMode = (m: Mode) => {
    if (m === mode) return
    mode = m
    applyMood()
  }

  // ---- the lesson's light ----
  // The overlay protocol (@hubble/stage OverlayShape) only knows filled
  // polygons. Rather than widen the protocol in a submodule on demo day, the
  // "next" outline is a filled frame: the key's quad, then the same quad
  // shrunk toward its centre and walked BACKWARDS, joined by a zero-width
  // bridge. Under SVG's default nonzero fill rule the inner area winds +1 -1
  // = 0 and stays dark, so the display draws a ring with no change to it.
  // If a display ever switches to evenodd this still renders as a ring.
  const shrink = (pts: { x: number; y: number }[], f: number) => {
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length
    return pts.map((p) => ({ x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f }))
  }
  // 0.7: a band of ~15 % of the key's width on each side, wide enough to read
  // on a narrow black key yet clearly not a filled (pressable-now) key.
  const keyRing = (pts: { x: number; y: number }[]) => {
    // outer p0→p1→p2→p3→p0, bridge to i0, inner backwards i0→i3→i2→i1→i0,
    // and the implicit close runs back along the bridge to p0.
    const inner = shrink(pts, 0.7)
    return [...pts, pts[0]!, inner[0]!, ...inner.slice(1).reverse(), inner[0]!]
  }
  // The same note twice in a row: a ring would vanish into the green fill, so
  // the "next" marker becomes a small solid dot in the middle of the key.
  const keyDot = (pts: { x: number; y: number }[]) => shrink(pts, 0.3)
  const keyShape = (note: number, color: string): OverlayShape | null => {
    const source = keys ?? (keybed ? keyQuads(keybed) : null)
    if (!source) return null
    const k = source.find((q) => q.note === note)
    return k ? { points: k.corners, color } : null
  }
  const drawLesson = () => {
    const shapes: OverlayShape[] = []
    const next = lesson?.expected() ?? null
    if (next !== null) {
      const s = keyShape(next, GREEN)
      if (s) shapes.push(s)
    }
    // The key after this one, as a ring (or, on a repeated note, a dot on the
    // green key). Drawn after the green so the dot sits on top of it, and
    // before the red so a wrong-key flash still covers it.
    const upcoming = lesson?.upcoming() ?? null
    if (next !== null && upcoming !== null) {
      const k = keyShape(upcoming, NEXT)
      if (k) shapes.push({ points: upcoming === next ? keyDot(k.points) : keyRing(k.points), color: NEXT, intensity: upcoming === next ? 1 : NEXT_INTENSITY })
    }
    if (wrong && now() < wrong.until && wrong.note !== next) {
      const s = keyShape(wrong.note, RED)
      if (s) shapes.push(s)
    }
    d.overlay({ kind: 'overlay', layer: 'lesson', shapes })
  }

  // The launcher (#33): what an open palm opens. Its items are exactly the
  // things that really open today (plan Decision 4). Web surfaces exist (#31)
  // but have no item until there is a way to choose a page; Ask waited on
  // voice (#13), which is archived (branch archive/voice-orb); Assets waits
  // for a way to choose one.
  const launcher = createLauncher({
    surfaces,
    actions: {
      // The swipe keyboard (#29) owns its surface and draft; the launcher only asks it to open.
      keyboard: () => void keyboard.open(),
      // The first song: the launcher has no room for a song list, and the
      // operator panel can still pick another.
      lesson: () => void api.startLesson(Object.keys(SONGS)[0]!),
    },
  })

  const api = {
    surfaces,
    gestures,
    keyboard,
    keyboardInput,
    launcher,
    /**
     * A hand gesture from the input stream. The launcher looks first (it
     * owns wakes and every gesture on its box); what is left is #32's.
     * Returns whether something took it.
     */
    gesture(g: TableGesture): boolean {
      // A tap on open table or on another surface moves the keyboard's
      // target away from the page. Not a tap on the keys (region keys /
      // candidates): typing must not unfocus what is being typed into.
      if (g.type === 'tap' && g.region === 'surface' && focused) {
        const id = hitTest(surfaces.list(), g.p)
        const kind = id ? surfaces.list().find((s) => s.id === id)?.kind : undefined
        if (kind !== 'web' && kind !== 'keyboard') focused = null
      }
      if (launcher.onGesture(g)) return true
      // Everything else on the table: move, flick away, tap, scroll (#32).
      return gestures.handle(g)
    },
    /** A page that just opened becomes the keyboard's target (webRoutes onOpen). */
    focusWeb(id: string) {
      focused = id
    },
    /** The page SEND types into, if it is still on the table. */
    focusedWeb,
    state: () => ({
      mode,
      act,
      focusedWeb: focusedWeb(),
      lesson: lesson ? { song: lesson.song.title, ...lesson.progress(), expected: lesson.expected(), upcoming: lesson.upcoming() } : null,
      keybed,
      keySource,
      keys: keys?.length ?? 0,
      // How old the camera's measurement is, so the operator sees an outage
      // (camera-stale) and how long the light has been running on it.
      keysAgeMs: (keySource === 'camera' || keySource === 'camera-stale') && measuredAt !== null ? now() - measuredAt : null,
    }),
    /** When things last happened, for the operator panel's status. */
    health: () => ({ lastRender, lastMidiAt, duplicateNotes }),
    pianoState: () => piano.state(!!camera(), spatial.calibration.cameraTransform() !== null),
    setPianoEnabled(enabled: boolean) {
      if (!piano.setEnabled(enabled)) return false
      // Invalidate before clearing: a slow Python response must not relight
      // a keyboard the operator just disabled. Calibration survives the
      // toggle, but old positions cannot count as this session's detection.
      generation++
      keys = null
      keybed = null
      keySource = null
      measuredAt = null
      drawLesson()
      return true
    },

    /**
     * The iPad worksheet's check ruler (#60): a 10 cm bar of light beside the
     * iPad, or none. Here because the runtime is the one writer of overlay
     * light; worksheet.ts decides where the iPad is and asks. Its own layer,
     * so it never clears or is cleared by the lesson's keys.
     */
    setRuler(box: Box | null) {
      d.overlay({ kind: 'overlay', layer: 'ruler', shapes: box ? rulerShapes(box, DEFAULT_SURFACE) : [] })
    },

    /** Where the MiniLab's keybed is, in projector px (simulator object now; camera or calibration taps on site). */
    setKeybed(k: Keybed | null) {
      generation++
      keybed = k
      // Set by hand (the bench's simulator, or two taps on site): it is what
      // the operator says, so it replaces any detected keys until the camera
      // finds the keyboard again on a later look.
      keys = null
      keySource = k ? 'manual' : null
      drawLesson()
    },

    startLesson(songId: string): Song | null {
      // Own keys only: `SONGS['constructor']` is Object.prototype's, and a
      // lesson built on it has no notes, so the next state() threw outside
      // Express's error handling and the operator page's 1 s status poll took
      // the whole server down (review #40, finding 1). Checked here, in the
      // one place a lesson is created, so every route that starts one is
      // covered, not just the route that happened to be reviewed.
      if (!Object.hasOwn(SONGS, songId)) return null
      const song = SONGS[songId]!
      act = 'lesson'
      lesson = createLesson(song)
      wrong = null
      drawLesson()
      return song
    },
    stopLesson() {
      act = 'math'
      lesson = null
      wrong = null
      drawLesson()
    },

    /**
     * A key event from the MIDI integration (#19). Note-off is ignored: the
     * lesson advances on the press, which is what a learner feels as "I hit it".
     */
    midi(e: { type: 'note-on' | 'note-off'; note: number; velocity: number }) {
      // Counted before the lesson check: the operator wants to know the
      // keyboard is alive even while no lesson is running.
      if (e.type === 'note-on' && e.velocity > 0) lastMidiAt = now()
      if (e.type === 'note-on' && e.velocity > 0) {
        // One press can arrive twice: on site (2026-10-07) a correct press
        // advanced the lesson and then flashed the same key red, i.e. a
        // second note-on of the pressed note judged against the *next*
        // expected note. Likely sources: the MiniLab 3 shows up as several
        // MIDI ports and useMidi binds all of them, a second tab with the
        // lesson panel, or key bounce. Whatever the source, the server is the
        // one place every copy passes through, so it drops them here.
        // Ruling: the same note again within 150 ms is a duplicate — no one
        // replays a key that fast (a quick repeated E is ~200 ms+) — cost if
        // wrong: a very fast trill on one key loses a press.
        const t = now()
        if (lastNoteOn && lastNoteOn.note === e.note && t - lastNoteOn.at < DUPLICATE_NOTE_MS) {
          duplicateNotes++
          return null
        }
        lastNoteOn = { note: e.note, at: t }
      }
      if (!lesson || e.type !== 'note-on' || e.velocity === 0) return null
      const r = lesson.press(e.note)
      if (r.kind === 'wrong') {
        wrong = { note: e.note, until: now() + FLASH_MS }
        if (flashTimer) clearTimeout(flashTimer)
        // Redraw when the red flash ends, so it doesn't linger on the key.
        flashTimer = setTimeout(drawLesson, FLASH_MS + 10)
      } else wrong = null
      drawLesson()
      return r
    },

    /**
     * Calibrate camera → projector: light 9 dots at known projector pixels,
     * photograph them, solve. Run during our slot with the table otherwise
     * dark. Returns the RMS reprojection error in projector px.
     */
    async calibrate(opts: { record?: (name: string, jpeg: Uint8Array) => void } = {}): Promise<CalibrationRun> {
      const frame = camera()
      if (!frame) return { ok: false, error: 'no camera (set HUBBLE_ROOM_CAMERA_URL, or run with a room)', dots: [], ms: 0 }
      // One run at a time: a second press while dots are being lit would
      // interleave its dots with ours and pair the wrong frames.
      if (calibrating) return { ok: false, error: 'a calibration is already running', dots: [], ms: 0 }
      calibrating = true
      try {
        const run = await runCalibration({
          overlay: (shapes) => d.overlay({ kind: 'overlay', layer: 'calibration', shapes }),
          frame,
          dots: bootDots(DEFAULT_SURFACE.widthPx, DEFAULT_SURFACE.heightPx),
          settleMs: d.calibrationSettleMs,
          record: opts.record,
          log: (l) => console.log(`[calibrate] ${l}`),
        })
        if (run.ok && run.h) {
          spatial.calibration.setCamera({ h:run.h, width:run.cameraGeometry!.width, height:run.cameraGeometry!.height, geometry:'room:full-frame' })
          // A capture started under the old transform must never relight keys
          // after calibration changes. Camera-space inspection remains valid,
          // but projector-space geometry must be measured again through H.
          generation++
          keys = null
          keybed = null
          keySource = null
          measuredAt = null
          drawLesson()
          lastCalibration = { rms: run.rms!, at: new Date().toISOString(), dots: run.dots.length, seen: run.dots.filter((x) => x.seen).length, source: 'measured' }
          // A fresh live run wins over the standard immediately, and for the
          // rest of this boot, whether or not the file write below succeeds.
          calibrationSource = 'measured'
          mkdirSync(calFile.replace(/\/[^/]+$/, ''), { recursive: true })
          writeFileSync(calFile, JSON.stringify({ cameraToProjector: run.h, cameraGeometry:run.cameraGeometry, rms: run.rms, measuredAt: lastCalibration.at, dots: run.dots }, null, 1))
        }
        return run
      } finally {
        calibrating = false
      }
    },
    /**
     * One test dot on the calibration layer (null clears it): to see on the
     * table, by eye or camera, that our page is up and how long a change
     * takes to show, before trusting a run's timing.
     */
    testDot(at: { x: number; y: number } | null) {
      d.overlay({ kind: 'overlay', layer: 'calibration', shapes: at ? [dotShape(at, 40)] : [] })
    },
    /**
     * Reference markers on the table (#91): on = project and localize for a
     * few seconds (refused unarmed on the real room), off = clear now.
     */
    reference(on: boolean, opts: { record?: (name: string, jpeg: Uint8Array) => void } = {}) {
      return on ? reference.start(opts) : { ok: true, state: reference.stop() }
    },
    referenceState: () => reference.state(),
    /** The lidar registration wizard (spatial/lidarWizard.ts). */
    lidarRegistration,
    /** The lidar registration run (#89 T4): start, cancel, and what it's doing. */
    registration,
    /** The saved calibration's quality, for the operator. */
    calibration: () => lastCalibration,
    /** Which calibration is in use: a live measurement, the committed standard, or none. */
    calibrationSource: () => calibrationSource,

    /**
     * One look through the camera: the scene objects and the MiniLab's keys.
     * The same frame goes to perceive.ts (notebook, and the fallback keybed)
     * and to the keybed sidecar (every key, measured).
     */
    async look() {
      // Coalesce: join the in-flight look rather than start and cancel one.
      // The check is synchronous, so no two callers can both get past it.
      if (lookInFlight) return lookInFlight
      const started = (async () => {
      const source = camera()
      const h = spatial.calibration.cameraTransform()
      if (!source || (!h && !piano.enabled())) return seen
      looksInFlight++
      try {
        const mine = ++generation
        let frame: Uint8Array
        try {
          frame = await source()
        } catch {
          if (mine === generation && piano.enabled()) {
            piano.cameraFailed()
            if (keySource === 'camera') keySource = 'camera-stale'
          }
          return seen
        }
        if (mine !== generation) return seen
        const capturedAt = now()
        // Camera inspection works before calibration; only projection needs H.
        // Off still allows ordinary scene perception for the math act, without
        // asking Python or populating the lesson's fallback keybed.
        const track = piano.enabled() && d.keybed ? await d.keybed.track(frame) : null
        // Everything after the awaits commits state, so it all waits for this
        // check: superseded by a newer look or a manual placement, this frame
        // is old news and changes nothing.
        if (mine !== generation) return seen
        let fresh = false
        if (piano.enabled()) {
          try { fresh = piano.accept(frame, track, capturedAt) }
          catch { piano.cameraFailed(); return seen }
        }
        if (!h) return seen
        const objs = observe(frame, h, DEFAULT_SURFACE.mmPerPx)
        seen = objs.map((o) => ({ id: o.kind === 'keyboard' ? 'minilab' : 'notebook', kind: o.kind, label: o.kind === 'keyboard' ? 'MiniLab 3 keyboard' : undefined, box: o.box }))
        const kb = objs.find((o) => o.kind === 'keyboard')?.keybed
        if (kb && piano.enabled()) keybed = kb

        // A failed sidecar falls back to perceive's keybed. A track without keys
        // (still searching, or lost with nothing ever found) leaves the keys we
        // have; the tracker itself already keeps its last good pose through
        // hands, and the runtime must not undo that.
        if (fresh && track?.keys) {
          // Camera px → projector px through the saved calibration. Corner
          // order is kept (near-left, near-right, far-right, far-left), which
          // the overlay and any hit-test rely on.
          keys = track.keys.map((k) => ({ note: k.note, black: k.black, corners: k.corners.map((p) => apply(h, p)) as KeyQuad['corners'] }))
          keySource = 'camera'
          measuredAt = capturedAt
        } else if (piano.enabled() && !fresh && (keySource === 'camera' || keySource === 'camera-stale')) {
          // A failed request, lost pose or searching answer is not a new
          // measurement. The keys stay where the
          // camera last measured them, marked stale, until it answers again.
          // Falling back to perceive here dropped the light or lit 4 of 15
          // notes beside their key on the same frame (manager verification,
          // #41). Ruling: keep-last-good — a keyboard being played doesn't
          // move, and a stale but right light beats a fresh wrong one — cost if
          // wrong: a keyboard moved during an outage stays lit at its old place
          // until the next good answer.
          keySource = 'camera-stale'
        } else if (piano.enabled() && !keys && kb) keySource = 'perceive'

        // The keyboard as a scene object, for the math act's layout to avoid.
        // perceive's whole body (pads, knobs and faders included) when it saw
        // one: key light and occupied space are different geometry, and the
        // keys' box alone left the control panel "free" (review #41). Only when
        // perceive didn't recognise the body do the keys' bounds stand in.
        if (keys && !seen.some((o) => o.kind === 'keyboard')) {
          const xs = keys.flatMap((k) => k.corners.map((p) => p.x))
          const ys = keys.flatMap((k) => k.corners.map((p) => p.y))
          const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
          seen = [...seen.filter((o) => o.kind !== 'keyboard'), { id: 'minilab', kind: 'keyboard', label: 'MiniLab 3 keyboard', box }]
        }
        drawLesson()
        return seen
      } finally {
        looksInFlight--
      }
      })()
      lookInFlight = started
      try {
        return await started
      } finally {
        if (lookInFlight === started) lookInFlight = null
      }
    },
    seen: () => seen,
    calibrated: () => spatial.calibration.cameraTransform() !== null,

    /** Called around every brain render, so the lights follow what the table is doing. */
    renderStarted: () => {
      renderT0 = now()
      setMode('thinking')
    },
    renderFinished: (ok: boolean) => {
      if (renderT0 !== null) lastRender = { ok, ms: now() - renderT0, at: now() }
      renderT0 = null
      setMode(ok ? 'answering' : 'error')
    },
    setMode,
    /**
     * The table was emptied on purpose (operator close-all, act switch,
     * reset). Clearing aborts an answer still being written, and an aborted
     * render never sends its done line, so without this the lights and the
     * operator's status stayed on "thinking" for good (review #40,
     * finding 4). An empty table is idle; the unfinished render is not
     * counted in health, because it neither succeeded nor failed.
     */
    tableCleared() {
      renderT0 = null
      setMode('idle')
    },

    /**
     * The operator's "room output" switch. Arming puts our pages and mood on
     * the room at once (everything start() asked for is kept as desired);
     * disarming stops every later write and leaves the room as it is.
     */
    arm(on: boolean) {
      writer?.arm(on)
      // Disarm ends a reference run now (review of #95, finding 3): the
      // grid is a projector write like any other, and "disarmed" must mean
      // nothing of ours is being drawn, not "nothing new".
      if (!on) {
        reference.end()
        lidarRegistration.end()
        registration.end()
      }
      return api.roomOutput()
    },
    /** Whether we may write to the room now, and whether that needs arming at all. */
    roomOutput: () => ({ room: d.room?.kind ?? null, requiresArm: Boolean(d.requireArm), active: writer?.isActive() ?? false }),

    /** What each room display is meant to show (displays.ts owns the choices). */
    displays: (): DisplayMap => ({ ...displayMap }),
    /**
     * May the overall view's Live switch point the real displays now? The
     * answer is ONLY about whether a push could reach a device; the push
     * itself is setDisplay (the existing path), whose arm and pool gates stay
     * exactly as they were. Refused here, with the reason spelled out:
     * - no room attached (ROOM=none): there is no device to push to;
     * - the real room outside the hardware window (n:10–n:30): the pool would
     *   refuse every write anyway, and "Live" must not look on when it isn't.
     * The emulator has no window (AGENTS.md: rehearse any time).
     */
    liveGate(): { ok: true } | { ok: false; reason: string } {
      if (!d.room) return { ok: false, reason: 'no room is attached (ROOM=none): there is no real display to push to' }
      if (d.requireArm) {
        const w = (d.hardwareWindow ?? (() => devicePool.window()))()
        if (!w.open) return { ok: false, reason: `the hardware window is shut (${WINDOW_LABEL} Stockholm; next opens ${new Date(w.opensAt).toISOString()})` }
      }
      return { ok: true }
    },
    /**
     * The Setup control's re-point of one display. Through the SAME slot-gated
     * writer as start(): disarmed, it is only remembered (and applied when the
     * owner arms); armed, it is written now, and the device pool still holds
     * every write to the hardware window. Never a second path to the TVs.
     */
    async setDisplay(id: DisplayId, page: DisplayPage) {
      displayMap[id] = page
      // `manual`: someone runs this display by hand (displays.ts), so nothing is written.
      if (page !== 'manual' && writer && d.room) await writer.show(id, commandFor(page, webOrigin(d.publicBase) ?? `http://localhost:${WEB_PORT}`))
      return api.displays()
    },

    /** Connect to the room: point displays at our pages, follow slots, run the lights. */
    async start(map: Partial<DisplayMap> = DEFAULT_DISPLAYS) {
      // Partial: a test (or a table-only setup) names only the displays it drives; the rest stay untouched.
      displayMap = { ...displayMap, ...map }
      // A separately configured camera also works without room output. Its
      // refresh loop must start before the display/light transport guard.
      if (d.autoTick !== false && camera()) {
        const l = setInterval(() => {
          if (looksInFlight === 0) void this.look().catch(() => undefined)
        }, 2000)
        stops.push(() => clearInterval(l))
      }
      if (!d.room || !writer || !lights) return
      const base = webOrigin(d.publicBase) ?? `http://localhost:${WEB_PORT}`
      const info = await d.room.info().catch(() => null)
      lightIds = info?.lights.map((l) => l.id) ?? []
      writer.syncSlots(await d.room.slots().catch(() => []))
      // Every display from the one map (displays.ts): the projector's /table,
      // TV 1's control-panel mirror, TV 2's data wall, unless the config says
      // otherwise. Desired state in the writer, so arming applies all three.
      // A `manual` display is never written, so arming can't take it over.
      for (const [id, page] of Object.entries(map)) if (page && page !== 'manual') await writer.show(id as DisplayId, commandFor(page, base))
      applyMood()
      stops.push(
        d.room.events((e) => {
          if (e.type === 'slot') writer.onSlotEvent(e.team, e.until)
        }),
      )
      if (d.autoTick !== false) {
        const t = setInterval(() => void lights.tick(), 25)
        stops.push(() => clearInterval(t))
      }
    },
    stop() {
      // First, while the overlay channel and spatial service still work:
      // the grid's clear and the localizer's end-of-run (anchors) need both.
      reference.end()
      lidarRegistration.end()
      registration.end()
      lidarGestures.reset()
      keyboardInput.stop()
      stopTouches()
      spatial.stop()
      stops.forEach((s) => s())
      if (flashTimer) clearTimeout(flashTimer)
    },
  }
  return api
}

export type Runtime = ReturnType<typeof createRuntime>
