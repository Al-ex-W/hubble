import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssetInfo, AssetKind } from '@hubble/stage'

/**
 * The asset library (#30): things the table can show that nobody generates
 * on the spot. A manifest (assets/library/manifest.json) lists each asset
 * with its kind, what it shows, its file and its real-world size; the files
 * sit next to it.
 *
 * The server is the only owner: it fills every render's scene with the
 * library (so the model can name exactly these ids, packages/stage
 * assets.ts) and serves only files the manifest names. A client never
 * supplies an asset or a path, and a manifest entry that tries to reach
 * outside the library (`../`, a subfolder, an absolute path) is skipped.
 */
export const DEFAULT_LIBRARY = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/library')

const KINDS: AssetKind[] = ['image', 'video', 'pdf-page']
// Served types by extension. A PDF page is a pre-rendered image (#30 plan),
// so no PDF type: the browser's PDF viewer never runs on the table.
const TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm' }

export interface LibraryAsset extends AssetInfo {
  /** Real-world size it is shown at as its own surface. */
  widthMm: number
  heightMm: number
  file: string
  type: string
}

export interface Library {
  list(): AssetInfo[]
  get(id: string): LibraryAsset | undefined
}

export function loadLibrary(dir: string = DEFAULT_LIBRARY, log: (msg: string) => void = (m) => console.warn(`[assets] ${m}`)): Library {
  const assets = new Map<string, LibraryAsset>()
  const manifest = join(dir, 'manifest.json')
  if (existsSync(manifest)) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(manifest, 'utf8'))
    } catch {
      log('manifest.json is not valid JSON; no assets')
      raw = { assets: [] }
    }
    // Valid JSON is not a valid manifest: `null`, or a null entry, threw here
    // and stopped the whole server (math act included) at startup (review
    // #43). Anything not an object is skipped like any other bad entry.
    const entries = raw && typeof raw === 'object' ? (raw as { assets?: unknown }).assets : undefined
    for (const item of Array.isArray(entries) ? (entries as unknown[]) : []) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        log(`skipped entry ${JSON.stringify(item)?.slice(0, 60)}`)
        continue
      }
      const e = item as Record<string, unknown>
      const id = typeof e.id === 'string' && /^[a-z0-9-]{1,40}$/.test(e.id) ? e.id : null
      const kind = KINDS.includes(e.kind as AssetKind) ? (e.kind as AssetKind) : null
      const title = typeof e.title === 'string' && e.title.trim() && e.title.length <= 200 ? e.title.trim() : null
      const w = typeof e.widthMm === 'number' && e.widthMm > 0 && e.widthMm <= 2000 ? e.widthMm : null
      const h = typeof e.heightMm === 'number' && e.heightMm > 0 && e.heightMm <= 2000 ? e.heightMm : null
      // A plain file name in the library itself, nothing else.
      const file = typeof e.file === 'string' && e.file === basename(e.file) && !e.file.startsWith('.') ? e.file : null
      const type = file ? TYPES[extname(file).toLowerCase()] : undefined
      const where = file ? join(dir, file) : null
      if (!id || !kind || !title || !w || !h || !file || !type || !where || !existsSync(where) || !statSync(where).isFile() || assets.has(id)) {
        log(`skipped entry ${JSON.stringify(e).slice(0, 120)}`)
        continue
      }
      assets.set(id, { id, kind, title, aspect: h / w, url: `/api/assets/${id}/file`, widthMm: w, heightMm: h, file: where, type })
    }
  }
  return {
    list: () => [...assets.values()].map(({ id, kind, title, aspect, url }) => ({ id, kind, title, aspect, url })),
    get: (id) => assets.get(id),
  }
}
