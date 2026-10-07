import type { Surface, TableSurface } from '@hubble/stage'
import { BoxFrame } from '@hubble/stage-react'

/**
 * The `drawing` surface kind on /table and the bench: the SVG the table
 * agent drew (draw_svg), already checked and sized by the server
 * (apps/server/drawing.ts), drawn at the surface's box.
 *
 * ALWAYS as an <img> with a data: URL, never inlined into the page (no
 * innerHTML, no dangerouslySetInnerHTML, no <object>). Why: the SVG is model
 * output, and AGENTS.md says model text is never executed and never rendered
 * raw. An SVG shown as an image runs no script and fetches nothing, whatever
 * it contains, so this display is safe even if the server's check missed
 * something (plan Ruling: the <img> rule is the safety, the check is the
 * second layer). Inlined, the same text would be live DOM on the projector.
 *
 * Transparent background: on the white table, black is no light, so the
 * drawing's empty parts must project nothing, not a box.
 */
export function drawingRenderer(s: TableSurface, surface: Surface) {
  const st = (s.state ?? {}) as { svg?: unknown; title?: unknown }
  // Only what openDrawing writes: an <svg> document as a string.
  if (typeof st.svg !== 'string' || !st.svg.trimStart().startsWith('<svg')) return null
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(st.svg)}`
  return (
    <BoxFrame box={s.box} surface={surface}>
      <img data-drawing={s.id} src={src} alt={typeof st.title === 'string' ? st.title : ''} width={s.box.w} height={s.box.h} draggable={false} style={{ display: 'block', width: s.box.w, height: s.box.h, background: 'transparent', pointerEvents: 'none' }} />
    </BoxFrame>
  )
}
