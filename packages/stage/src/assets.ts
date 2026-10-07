import { CATALOG, type Catalog, type ComponentSpec } from './catalog.ts'
import type { Scene } from './scene.ts'

/**
 * Assets: things the table can show that nobody generates on the spot (a
 * diagram, a photo, a short video, a pre-rendered PDF page), from a library
 * the server owns (apps/server/assets.ts, #30).
 *
 * The model may place one in its answer with `<Asset id="…"/>`, but only an
 * id the library really has: the ids go into the catalog as an enum, per
 * request, so the existing attribute check drops anything else (a made-up id
 * never reaches the renderer, and never becomes a request for a file), and
 * the prompt lists exactly what is available. The catalog stays the one
 * source of truth for what the model may write.
 */
export type AssetKind = 'image' | 'video' | 'pdf-page'

export interface AssetInfo {
  id: string
  kind: AssetKind
  /** What it shows, for the prompt (the model picks by meaning, not by id). */
  title: string
  /** Height / width: how tall it is at a given width, for layout and drawing. */
  aspect: number
  /** Where displays fetch it (served by the server from its library). */
  url: string
}

/**
 * The catalog for one request. With no library it is CATALOG itself, so
 * every prompt and parse stays byte-for-byte what the recorded corpus and the
 * census were made against. With assets, `Asset` is allowed wherever flow
 * content is (wherever Plot is: Canvas, Panel, Column, Step), never as a spatial
 * element: it is laid out inside a panel the guard checked.
 */
export function catalogFor(scene?: Scene): Catalog {
  const assets = scene?.assets ?? []
  if (assets.length === 0) return CATALOG
  const out: Catalog = {}
  for (const [tag, spec] of Object.entries(CATALOG) as [string, ComponentSpec][]) {
    out[tag] = spec.children.includes('Plot') ? { ...spec, children: [...spec.children, 'Asset'] } : spec
  }
  out.Asset = {
    policy: 'whole',
    selfClosing: true,
    doc: `A picture, video or document page from the library, shown at its panel's width. Give it a Panel of its own (w 300-450) beside the work: inside a panel of steps it makes that panel too tall for the table. Available: ${assets.map((a) => `${a.id} (${a.title})`).join('; ')}.`,
    attrs: {
      id: { kind: 'enum', required: true, values: assets.map((a) => a.id), doc: 'Which library item to show.' },
    },
    children: [],
  }
  return out
}
