import type { CSSProperties } from 'react'
import { typeScale, type Surface, type TableSurface } from '@hubble/stage'
import { BoxFrame } from '@hubble/stage-react'

/**
 * Draws the launcher (#33) from its surface state alone: the server laid out
 * the item boxes (apps/server/launcher.ts) and hit-tests picks against the
 * same boxes, so this draws exactly where a pinch counts and nothing else.
 *
 * The stage's look, not a web page's: the panel and corner classes from
 * stage-react's styles (loaded with StageView on both hosts), outlines and
 * text in light on black, nothing filled bright (projected white washes the
 * table out). Item labels use the stage's body size, a physical size, so
 * they read at the same height under any projector.
 */
type Item = { id: string; label: string; box: { x: number; y: number; w: number; h: number } }

// The stage palette's custom properties live on .st-frame, which a surface
// outside StageView doesn't sit in; the same values, set on this panel. They
// are stage-react's Liquid palette (styles.css .st-frame, 7 Oct): if one moves
// there, move it here, or the launcher turns a different lavender from the answer.
const PALETTE = { '--st-ink': '#edf0ff', '--st-muted': '#b9bfdc', '--st-accent': '#becaff', '--st-glass': 'rgba(190, 202, 255, 0.08)', '--st-edge': 'rgba(190, 202, 255, 0.5)' } as CSSProperties

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const isItem = (i: unknown): i is Item => {
  const x = i as Item
  return !!x && typeof x.id === 'string' && typeof x.label === 'string' && !!x.box && finite(x.box.x) && finite(x.box.y) && finite(x.box.w) && finite(x.box.h) && x.box.w > 0 && x.box.h > 0
}

export function launcherRenderer(s: TableSurface, surface: Surface) {
  const items = (s.state as { items?: unknown } | undefined)?.items
  // Only a state the server's launcher could have written; anything else
  // draws nothing rather than a box of NaN size.
  if (!Array.isArray(items) || !items.length || !items.every(isItem)) return null
  const font = typeScale(surface).body
  return (
    <BoxFrame box={s.box} surface={surface}>
      <div className="st-panel" data-launcher style={{ ...PALETTE, position: 'absolute', inset: 0, padding: 0, color: 'var(--st-ink)', fontFamily: "'Outfit', 'Inter', system-ui, sans-serif", fontWeight: 500 }}>
        {['tl', 'tr', 'bl', 'br'].map((c) => (
          <span key={c} className={`st-corner ${c}`} />
        ))}
        {(items as Item[]).map((it) => (
          <div
            key={it.id}
            data-launcher-item={it.id}
            style={{
              position: 'absolute',
              left: it.box.x,
              top: it.box.y,
              width: it.box.w,
              height: it.box.h,
              boxSizing: 'border-box',
              border: '2px solid rgba(108, 240, 255, 0.55)',
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: font,
              textAlign: 'center',
            }}
          >
            {it.label}
          </div>
        ))}
      </div>
    </BoxFrame>
  )
}
