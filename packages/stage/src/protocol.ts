import type { Scene } from './scene.ts'
import type { TableSurface } from './surfaces.ts'

/**
 * The wire contract between the parser (server) and the renderer (table).
 *
 * The renderer never sees model text. It only receives these events, each of
 * which describes something that is already complete and valid. That is the
 * whole point of the engine: a half-written tag, attribute or LaTeX string can
 * never reach the projector, because nothing here can carry one.
 */

/**
 * How a component streams.
 * - `container`: shown as soon as its opening tag is complete (an empty frame
 *   is a fine thing to show); children fill in afterwards.
 * - `whole`: shown only once its closing tag has arrived, so it is never seen
 *   half-made. Math lives here: partial TeX does not typeset.
 * - `words`: prose. Shown word by word, because a partial *word* is the
 *   smallest unit that still reads as intentional.
 */
export type Policy = 'container' | 'whole' | 'words'

export type AttrValue = string | number | boolean
export type Attrs = Record<string, AttrValue>

export type StageEvent =
  /** A container or words element was mounted (its opening tag completed). */
  | { type: 'open'; id: string; tag: string; attrs: Attrs; parent: string | null }
  /** Words appended to an open `words` element. Always whole words plus their trailing space. */
  | { type: 'text'; id: string; text: string }
  /** A container or words element finished. */
  | { type: 'close'; id: string }
  /** A whole element, complete: body is its full inner text (TeX for Math). */
  | { type: 'piece'; id: string; tag: string; attrs: Attrs; body: string; parent: string | null }
  /** Something was refused. Never rendered; logged so prompt problems are visible. */
  | { type: 'drop'; reason: DropReason; detail: string }
  /** The stream is over. `truncated` means the model stopped mid-element. */
  | { type: 'end'; reason: 'complete' | 'truncated' }

export type DropReason =
  | 'unknown-tag'
  | 'not-allowed-here'
  | 'bad-attribute'
  | 'expression'
  | 'stray-text'
  | 'unfinished'
  | 'malformed'

/** `POST /api/render` body. */
export interface RenderRequest {
  /** What to show, phrased as a request ("solve the task in my notebook"). */
  intent: string
  /** Optional image of the table area, as a data URL (image/jpeg or image/png). */
  image?: string
  /** Earlier turns, oldest first, so follow-ups ("next step") have context. */
  history?: { intent: string; answer: string }[]
  model?: 'aixia-labs' | 'aixia-code'
  thinking?: boolean
  /** What lies on the table and where. The model lays out its answer around it. */
  scene?: Scene
}

/**
 * One line of the render stream. `POST /api/render` answers with these as
 * NDJSON, and `GET /api/stage/events` re-broadcasts every line as SSE so table
 * displays mirror whatever is being rendered. `t` is ms since the render began.
 */
export type RenderStreamLine =
  /** Carries the scene so every display resolves object-relative marks the same way. */
  | { kind: 'start'; renderId: string; intent: string; model: string; t: 0; scene?: Scene }
  /** The raw model delta, for the debug view only. Displays must ignore it. */
  | { kind: 'raw'; renderId: string; t: number; text: string }
  | { kind: 'event'; renderId: string; t: number; event: StageEvent }
  | { kind: 'error'; renderId: string; t: number; message: string }
  /** One step of the brain's loop (draft, report, correction, review), for the agent tab. Displays ignore it. */
  | { kind: 'trace'; renderId: string; t: number; step: string; detail: string; data?: unknown }
  | { kind: 'done'; renderId: string; t: number; answer: string; firstContentMs: number | null }


/**
 * Light the runtime draws itself, beside (not inside) the model's answer: the
 * piano lesson's green next key and red wrong key. Its own line type on the
 * same display stream, not a RenderStreamLine: it belongs to no render, changes
 * per keypress, must not go through the model, and must survive a new answer
 * being rendered. Each line replaces that layer's shapes; [] clears it.
 */
export interface OverlayLine {
  kind: 'overlay'
  layer: string
  shapes: OverlayShape[]
}

/** A filled polygon in projector pixels, e.g. one key's box on the real keyboard. */
export interface OverlayShape {
  points: { x: number; y: number }[]
  /** CSS colour of the light. */
  color: string
  /** 0–1; flashes fade by sending lower values. */
  intensity?: number
}

/**
 * A finger on the table, as the server's spatial service saw it through the
 * lidar (Juliusolsson05/hubble#89): what the display draws a ripple of light
 * from. Its own line kind, and deliberately NOT an overlay:
 *
 * - An overlay is state ("this key is lit"). The hub keeps the latest one per
 *   layer and replays it to every display that (re)connects. A touch is an
 *   event that happened at one moment; replayed to a projector that reconnects
 *   a minute later, it would ripple at a spot nobody is touching.
 * - So the hub broadcasts touch lines and stores none, and the browser's shared
 *   stream (apps/web stageStream.ts) never puts them in its catch-up buffer.
 *   Both rules exist for the same reason; break either and old ripples replay.
 *
 * `p` is in projector page pixels (the same frame as overlays and surfaces).
 * Sizes are the display's business, in mm through the Surface's mm/px.
 * `id` is the server's track id: `down` starts a touch, `move` follows it,
 * `up` ends it, `cancel` ends it without meaning anything (the lidar
 * reconnected, or the baseline or registration changed under it).
 */
export interface TouchLine {
  kind: 'touch'
  id: number
  phase: 'down' | 'move' | 'up' | 'cancel'
  p: { x: number; y: number }
}

/**
 * Everything on the table (answers, assets, webpages, keyboard, launcher), as
 * one line on the display stream, next to `overlay`. Always the whole set:
 * it is small (well under 20 surfaces), and a full snapshot can't be applied
 * out of order or half-way, which a diff stream would make possible after a
 * reconnect. `rev` only grows, so a display drops a line older than the one
 * it already has (a replay racing a live update).
 */
export interface SurfacesLine {
  kind: 'surfaces'
  rev: number
  surfaces: TableSurface[]
}
