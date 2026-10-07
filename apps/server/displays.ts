import type { DisplayCommand, DisplayId } from '@hubble/room'

/**
 * Which of our pages each room display shows: THE ONE OWNER of that mapping.
 *
 * Owner, 7 Oct: "make it so that the control panel is being projected in to
 * one of the tvs, so that when i navigate around the control panel that is on
 * one tv hubble voice is the second". So by default:
 *
 * - the projector (`table`) shows /table, as it always has;
 * - TV 1 shows the control-panel mirror (/?mirror=1), which follows the
 *   operator's real browser (operatorUi.ts) and takes no input of its own;
 * - TV 2 shows /datawall: the live data wall (lidar radar, the model's raw
 *   stream, every event channel, the numbers). Scope correction (owner, via
 *   H46, 7 Oct): "a very stylized data dump of all the code stuff on the 2nd
 *   tv, so just data that we have to impress people in a cool way". It was
 *   /tv (the voice orb and bubble) before that; /tv stays as a choice.
 *
 * Why a page NAME and not a URL here: the laptop's address changes day to day
 * (.17 on 6 Oct, .18 on 7 Oct), so the URL is built at write time from the same
 * base the projector's URL always used (runtime.ts, webOrigin). A name is also
 * what the Setup control offers, so the operator can never type a bad URL onto
 * a shared TV.
 *
 * The display ids are the organisers' (packages/room/src/spec.ts DisplayId);
 * room.config.json `displays` overrides the defaults per display.
 */
export type DisplayPage = 'table' | 'mirror' | 'datawall' | 'tv' | 'pitch' | 'off' | 'manual'
export type DisplayMap = Record<DisplayId, DisplayPage>

export const DISPLAY_IDS: readonly DisplayId[] = ['table', 'tv-1', 'tv-2']
export const DISPLAY_PAGES: readonly DisplayPage[] = ['table', 'mirror', 'datawall', 'tv', 'pitch', 'off', 'manual']

// TV 1 is the data wall with Hubble's voice (owner, 7 Oct 14:40: "the tv one
// screen, go with the data and the hubble bubble"); TV 2 loops our recorded
// pitch (14:41: "the second tv will show a youtube link unlisted video and it
// will be loop where we record our pitch"). The mirror stays a Setup choice.
//
// Then, at the demo (7 Oct 15:50, owner): "change it to not push up the video
// on the tv, and just let my teammate do that manually, DO NOT TAKE OVER any
// hardware". So TV 2 is `manual`: we never write to it at all, not even a
// blank. `manual` means hands off; `off` would still push a black screen.
export const DEFAULT_DISPLAYS: DisplayMap = { table: 'table', 'tv-1': 'datawall', 'tv-2': 'manual' }

/** The path each page lives at on the web app's one port (:5173, AGENTS.md "One port for people"). */
export const PAGE_PATH: Record<Exclude<DisplayPage, 'off' | 'manual'>, string> = {
  table: '/table',
  // A query flag on `/`, not a new route: the mirror IS the operating surface,
  // drawn from the operator's published state, so it must stay the same code.
  mirror: '/?mirror=1',
  datawall: '/datawall',
  tv: '/tv',
  // The pitch video, looped (PitchPage.tsx); which video is room.config.json's `pitch.youtube`.
  pitch: '/pitch',
}

export const isDisplayId = (v: unknown): v is DisplayId => typeof v === 'string' && (DISPLAY_IDS as readonly string[]).includes(v)
export const isDisplayPage = (v: unknown): v is DisplayPage => typeof v === 'string' && (DISPLAY_PAGES as readonly string[]).includes(v)

/**
 * The defaults with room.config.json's `displays` block laid over them. A bad
 * entry (unknown display or page) is ignored, not fatal: a typo in the config
 * must never stop the server from booting on demo day.
 */
export function displaysFromConfig(config: unknown): DisplayMap {
  const out: DisplayMap = { ...DEFAULT_DISPLAYS }
  const block = (config as { displays?: unknown } | null)?.displays
  if (!block || typeof block !== 'object') return out
  for (const [id, page] of Object.entries(block)) if (isDisplayId(id) && isDisplayPage(page)) out[id] = page
  return out
}

/**
 * The room command for a page. `off` is a black screen (`blank`), not the
 * organisers' `idle` screen: "off" on a projector means no light on the table,
 * and black is no light at all.
 */
export function commandFor(page: Exclude<DisplayPage, 'manual'>, base: string): DisplayCommand {
  if (page === 'off') return { type: 'blank' }
  return { type: 'url', url: `${base.replace(/\/+$/, '')}${PAGE_PATH[page]}` }
}
