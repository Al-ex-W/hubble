import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import jpeg from 'jpeg-js'
import { createKeybedClient, type KeybedKey } from './keybed.ts'
import { bmp, centroid, hasKeybedPython, inside, loadKeybedFixtures, pts, replicate, startKeybedSidecar, type FixtureFrame } from './testing/keybed.ts'

/**
 * The keybed sidecar through its HTTP client, on the committed fixtures.
 * Label: mechanical mutation of a product shot (apps/keybed/fixtures, made by
 * scripts/make_fixtures.py). Oracle: each key's true quad from the
 * simulator's placement transform; a key is right when the detected key's
 * centroid lies inside it (ray casting in testing/keybed.ts).
 */
const fx = loadKeybedFixtures()
const wrongKeys = (keys: KeybedKey[], f: FixtureFrame) =>
  keys.filter((k, i) => k.note !== f.keys[i].note || !inside(centroid(k.corners), pts(f.keys[i].corners))).map((k) => k.note)

if (!hasKeybedPython) console.warn('[keybed] python3 + opencv-python not found: the sidecar tests are skipped (the runtime falls back to perceive.ts)')

describe.skipIf(!hasKeybedPython)('the keybed sidecar', () => {
  let side: { url: string; stop: () => void }
  beforeAll(async () => {
    side = await startKeybedSidecar()
  }, 20_000)
  afterAll(() => side?.stop())

  it.each(fx.frames.filter((f) => f.kind === 'single').map((f) => f.file))('%s: every one of the 25 keys is found on the right real key', async (file) => {
    const f = fx.frames.find((x) => x.file === file)!
    const r = await createKeybedClient({ url: side.url, deadlineMs: 5000 }).detect(fx.jpeg(f))
    expect(r?.keys).toHaveLength(25)
    // The preview needs the playable-area boundary, not an axis-aligned box
    // that expands when the keyboard rotates. Check its enclosing geometry.
    expect(r?.keybed).toHaveLength(4)
    expect(r!.keys!.every((k) => inside(centroid(k.corners), r!.keybed!))).toBe(true)
    // Break caught: the lesson lighting the key next to the one meant.
    expect(wrongKeys(r!.keys!, f)).toEqual([])
  })

  it('the single-frame corpus is complete', () => {
    // Pinned: removing a manifest entry must fail loudly, not shrink the list above.
    expect(fx.frames.filter((f) => f.kind === 'single').length).toBe(8)
  })

  it('tracks the demo story frame by frame and every still frame is right', async () => {
    // Hands arrive, a key is lit green, a hand drags the keyboard, two hands play.
    const client = createKeybedClient({ url: side.url, deadlineMs: 5000 })
    await fetch(`${side.url}/reset`, { method: 'POST' })
    const story = fx.frames.filter((f) => f.kind === 'sequence').sort((a, b) => a.index! - b.index!)
    const wrong: string[] = []
    for (const f of story) {
      const r = await client.track(fx.jpeg(f))
      if (f.moving) continue
      if (!r?.keys || wrongKeys(r.keys, f).length) wrong.push(`${f.file} (${r?.status})`)
    }
    expect(story.length).toBe(29) // pinned: a shrinking corpus must fail loudly
    expect(wrong).toEqual([])
  })

  it.each([[3, 1], [1, 3]])('forgets an old pose when camera size changes from %sx to %sx', async (from, to) => {
    // Mechanical mutations of static.jpg: nearest-neighbour resizes, then
    // blackout. A lost tracker used to scale its OLD detection-space pose
    // with the NEW frame's inverse resize, putting all 100 corners outside
    // the small frame. Run through real HTTP so service state is included.
    const f = fx.frames.find((x) => x.file === 'static.jpg')!
    const img = jpeg.decode(fx.jpeg(f), { useTArray: true, formatAsRGBA: true })
    const scaled = (k: number) => bmp(img.width * k, img.height * k, replicate(img.width, img.height, img.data, k))
    const client = createKeybedClient({ url: side.url, deadlineMs: 8000 })
    await fetch(`${side.url}/reset`, { method: 'POST' })
    const initial = await client.track(scaled(from))
    expect(initial?.keys).toHaveLength(25)
    // Ordinary occlusion at the same size must still keep the last pose.
    const sameSizeBlackout = bmp(img.width * from, img.height * from, Buffer.alloc(img.width * from * img.height * from * 4))
    expect(await client.track(sameSizeBlackout)).toMatchObject({ status: 'lost', keys: initial!.keys, keybed: initial!.keybed })
    const blackout = bmp(img.width * to, img.height * to, Buffer.alloc(img.width * to * img.height * to * 4))
    const lost = await client.track(blackout)
    expect(lost).toMatchObject({ status: 'searching', keys: null, keybed: null })
    // Forgetting an incompatible pose must still allow reacquisition.
    const recovered = await client.track(scaled(to))
    const truth: FixtureFrame = { ...f, keys: f.keys.map((k) => ({ ...k, corners: k.corners.map(([x, y]) => [(x + 0.5) * to - 0.5, (y + 0.5) * to - 0.5] as [number, number]) })) }
    expect(recovered?.keys).toHaveLength(25)
    expect(wrongKeys(recovered!.keys!, truth)).toEqual([])
  }, 20_000)

  it('shrinks big frames and scales the keys back into the frame that was posted', async () => {
    // Break caught: corners returned in the shrunken frame's pixels, half
    // the size of the camera's, so every key lands far from the real one.
    const f = fx.frames.find((x) => x.file === 'static.jpg')!
    const img = jpeg.decode(fx.jpeg(f), { useTArray: true, formatAsRGBA: true })
    const k = 3 // 960x540 → 2880x1620, past the 1920 limit
    const big = Buffer.alloc(img.width * k * img.height * k * 4)
    for (let y = 0; y < img.height * k; y++)
      for (let x = 0; x < img.width * k; x++) {
        const s = (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4
        const d = (y * img.width * k + x) * 4
        big[d] = img.data[s]
        big[d + 1] = img.data[s + 1]
        big[d + 2] = img.data[s + 2]
        big[d + 3] = 255
      }
    const bytes = new Uint8Array(jpeg.encode({ width: img.width * k, height: img.height * k, data: big }, 85).data)
    const r = await createKeybedClient({ url: side.url, deadlineMs: 8000 }).detect(bytes)
    const scaled: FixtureFrame = { ...f, keys: f.keys.map((key) => ({ ...key, corners: key.corners.map(([x, y]) => [(x + 0.5) * k - 0.5, (y + 0.5) * k - 0.5] as [number, number]) })) }
    expect(wrongKeys(r!.keys!, scaled)).toEqual([])
  }, 20_000)
})

describe('the keybed client never hurts the camera loop', () => {
  let stub: Server
  let base = ''
  let mode: 'slow' | 'error' | 'garbage' | 'half' | 'short' | 'boundary' = 'error'
  beforeAll(async () => {
    stub = createServer((req, res) => {
      req.resume()
      if (mode === 'slow') return void setTimeout(() => res.end('{}'), 2000)
      if (mode === 'error') return void res.writeHead(500).end('boom')
      if (mode === 'garbage') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('not json')
      // 'half': 25 keys where one has three corners. 'short': 24 well-formed
      // keys. Both are broken answers, not "no keyboard": a short list would
      // shift every note onto its neighbour's quad.
      const n = mode === 'short' ? 24 : 25
      const keys = Array.from({ length: n }, (_, i) => ({ note: 48 + i, black: false, corners: [[0, 0], [1, 0], [1, 1], ...(mode === 'half' && i === 7 ? [] : [[0, 1]])] }))
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'locked', keys, ...(mode === 'boundary' ? { keybed: [[1, 2], [3, 4], [5, 6]] } : {}) }))
    })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`
  })
  afterAll(() => stub.close())

  it.each(['error', 'garbage', 'half', 'short', 'boundary'] as const)('a %s answer is null, not a throw', async (m) => {
    mode = m
    expect(await createKeybedClient({ url: base }).track(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('gives up at the deadline instead of stacking looks behind a stuck sidecar', async () => {
    mode = 'slow'
    const t0 = Date.now()
    expect(await createKeybedClient({ url: base, deadlineMs: 200 }).track(new Uint8Array([1]))).toBeNull()
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('a dead port is null', async () => {
    expect(await createKeybedClient({ url: 'http://127.0.0.1:9' }).track(new Uint8Array([1]))).toBeNull()
  })
})

describe.skipIf(!hasKeybedPython)('the sidecar scales corners back exactly (pixel-centre convention)', () => {
  // Review #41: the 3x JPEG test above is too tolerant to tell (x+0.5)/s-0.5
  // from x/s (a quarter pixel here). Exact instead: a lossless BMP frame A,
  // and A with every pixel doubled. With the size limit at A's width, the
  // doubled frame is shrunk by exactly 1/2, an area average of identical
  // 2x2 blocks, which IS frame A, so the detection is identical and the
  // returned corners must be exactly (c + 0.5) * 2 - 0.5 of A's.
  let plain: { url: string; stop: () => void }
  let limited: { url: string; stop: () => void }
  beforeAll(async () => {
    plain = await startKeybedSidecar()
    limited = await startKeybedSidecar({ KEYBED_MAX_SIDE: '960' })
  }, 30_000)
  afterAll(() => {
    plain?.stop()
    limited?.stop()
  })

  it('a frame shrunk by exactly half comes back as exactly twice the corners, centre-aligned', async () => {
    const f = fx.frames.find((x) => x.file === 'static.jpg')!
    const img = jpeg.decode(fx.jpeg(f), { useTArray: true, formatAsRGBA: true })
    const a = bmp(img.width, img.height, img.data)
    const doubled = bmp(img.width * 2, img.height * 2, replicate(img.width, img.height, img.data, 2))
    const ra = await createKeybedClient({ url: plain.url, deadlineMs: 8000 }).detect(a)
    const rd = await createKeybedClient({ url: limited.url, deadlineMs: 8000 }).detect(doubled)
    const worst = Math.max(...ra!.keys!.flatMap((k, i) => k.corners.map((p, j) => Math.max(Math.abs((p.x + 0.5) * 2 - 0.5 - rd!.keys![i].corners[j].x), Math.abs((p.y + 0.5) * 2 - 0.5 - rd!.keys![i].corners[j].y)))))
    // Corners come rounded to 0.01 px; x/s instead would be off by 0.5 px.
    expect(worst).toBeLessThan(0.05)
    // The boundary must undergo the same pixel-centre inverse as the keys;
    // returning detect.py's small-frame quad makes only the outline drift.
    expect(ra!.keybed).toHaveLength(4)
    const boundaryError = Math.max(...ra!.keybed!.flatMap((p, i) => [Math.abs((p.x + 0.5) * 2 - 0.5 - rd!.keybed![i].x), Math.abs((p.y + 0.5) * 2 - 0.5 - rd!.keybed![i].y)]))
    expect(boundaryError).toBeLessThan(0.05)
  }, 30_000)
})

describe.skipIf(!hasKeybedPython)('the sidecar scales each axis on its own', () => {
  it('a frame that does not shrink evenly (2881x1621) gets its corners back exactly on both axes', () => {
    // Review #41 round 2: the exact test above shrinks evenly (both axes 1/2),
    // so reverting the per-axis scale to one nominal scale still passed. The
    // check script runs the service's own shrink and scale-back in Python and
    // compares with the inverse transform from the known sizes.
    const r = spawnSync('python3', ['checks/rounded_axis.py'], { cwd: new URL('../keybed/', import.meta.url).pathname, encoding: 'utf8' })
    expect(r.stdout + r.stderr).toContain('worst_error_px')
    expect(r.status).toBe(0)
  }, 30_000)
})

describe.skipIf(!hasKeybedPython)('how much work a detection does (#44)', () => {
  it('fits each distinct group of black keys once, not once per blob', () => {
    // The demo-story test timed out under load because a detection with a
    // hand over the keys refitted the same group ~10 times (160 RANSAC fits
    // for 16 groups). The check counts the fits on that frame: a count, not
    // a timing, so it can't flake on a busy laptop.
    const r = spawnSync('python3', ['checks/detect_work.py'], { cwd: new URL('../keybed/', import.meta.url).pathname, encoding: 'utf8' })
    expect(r.stdout + r.stderr).toContain('ransac_fits')
    expect(r.status).toBe(0)
  }, 30_000)
})
