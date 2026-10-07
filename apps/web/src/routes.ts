/**
 * Which face of the app a path shows. Plain pathname routing: a router is
 * not worth a dependency for a few static routes.
 *
 * Only `/` is the bench. Any other unknown path shows nothing, on purpose:
 * until 7 Oct every unknown path fell through to the bench, and once the
 * voice orb's /hubble left main (branch archive/voice-orb) that mattered.
 * On the owner's alex/aixia-sim branch /hubble is back, named
 * explicitly (the orb screen the puppet master speaks through), alongside
 * Liquid Studio at /studio and /studio/projector. They are named routes, so
 * the fall-through-to-bench problem above does not return.
 * The emulator (and a room) can still have a TV pointed at /hubble from an
 * older server; the bench's room panel frames each display's page, so it
 * framed a second bench, which on load sent its own default scene to the
 * emulator and replaced the real bench's (review of #61). A blank page also
 * suits a projector or TV: black is no light at all.
 */
export type Page = 'bench' | 'table' | 'spatial' | 'ipad-camera' | 'to-bench' | 'hubble' | 'studio' | 'studio-projector' | 'lab' | 'tv' | 'datawall' | 'pitch' | 'overall' | 'none'

export function pageFor(pathname: string): Page {
  if (pathname === '/' || pathname === '/index.html') return 'bench'
  if (pathname === '/table') return 'table'
  // /operator was the show's control page until it became the bench's show
  // column (#66). A redirect, not 'none': the README, older plans and the
  // owner's bookmarks on the show laptop still say /operator, and a blank
  // page there would look like the show controls were gone.
  if (pathname === '/operator') return 'to-bench'
  // The camera/lidar/projector workbench (H41's spatial service, #59).
  if (pathname === '/spatial') return 'spatial'
  // The iPad on a stand as a second camera (#91). Opened over https on the
  // same :5173 (apps/web/tls.ts): Safari only grants the camera there.
  if (pathname === '/ipad-camera') return 'ipad-camera'
  // Owner's branch: the voice orb and Liquid Studio (docs/LIQUID-STUDIO.md).
  if (pathname === '/hubble') return 'hubble'
  if (pathname === '/studio') return 'studio'
  if (pathname === '/studio/projector') return 'studio-projector'
  // Hubble Lab: standalone demos (live transcription, forced-speech assistant)
  // for testing one piece of the voice stack at a time. Named explicitly like
  // /studio so the unknown-path-shows-nothing rule above still holds.
  if (pathname === '/lab') return 'lab'
  // The two room TVs (pi-tv-1/2 kiosk Chromium) show the agent: orb + talk bubble.
  if (pathname === '/tv') return 'tv'
  // TV 2's live data wall (owner, 7 Oct: "a very stylized data dump of all the
  // code stuff on the 2nd tv"); apps/server/displays.ts maps it.
  if (pathname === '/datawall') return 'datawall'
  // TV 2's looped pitch video (7 Oct).
  if (pathname === '/pitch') return 'pitch'
  // All three screens in iframes, with touch simulation on the projector (owner, 7 Oct;
  // docs/plans/2026-10-07-overall-view.md). Named, so unknown paths still show nothing.
  if (pathname === '/overall') return 'overall'
  return 'none'
}
