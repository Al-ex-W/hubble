import type { AssetInfo } from '@hubble/stage'

/**
 * One library asset (packages/stage assets.ts), drawn at the width it is
 * given and the library's aspect. Used in two places with the same look: an
 * `<Asset>` inside an answer's panel (StageView) and an `asset` surface on
 * the table (the hosts' SurfaceLayer renderer).
 *
 * Height comes from the aspect, not from the loaded file: the layout guard
 * reserved exactly width × aspect before anything was fetched, and a panel
 * that grew when the picture arrived would no longer be where it was
 * verified. Video is muted and loops (the table has no sound, and nobody can
 * press play on a projection); a PDF page is a pre-rendered image (#30
 * plan), never the browser's PDF viewer.
 */
export function AssetView({ asset, width }: { asset: AssetInfo; width?: number }) {
  const box = { width: width ?? '100%', aspectRatio: `1 / ${asset.aspect}`, display: 'block' as const, objectFit: 'contain' as const }
  if (asset.kind === 'video') return <video className="st-asset" src={asset.url} style={box} muted loop autoPlay playsInline aria-label={asset.title} />
  return <img className="st-asset" src={asset.url} style={box} alt={asset.title} draggable={false} />
}
