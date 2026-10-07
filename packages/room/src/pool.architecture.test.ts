import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

/**
 * Nothing in this package opens a network connection except the device pool
 * (Juliusolsson05/hubble#73). Oracle: the source text itself, read with a
 * regex, independent of the pool's code. Label: the source tree, a recording
 * of what the package does.
 *
 * Why a test and not a convention: the pool can be exactly right while a
 * caller goes around it. pis.ts arrived on the morning the rule was written,
 * with five raw fetches. Each entry in the allow-list says why that primitive
 * is not a room device.
 */
const ROOT = new URL('..', import.meta.url).pathname
// Bare primitives, or reached through their modules. `pool.fetch(` and
// `pool.request(` are the allowed route, hence the lookbehind on a dot;
// globalThis and node:http(s) spellings are named explicitly so they can't slip past it.
const RAW = /(?<![\w.])fetch\(|globalThis\.fetch\(|\bnew WebSocket\(|(?<![\w.])request\(|\bhttps?\.(request|get)\(|\bnet\.connect\(/
const ALLOW: Record<string, string> = {
  'src/pool.ts': 'the pool itself: the one place allowed to open device connections',
  'scripts/room-check.ts': 'its raw fetch probes the internet (the model gateways), not a device; its room calls go through createLiveRoom',
}

const sources = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|mjs|js)$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : [],
  )

it('only the device pool opens connections in packages/room', () => {
  // Break caught: a transport (or a script) calling fetch / ws / node:http
  // directly, so it works at :45 while everything else is refused. Comments
  // are stripped first, so the docs may name the primitives.
  const files = [...sources('src'), ...sources('scripts')]
  expect(files.length).toBeGreaterThan(10) // a moved tree must not pass by scanning nothing
  const raw = files.filter((f) => !ALLOW[f] && RAW.test(readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/.*$/gm, '')))
  expect(raw).toEqual([])
})
