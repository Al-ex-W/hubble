import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

/**
 * Outside packages/room, nothing opens a connection to a room device: the
 * device pool (#73) does. Oracle: the source text, read with a regex
 * independent of the pool. Label: the source tree. packages/room has its own
 * twin of this test (pool.architecture.test.ts).
 *
 * Each allow-list entry says why its raw primitive never reaches a device.
 */
const ROOT = new URL('../..', import.meta.url).pathname
const RAW = /(?<![\w.])fetch\(|globalThis\.fetch\(|\bnew WebSocket\(|(?<![\w.])request\(|\bhttps?\.(request|get)\(|\bnet\.connect\(/
const ALLOW: Record<string, string> = {
  'apps/server/worksheet.ts': 'the iPad worksheet server on 127.0.0.1 (loopback, ours)',
  'scripts/spatial-record.ts': 'our own server, /api/spatial on loopback',
  'scripts/mic-wave-demo.mjs': 'the owner\'s mic-wave demo SERVES pages and WebSockets on this laptop (TVs and browsers connect to it); its only outbound socket is the listener-to-renderer bridge on ws://127.0.0.1 (loopback), and its `new WebSocket(` text inside the page templates runs in the viewer\'s browser against the laptop it was loaded from',
  'scripts/lidar-live.ts': 'our own server on loopback only (it refuses a non-loopback HUBBLE_SERVER); the server reaches the lidar through the pool',
  'scripts/hubble-cli/index.ts': 'the hubble CLI talks only to our own server over HTTP (HUBBLE_URL, default localhost:8787); the server reaches devices through the pool',
  'apps/server/readTask.ts': 'the vision-model gateway (internet, HUBBLE_LLM_BASE_URL), not the room; the camera frame it reads comes through the pool',
  'scripts/demo.ts': 'the demo boot talks only to our own server on localhost (health, arm); the server reaches devices through the pool',
  'scripts/hands-assets.mjs': 'downloads the MediaPipe model from its CDN (internet, not the room)',
}
// Comments are stripped so docs may name primitives and hosts. A `//` after
// a colon is a URL (http://192.168…), not a comment: stripping it hid the
// very device address this test looks for (a mutant survived on that).
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/.*$/gm, '')
const sources = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' || e.name === 'fixtures' ? [] : e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !dir.includes('testing') ? [join(dir, e.name)] : [],
  )

it('only the device pool opens connections from the server and the scripts', () => {
  // Break caught: a server route or script calling fetch / node:http / ws
  // directly, which works at :45 while the pool refuses everything else.
  const files = [...sources('apps/server'), ...sources('scripts')]
  expect(files.length).toBeGreaterThan(20) // a moved tree must not pass by scanning nothing
  expect(files.filter((f) => !ALLOW[f] && RAW.test(strip(readFileSync(join(ROOT, f), 'utf8'))))).toEqual([])
})

it('the browser code names no room device', () => {
  // Break caught: a page opening a device directly (the Pi's own MJPEG, a
  // lidar socket). No server-side pool can refuse that; pages must go
  // through the server's proxies (AGENTS.md).
  const files = sources('apps/web/src')
  expect(files.length).toBeGreaterThan(20)
  const device = /192\.168\.\d+\.\d+|\b[\w-]+\.local\b/
  expect(files.filter((f) => device.test(strip(readFileSync(join(ROOT, f), 'utf8'))))).toEqual([])
})
