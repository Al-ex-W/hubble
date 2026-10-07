import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Test support for the keybed sidecar: the real Python service on a free port
 * (never the shared dev ports), the committed fixtures, and an oracle.
 */
const KEYBED_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../keybed')

export type Pt = { x: number; y: number }
export interface FixtureKey {
  note: number
  black: boolean
  corners: [number, number][]
}
export interface FixtureFrame {
  file: string
  kind: 'single' | 'sequence'
  index?: number
  moving: boolean
  hands: number
  keys: FixtureKey[]
}

/** True when python3 with OpenCV is here. Without it the product falls back to perceive.ts, so do the tests. */
export const hasKeybedPython = spawnSync('python3', ['-c', 'import cv2, numpy'], { stdio: 'ignore' }).status === 0

export function loadKeybedFixtures(): { frames: FixtureFrame[]; jpeg: (f: FixtureFrame) => Uint8Array } {
  const manifest = JSON.parse(readFileSync(join(KEYBED_DIR, 'fixtures/manifest.json'), 'utf8')) as { frames: FixtureFrame[] }
  return { frames: manifest.frames, jpeg: (f) => new Uint8Array(readFileSync(join(KEYBED_DIR, 'fixtures', f.file))) }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

export async function startKeybedSidecar(env: Record<string, string> = {}): Promise<{ url: string; stop: () => void }> {
  const port = await freePort()
  const child: ChildProcess = spawn('python3', ['service.py'], { cwd: KEYBED_DIR, env: { ...process.env, ...env, KEYBED_PORT: String(port) }, stdio: 'ignore' })
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) return { url, stop: () => child.kill() }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  child.kill()
  throw new Error('keybed sidecar did not start')
}

/** Ray casting: is p inside the polygon. Plain maths, independent of the detector. */
export function inside(p: Pt, poly: Pt[]): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}
export const centroid = (q: Pt[]): Pt => ({ x: q.reduce((s, p) => s + p.x, 0) / q.length, y: q.reduce((s, p) => s + p.y, 0) / q.length })
export const pts = (c: [number, number][]): Pt[] => c.map(([x, y]) => ({ x, y }))

/**
 * A 24-bit BMP from RGBA pixels: lossless (unlike JPEG) and decoded by the
 * sidecar's cv2.imdecode, so a test can post pixel-exact frames.
 */
export function bmp(width: number, height: number, rgba: Uint8Array | Buffer): Uint8Array {
  const row = Math.ceil((width * 3) / 4) * 4
  const out = Buffer.alloc(54 + row * height)
  out.write('BM', 0)
  out.writeUInt32LE(out.length, 2)
  out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(width, 18)
  out.writeInt32LE(height, 22) // positive: rows bottom-up
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(24, 28)
  out.writeUInt32LE(row * height, 34)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4
      const d = 54 + (height - 1 - y) * row + x * 3
      out[d] = rgba[s + 2]
      out[d + 1] = rgba[s + 1]
      out[d + 2] = rgba[s]
    }
  return new Uint8Array(out)
}

/** Every pixel repeated k x k: a frame whose area-average k-times shrink is exactly the original. */
export function replicate(width: number, height: number, rgba: Uint8Array | Buffer, k: number): Buffer {
  const out = Buffer.alloc(width * k * height * k * 4)
  for (let y = 0; y < height * k; y++)
    for (let x = 0; x < width * k; x++) {
      const s = (Math.floor(y / k) * width + Math.floor(x / k)) * 4
      const d = (y * width * k + x) * 4
      out[d] = rgba[s]
      out[d + 1] = rgba[s + 1]
      out[d + 2] = rgba[s + 2]
      out[d + 3] = 255
    }
  return out
}
