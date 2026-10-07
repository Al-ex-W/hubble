import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Box, Surface, SurfaceKind, TableSurface } from '@hubble/stage'

/**
 * Draws the table's surface set (packages/stage surfaces.ts): one renderer per
 * kind, stacked by z.
 *
 * The layer owns only two decisions: stacking and who draws what. It never
 * decides where a surface is (the server runtime owns the set) or what a kind
 * looks like (each kind's renderer does). The host passes the renderers, which
 * is how /table and the bench share this layer while feeding the answer from
 * different places (the SSE mirror vs the bench's own render).
 *
 * Every surface gets a full-table, absolutely positioned slot in z order. A
 * renderer either fills it (the answer: a StageView laying itself out in
 * table coordinates) or places itself with BoxFrame.
 */
export type SurfaceRenderer = (s: TableSurface) => ReactNode

export interface SurfaceLayerProps {
  surfaces: readonly TableSurface[]
  renderers: Partial<Record<SurfaceKind, SurfaceRenderer>>
  /** The projector surface the boxes are in. */
  surface: Surface
  /**
   * Outline kinds that have no renderer yet. Off on the real table: a
   * half-built kind must never project a stray frame during the demo.
   */
  debug?: boolean
}

export function SurfaceLayer({ surfaces, renderers, surface, debug = false }: SurfaceLayerProps) {
  // Sort by z, not array order: the ops promise stacking through z only.
  const ordered = [...surfaces].sort((a, b) => a.z - b.z)
  return (
    // isolation: the slots' z-indexes stay inside this layer. Without it they
    // stack above whatever the host draws after the layer (the lesson's key
    // light, OverlayLayer), hiding the key the player should press.
    <div style={{ position: 'relative', width: '100%', aspectRatio: `${surface.widthPx} / ${surface.heightPx}`, isolation: 'isolate' }}>
      {ordered.map((s, i) => {
        const render = renderers[s.kind]
        const content = render ? render(s) : debug ? <Outline s={s} surface={surface} /> : null
        if (content === null) return null
        // No pointer-events of its own: slots inherit the host's. The bench's
        // projection is pointer-transparent so the objects under the light
        // can be dragged (only projected Buttons opt back in); a slot that
        // took the pointer would swallow those drags.
        return (
          <div key={s.id} data-surface={s.id} style={{ position: 'absolute', inset: 0, zIndex: i + 1 }}>
            {content}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Projector px per CSS px of the host box. Measured, because the same layer
 * runs full-screen on the Pi and inside a resizable pane on the bench.
 */
function useScale(surface: Surface) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const el = ref.current?.parentElement
    if (!el) return
    const fit = () => setScale(el.clientWidth / surface.widthPx || 1)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [surface.widthPx])
  return { ref, scale }
}

/**
 * Places content at a box given in projector px, scaled like everything else
 * on the table. The content is laid out at its true projector size and then
 * scaled, so text in it keeps the physical size the type scale picked.
 */
export function BoxFrame({ box, surface, children, style }: { box: Box; surface: Surface; children?: ReactNode; style?: CSSProperties }) {
  const { ref, scale } = useScale(surface)
  return (
    <div ref={ref} style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0 }}>
      <div
        style={{
          position: 'absolute',
          left: box.x * scale,
          top: box.y * scale,
          width: box.w,
          height: box.h,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          ...style,
        }}
      >
        {children}
      </div>
    </div>
  )
}

function Outline({ s, surface }: { s: TableSurface; surface: Surface }) {
  return (
    <BoxFrame box={s.box} surface={surface} style={{ border: '2px dashed rgba(120,180,255,0.7)', borderRadius: 8 }}>
      <span data-surface-outline style={{ font: '18px system-ui', color: 'rgba(120,180,255,0.9)', padding: 6, display: 'inline-block' }}>
        {s.kind}: {s.id}
      </span>
    </BoxFrame>
  )
}
