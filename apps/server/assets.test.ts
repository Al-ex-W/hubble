import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SURFACE as DEFAULT_SURFACE_FOR_TEST, type RenderRequest, type SurfacesLine } from '@hubble/stage'
import type { ServerConfig } from './config.ts'
import { createApp } from './index.ts'
import { DEFAULT_LIBRARY, loadLibrary } from './assets.ts'
import { createSurfaceManager } from './surfaces.ts'
import { assetRenderer } from '../web/src/table/assetRenderer.tsx'

/**
 * The asset library (#30): what it accepts, what it serves, and that the
 * brain always gets the server's library, never the client's. Labels: the
 * committed library (assets/library, real files) and synthetic manifests in a
 * temp dir for the refusals.
 */
const config: ServerConfig = { port: 0, llm: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'aixia-labs' }, jevApiKey: undefined }

function tempLibrary(entries: unknown[], files: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'hubble-assets-'))
  for (const f of files) writeFileSync(join(dir, f), 'x')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'inner.png'), 'x')
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ assets: entries }))
  return dir
}
const ok = (over: Record<string, unknown> = {}) => ({ id: 'a', kind: 'image', title: 'A', file: 'a.png', widthMm: 100, heightMm: 50, ...over })

describe('loadLibrary', () => {
  it('loads the committed library: three real assets with their aspect and URL', () => {
    const lib = loadLibrary(DEFAULT_LIBRARY)
    expect(lib.list().map((a) => a.id)).toEqual(['right-triangle', 'unit-circle', 'worksheet']) // pinned
    expect(lib.get('right-triangle')).toMatchObject({ aspect: 0.75, url: '/api/assets/right-triangle/file', type: 'image/svg+xml' })
  })

  it.each([
    ['a path out of the library', { file: '../secret.png' }],
    ['a subfolder', { file: 'sub/inner.png' }],
    ['a hidden file', { file: '.env' }],
    // Allowed extension, so only the leading-dot guard stops it (review #43:
    // '.env' was already refused by its extension and proved nothing).
    ['a hidden file with a served extension', { file: '.secret.png' }],
    ['an unknown kind', { kind: 'pdf' }],
    ['a file type that is not served', { file: 'a.html' }],
    ['a missing file', { file: 'gone.png' }],
    ['an id with spaces', { id: 'not ok' }],
    ['a zero size', { widthMm: 0 }],
    ['a negative height', { heightMm: -50 }],
  ])('skips an entry with %s', (_name, over) => {
    // Break caught: a manifest line turning the asset route into a way to
    // read any file on the laptop, or an entry nobody can draw.
    const lib = loadLibrary(tempLibrary([ok(over)], ['a.png', 'a.html', '.env', '.secret.png']), () => {})
    expect(lib.list()).toEqual([])
  })

  it('keeps the first of two entries with the same id', () => {
    // Break caught: a later manifest line silently replacing an asset the
    // model was already told about.
    const lib = loadLibrary(tempLibrary([ok(), ok({ title: 'B', widthMm: 300 })], ['a.png']), () => {})
    expect(lib.list()).toHaveLength(1)
    expect(lib.get('a')).toMatchObject({ title: 'A', widthMm: 100 })
  })

  it.each([
    ['a null manifest', 'null'],
    ['a null entry beside a good one', JSON.stringify({ assets: [null, ok(), 7, []] })],
  ])('survives %s and keeps what is valid', (_name, manifest) => {
    // Break caught (review #43): valid JSON that is not a manifest threw at
    // startup and took every server route, the math act included, down.
    const dir = tempLibrary([], ['a.png'])
    writeFileSync(join(dir, 'manifest.json'), manifest)
    const lib = loadLibrary(dir, () => {})
    expect(lib.list().map((a) => a.id)).toEqual(manifest === 'null' ? [] : ['a'])
  })
})

async function withServer<T>(brain: unknown, fn: (base: string) => Promise<T>) {
  const server = createApp(config, { brain: brain as never }).listen(0)
  await new Promise((r) => server.once('listening', r))
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    server.closeAllConnections()
    server.close()
  }
}
const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('the library over HTTP', () => {
  it('lists the library and serves only its files, by id', async () => {
    await withServer(undefined, async (base) => {
      const list = (await (await fetch(`${base}/api/assets`)).json()) as { id: string }[]
      expect(list.map((a) => a.id)).toContain('worksheet')
      const file = await fetch(`${base}/api/assets/right-triangle/file`)
      expect(file.status).toBe(200)
      expect(file.headers.get('content-type')).toContain('image/svg+xml')
      expect((await fetch(`${base}/api/assets/..%2F..%2Fpackage.json/file`)).status).toBe(404)
      expect((await fetch(`${base}/api/assets/nope/file`)).status).toBe(404)
    })
  })

  it('gives the brain the server library even when the client sends assets of its own', async () => {
    // Break caught: a client adding an asset (or pointing one at its own URL)
    // through the scene it posts.
    let seen: RenderRequest | undefined
    const brain = {
      render: async (req: RenderRequest, emit: (l: unknown) => void) => {
        seen = req
        emit({ kind: 'start', renderId: 'r', intent: req.intent, model: 'm', t: 0, scene: req.scene })
        emit({ kind: 'done', renderId: 'r', t: 1, answer: '', firstContentMs: null })
      },
    }
    await withServer(brain, async (base) => {
      const scene = { surface: { widthPx: 1920, heightPx: 1080, mmPerPx: 0.78125 }, objects: [], assets: [{ id: 'evil', kind: 'image', title: 'x', aspect: 1, url: 'https://evil.example/x.png' }] }
      await (await post(base, '/api/render', { intent: 'show me the diagram', scene })).text()
      expect(seen?.scene?.assets?.map((a) => a.id)).toEqual(['right-triangle', 'unit-circle', 'worksheet'])
      expect(seen?.scene?.assets?.every((a) => a.url.startsWith('/api/assets/'))).toBe(true)
    })
  })

  it('opens an asset as its own surface at its real size, centred, with what displays need', async () => {
    await withServer(undefined, async (base) => {
      expect((await post(base, '/api/surfaces/asset', { id: 'nope' })).status).toBe(404)
      const line = (await (await post(base, '/api/surfaces/asset', { id: 'right-triangle' })).json()) as SurfacesLine
      const s = line.surfaces.find((x) => x.kind === 'asset')!
      // 200 x 150 mm at the room's 1550/1920 mm/px, centred on 1920 x 1200.
      const w = 200 / (1550 / 1920)
      const h = 150 / (1550 / 1920)
      for (const [k, v] of Object.entries({ x: (1920 - w) / 2, y: (1200 - h) / 2, w, h })) expect(s.box[k as 'x']).toBeCloseTo(v, 6)
      expect(s.state).toMatchObject({ assetId: 'right-triangle', url: '/api/assets/right-triangle/file', kind: 'image' })
    })
  })

  it('the state openAsset publishes is one the table renderer draws', () => {
    // Break caught (review #43): HTTP and renderer tests used separate state
    // fixtures, so dropping `aspect` from the published state made every
    // opened asset invisible with both suites green. Oracle: the renderer.
    let line: SurfacesLine | undefined
    const m = createSurfaceManager({ publish: (l) => (line = l) })
    m.openAsset({ ...loadLibrary(DEFAULT_LIBRARY).get('right-triangle')! })
    const s = line!.surfaces.find((x) => x.kind === 'asset')!
    expect(assetRenderer(s, DEFAULT_SURFACE_FOR_TEST)).not.toBeNull()
  })

  it('opening an asset again raises it where it was moved, not back at the centre', () => {
    // Break caught (review #43): a re-open rebuilt the box at the centre,
    // throwing away where someone had put it.
    let line: SurfacesLine | undefined
    const m = createSurfaceManager({ publish: (l) => (line = l) })
    const lib = loadLibrary(DEFAULT_LIBRARY)
    m.openAsset(lib.get('right-triangle')!)
    m.openAsset(lib.get('unit-circle')!)
    m.move('asset-right-triangle', { dx: 200, dy: 100 })
    m.openAsset(lib.get('right-triangle')!)
    const tri = line!.surfaces.find((x) => x.id === 'asset-right-triangle')!
    const circle = line!.surfaces.find((x) => x.id === 'asset-unit-circle')!
    // Centred (as above), then moved by (200, 100).
    const w = 200 / (1550 / 1920)
    const h = 150 / (1550 / 1920)
    for (const [k, v] of Object.entries({ x: (1920 - w) / 2 + 200, y: (1200 - h) / 2 + 100, w, h })) expect(tri.box[k as 'x']).toBeCloseTo(v, 6)
    expect(tri.z).toBeGreaterThan(circle.z) // raised
  })
})

describe('end to end: the model shows a library asset', () => {
  it('a recorded answer with an Asset reaches the client with the asset, and the scene names the library', async () => {
    // Label: scene-linear-left's recorded answer with one more Panel holding
    // the Asset, in free space at x 1400 (mechanical mutation of a recording),
    // through the real brain with a stand-in model. Its own panel, as the
    // prompt asks: inside the recorded steps panel, the 0.75-aspect diagram
    // adds ~400 px and that answer (rightly) fails the layout guard.
    const { MockLanguageModelV4 } = await import('ai/test')
    const { createBrain } = await import('@hubble/brain')
    const { loadRecording } = await import('@hubble/stage/testing')
    const rec = loadRecording('scene-linear-left')
    const answer = rec.text.replace('</Canvas>', '<Panel x={1400} y={120} w={400}><Asset id="right-triangle"/></Panel></Canvas>')
    const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } as never
    const brain = createBrain({ llm: config.llm as never, model: () => new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: answer }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) }) })
    await withServer(brain, async (base) => {
      const lines = (await (await post(base, '/api/render', { intent: 'show me the diagram', scene: rec.scene })).text()).trim().split('\n').map((l) => JSON.parse(l))
      const start = lines.find((l) => l.kind === 'start')
      expect(start.scene.assets.map((a: { id: string }) => a.id)).toContain('right-triangle')
      const pieces = lines.filter((l) => l.kind === 'event' && l.event.type === 'piece' && l.event.tag === 'Asset')
      expect(pieces.map((l) => l.event.attrs.id)).toEqual(['right-triangle'])
    })
  })
})
