import type { AssetKind, Surface, TableSurface } from '@hubble/stage'
import { AssetView, BoxFrame } from '@hubble/stage-react'

/**
 * The `asset` surface kind on /table and the bench: the library asset the
 * surface's state names (apps/server/surfaces.ts openAsset), drawn at the
 * surface's box. The state carries everything needed, so displays keep no
 * library of their own; a state that isn't an asset draws nothing.
 */
const KINDS: AssetKind[] = ['image', 'video', 'pdf-page']

export function assetRenderer(s: TableSurface, surface: Surface) {
  const st = (s.state ?? {}) as { assetId?: unknown; kind?: unknown; title?: unknown; aspect?: unknown; url?: unknown }
  // Only what the server's library could have written: a known kind, a
  // positive finite aspect, and a URL served by our own asset route (review
  // #43: the first check let negative aspects, unknown kinds and any URL by).
  if (typeof st.assetId !== 'string' || typeof st.url !== 'string' || !st.url.startsWith('/api/assets/')) return null
  if (typeof st.aspect !== 'number' || !Number.isFinite(st.aspect) || st.aspect <= 0) return null
  if (!KINDS.includes(st.kind as AssetKind)) return null
  const asset = { id: st.assetId, kind: st.kind as AssetKind, title: String(st.title ?? ''), aspect: st.aspect, url: st.url }
  return (
    <BoxFrame box={s.box} surface={surface}>
      <AssetView asset={asset} width={s.box.w} />
    </BoxFrame>
  )
}
