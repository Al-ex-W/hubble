// js-aruco2 is CommonJS that registers onto one shared `AR` object: the main
// file defines it, each dictionary file adds itself to AR.DICTIONARIES as a
// side effect. Both imports must resolve to the same module instance (Node's
// CJS cache does; Vite's dep optimizer is told to pre-bundle both together in
// vite.config.ts), which `createMarkerDetector` checks rather than trusts.
import aruco from 'js-aruco2'
import 'js-aruco2/src/dictionaries/aruco_4x4_1000.js'
import { DICTIONARY, PHYSICAL_IDS, PROJECTED_IDS, type Corners, type Marker } from './layout.ts'

/**
 * The one marker detector (#91), for every camera: the iPad page runs it on
 * its own camera frames, the server runs it on the room camera's frames.
 * One implementation on both sides, so a marker the iPad finds and one the
 * room camera finds are found by the same rules and land in the same fit.
 *
 * Why js-aruco2 and not opencv.js: opencv.js is an 8–10 MB WASM download to
 * the iPad (and a heavy load in every test) for this one function; js-aruco2
 * is ~0.4 MB of plain JS, runs in Node and Safari alike, and measured 63 ms
 * per 1080p frame in Node on the show laptop. It ships OpenCV's own
 * DICT_4X4_1000 code list, so printed markers from any ArUco generator, and
 * cv2's renderings in the test fixtures, decode to the same ids.
 *
 * What it doesn't do is subpixel corners: js-aruco2's corners are contour
 * pixel indices. On the composited fixtures they sat 1–2 camera px off, and
 * not randomly: the quad came out shifted towards +x/+y and ~1 px too big
 * (a contour pixel's index is its left/top edge, the black region's true edge
 * is between pixels). That bias, magnified by extrapolating across the
 * table, made the localizer reject half the markers as outliers. So each
 * edge is re-found here (refineCorners) and the corners re-intersected.
 */

const AR = (aruco as { AR: ArucoNamespace }).AR

interface ArucoNamespace {
  DICTIONARIES: Record<string, unknown>
  Detector: new (config: { dictionaryName: string; maxHammingDistance?: number }) => {
    detect(image: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }): { id: number; corners: { x: number; y: number }[]; hammingDistance: number }[]
  }
  Dictionary: new (name: string) => { codeList: string[] }
}

/** Only these ids are ours; anything else in view (another team's tag, a false code) is ignored. */
const KNOWN = new Set<number>([...PROJECTED_IDS, ...PHYSICAL_IDS])

export interface Image {
  width: number
  height: number
  /** RGBA (canvas ImageData), or one byte per pixel (decoded room JPEG). */
  data: Uint8ClampedArray | Uint8Array
}

export function createMarkerDetector() {
  if (!AR?.DICTIONARIES?.[DICTIONARY]) throw new Error(`js-aruco2 loaded without ${DICTIONARY}: the dictionary registered on a different module instance`)
  const detector = new AR.Detector({ dictionaryName: DICTIONARY })
  let rgba: Uint8ClampedArray | null = null
  return {
    detect(image: Image): Marker[] {
      let data = image.data
      // js-aruco2 converts RGBA to grey itself; a grey frame is expanded so
      // the server can hand over what @hubble/room's decode() gives it.
      if (data.length === image.width * image.height) {
        const n = image.width * image.height
        if (!rgba || rgba.length !== n * 4) rgba = new Uint8ClampedArray(n * 4)
        for (let i = 0; i < n; i++) {
          const v = data[i]!
          rgba[i * 4] = v
          rgba[i * 4 + 1] = v
          rgba[i * 4 + 2] = v
          rgba[i * 4 + 3] = 255
        }
        data = rgba
      } else if (data.length !== image.width * image.height * 4) throw new Error('image data is neither grey nor RGBA for its size')
      const seen = detector.detect({ width: image.width, height: image.height, data })
      const grey = image.data.length === image.width * image.height ? image.data : toGrey(image.data, image.width * image.height)
      const out: Marker[] = []
      const ids = new Set<number>()
      for (const m of seen) {
        if (!KNOWN.has(m.id) || m.corners.length !== 4) continue
        // The same id twice in one frame: at most one of them is where the
        // layout says, and we can't tell which here. Drop both; the fit has
        // the other markers.
        if (ids.has(m.id)) {
          const i = out.findIndex((o) => o.id === m.id)
          if (i >= 0) out.splice(i, 1)
          continue
        }
        ids.add(m.id)
        const raw = m.corners.map((c) => ({ x: c.x, y: c.y })) as Corners
        out.push({ id: m.id, corners: refineCorners(grey, image.width, image.height, raw) ?? raw })
      }
      return out
    },
  }
}

function toGrey(rgba: Uint8ClampedArray | Uint8Array, n: number): Uint8Array {
  const g = new Uint8Array(n)
  // The same weights as @hubble/room's decode(), so a frame refined on the
  // iPad (RGBA) and on the server (decoded grey) see the same edges.
  for (let i = 0; i < n; i++) g[i] = (rgba[i * 4]! * 77 + rgba[i * 4 + 1]! * 150 + rgba[i * 4 + 2]! * 29) >> 8
  return g
}

type P = { x: number; y: number }

/** Bilinear sample; NaN outside the image. Pixel centres are at integer coordinates. */
function sample(g: Uint8Array | Uint8ClampedArray, w: number, h: number, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) return Number.NaN
  const fx = x - x0
  const fy = y - y0
  const i = y0 * w + x0
  return (g[i]! * (1 - fx) + g[i + 1]! * fx) * (1 - fy) + (g[i + w]! * (1 - fx) + g[i + w + 1]! * fx) * fy
}

/**
 * Subpixel corners: find each edge of the marker's black square as the
 * strongest brightness step across it, fit a line through those points, and
 * intersect neighbouring lines. Corners themselves are the worst place to
 * measure (two edges blur together there), so only the middle 70 % of each
 * edge is sampled. Returns null (keep js-aruco2's corners) when an edge has
 * too few clear steps or a corner would move more than 3 px: then something
 * other than a clean edge was found, and the contour is the safer guess.
 */
export function refineCorners(g: Uint8Array | Uint8ClampedArray, w: number, h: number, c: Corners): Corners | null {
  const lines: { p: P; d: P }[] = []
  for (let e = 0; e < 4; e++) {
    const a = c[e]!
    const b = c[(e + 1) % 4]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 8) return null
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
    const n = { x: -d.y, y: d.x }
    const pts: P[] = []
    const steps = Math.max(6, Math.round(len / 2))
    for (let k = 0; k <= steps; k++) {
      const t = 0.15 + (0.7 * k) / steps
      const base = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      // Search ±3 px across the edge, in quarter pixels, for the largest
      // brightness change; then a parabola through the peak and its
      // neighbours for the fraction. The sign doesn't matter: the edge is
      // dark inside, light outside, whichever way the normal points.
      let best = -1
      let bestS = 0
      const prof: number[] = []
      for (let s = -3; s <= 3.0001; s += 0.25) {
        const g1 = sample(g, w, h, base.x + n.x * (s - 0.5), base.y + n.y * (s - 0.5))
        const g2 = sample(g, w, h, base.x + n.x * (s + 0.5), base.y + n.y * (s + 0.5))
        const v = Math.abs(g2 - g1)
        prof.push(v)
        if (v > best) {
          best = v
          bestS = s
        }
      }
      if (!(best > 12)) continue
      const i = Math.round((bestS + 3) / 0.25)
      let off = 0
      if (i > 0 && i < prof.length - 1) {
        const l = prof[i - 1]!
        const r = prof[i + 1]!
        const den = l - 2 * best + r
        if (den < 0) off = (0.5 * (l - r)) / den * 0.25
      }
      pts.push({ x: base.x + n.x * (bestS + off), y: base.y + n.y * (bestS + off) })
    }
    if (pts.length < 5) return null
    // Total least squares line: the centroid and the principal direction.
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length
    let sxx = 0
    let sxy = 0
    let syy = 0
    for (const p of pts) {
      sxx += (p.x - mx) ** 2
      sxy += (p.x - mx) * (p.y - my)
      syy += (p.y - my) ** 2
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    lines.push({ p: { x: mx, y: my }, d: { x: Math.cos(angle), y: Math.sin(angle) } })
  }
  const out: P[] = []
  for (let k = 0; k < 4; k++) {
    // Corner k is where edge k-1 (into it) meets edge k (out of it).
    const l1 = lines[(k + 3) % 4]!
    const l2 = lines[k]!
    const den = l1.d.x * l2.d.y - l1.d.y * l2.d.x
    if (Math.abs(den) < 1e-6) return null
    const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / den
    const p = { x: l1.p.x + l1.d.x * t, y: l1.p.y + l1.d.y * t }
    if (Math.hypot(p.x - c[k]!.x, p.y - c[k]!.y) > 3) return null
    // sample() puts pixel i's centre at i; everything else that leaves a
    // camera in this repo (MediaPipe's landmarks × width, findDot's dots)
    // puts it at i + 0.5, with 0 the image's left EDGE. Report in theirs,
    // or every marker map is half a camera pixel off from the hands it maps
    // (checked in Chrome: a marker edge drawn at x=200 came out at 199.5).
    out.push({ x: p.x + 0.5, y: p.y + 0.5 })
  }
  return out as Corners
}

/** The dictionary's bits for an id: what markerShapes() draws. */
export function markerBits(): (id: number) => string {
  const dict = new AR.Dictionary(DICTIONARY)
  return (id) => {
    const code = dict.codeList[id]
    if (!code) throw new Error(`no ${DICTIONARY} marker ${id}`)
    return code
  }
}
