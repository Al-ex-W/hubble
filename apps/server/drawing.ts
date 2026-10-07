import { DOMParser, XMLSerializer, type Element as XmlElement, type Node as XmlNode } from '@xmldom/xmldom'
import { tableToolInputs } from '@hubble/brain'
import { drawingBox } from './surfaces.ts'

/**
 * Is this SVG allowed on the table: the one owner of that answer for the
 * table agent's draw_svg tool and POST /api/surfaces/drawing
 * (docs/plans/2026-10-07-draw-svg.md).
 *
 * The real safety is elsewhere, by construction: every display draws a
 * drawing as an <img src="data:image/svg+xml,…"> (apps/web drawingRenderer),
 * and an SVG shown as an image runs no script and fetches nothing. This check
 * is the second layer, and it exists for two reasons that layer can't serve:
 *   - the stored surface state stays clean (it goes over the wire to every
 *     display, the bench's debug views print it, and a future renderer that
 *     forgets the <img> rule must not inherit a script);
 *   - a refusal with a reason is what lets the model fix its drawing in its
 *     one retry. A silently stripped drawing differs from what it meant.
 *
 * So: REFUSE, never strip (plan Ruling). Everything here is an allow-by-shape
 * walk over a strict XML parse; nothing is regex-patched in place.
 */

/** The server's cap, matched by the brain's draw_svg schema (spec.ts), so the schema never admits what this refuses for size. */
export const MAX_SVG_CHARS = 20_000

/**
 * Elements that reach outside the drawing, run code, embed another document
 * or animate. Animation is refused too: an <img> plays SMIL, and a drawing
 * that moves on its own isn't what a "shape" asks for, nor something the
 * person can stop.
 */
const REFUSED_ELEMENTS = new Set(['script', 'foreignobject', 'image', 'iframe', 'embed', 'object', 'audio', 'video', 'canvas', 'animate', 'animatemotion', 'animatetransform', 'set', 'discard', 'handler', 'listener', 'feimage'])

export type DrawingCheck = { ok: true; svg: string } | { ok: false; error: string }

/**
 * Check `raw` and, when it passes, return it normalised to draw at exactly
 * `size` px: width/height set to the box, the model's viewBox kept, and
 * aspect preserved (xMidYMid meet), so whatever units the model drew in scale
 * into the physical box the agent asked for.
 */
export function checkDrawing(raw: unknown, size: { w: number; h: number }): DrawingCheck {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'expected the drawing as one <svg> element' }
  if (raw.length > MAX_SVG_CHARS) return { ok: false, error: `the drawing is ${raw.length} characters; keep it under ${MAX_SVG_CHARS}` }
  // Before parsing: entities and doctypes are how an XML document pulls in
  // other text (and blows itself up, the billion-laughs shape). There is no
  // drawing that needs one.
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) return { ok: false, error: 'not allowed: <!DOCTYPE> or <!ENTITY>' }
  const errors: string[] = []
  let doc
  try {
    // Strict: any warning is a failure, not something the parser "fixes"
    // into a different drawing than the model wrote (the old react-scenes
    // branch's lesson: HTML-lenient parsing hid half-broken scenes).
    doc = new DOMParser({ onError: (level: string, msg: string) => void errors.push(`${level}: ${msg}`) }).parseFromString(raw.trim(), 'image/svg+xml')
  } catch (e) {
    return { ok: false, error: `the SVG is not valid XML: ${firstLine(e instanceof Error ? e.message : String(e))}` }
  }
  if (errors.length) return { ok: false, error: `the SVG is not valid XML: ${firstLine(errors[0]!)}` }
  const root = doc.documentElement as unknown as XmlElement | null
  if (!root || (root.localName ?? '').toLowerCase() !== 'svg') return { ok: false, error: 'the root element must be <svg>' }
  // A viewBox is what lets the drawing scale to the box: without one, the
  // drawing's own px would be laid at the box's top-left at 1:1 and the
  // physical size the agent chose would mean nothing.
  const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n)) || vb[2]! <= 0 || vb[3]! <= 0) return { ok: false, error: 'the <svg> needs a viewBox="minX minY width height" with a positive width and height' }

  const refusal = walk(doc as unknown as XmlNode)
  if (refusal) return { ok: false, error: refusal }

  root.setAttribute('width', String(Math.round(size.w)))
  root.setAttribute('height', String(Math.round(size.h)))
  root.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const svg = new XMLSerializer().serializeToString(root as never)
  if (svg.length > MAX_SVG_CHARS) return { ok: false, error: `the drawing is too large; keep it under ${MAX_SVG_CHARS} characters` }
  return { ok: true, svg }
}

/** The first problem found in document order, as a sentence the model can act on; null when the drawing is clean. */
function walk(node: XmlNode): string | null {
  for (let n = node.firstChild; n; n = n.nextSibling) {
    // 7 = processing instruction (xml-stylesheet pulls in a stylesheet).
    if (n.nodeType === 7) return 'not allowed: processing instructions such as <?xml-stylesheet?>'
    if (n.nodeType !== 1) continue
    const el = n as unknown as XmlElement
    const name = (el.localName ?? el.nodeName).toLowerCase()
    if (REFUSED_ELEMENTS.has(name)) return `not allowed: <${el.localName ?? el.nodeName}> (draw only with shapes, paths, text and gradients)`
    // A stylesheet can fetch (@import, url()) like an attribute can.
    if (name === 'style') {
      const css = el.textContent ?? ''
      const bad = cssProblem(css)
      if (bad) return bad
    }
    const attrs = el.attributes
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs.item(i)!
      const an = (a.localName ?? a.name).toLowerCase()
      const v = a.value ?? ''
      // Every event handler attribute starts with on: onload, onclick, …
      if (an.startsWith('on')) return `not allowed: the ${a.name} attribute (no event handlers)`
      // href and xlink:href may only point inside the drawing (#id for
      // <use>, gradients): anything else is a link out or a javascript: url.
      if (an === 'href' && !/^#[\w.-]+$/.test(v.trim())) return `not allowed: ${a.name}="${v.slice(0, 40)}" (only #id references inside the drawing)`
      const bad = cssProblem(v)
      if (bad) return bad
    }
    const inner = walk(el as unknown as XmlNode)
    if (inner) return inner
  }
  return null
}

/** url(...) to anything but a #fragment, or @import: the ways CSS fetches. */
function cssProblem(v: string): string | null {
  if (/@import/i.test(v)) return 'not allowed: @import'
  for (const m of v.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    if (!/^#[\w.-]+$/.test(m[2]!.trim())) return `not allowed: url(${m[2]!.slice(0, 40)}) (only url(#id) inside the drawing)`
  }
  return null
}

const firstLine = (s: string) => s.split('\n')[0]!.slice(0, 160)

/**
 * The one path onto the table for a drawing, shared by the agent's draw_svg
 * tool (tableAgent.ts) and POST /api/surfaces/drawing, so a tool and the
 * route can't disagree about what is allowed. The input is validated by the
 * brain's own draw_svg schema (one owner of the size bounds), the SVG is
 * checked and normalised at the box's real px size, then opened.
 */
export function openDrawingOnTable(
  surfaces: { bounds(): { widthPx: number; heightPx: number; mmPerPx: number }; openDrawing(d: { svg: string; widthMm: number; heightMm: number; xMm?: number; yMm?: number; title?: string }): { id: string; box: { x: number; y: number; w: number; h: number } } },
  raw: unknown,
): { ok: true; id: string } | { ok: false; error: string } {
  const parsed = tableToolInputs.draw_svg.safeParse(raw)
  if (!parsed.success) return { ok: false, error: `expected { svg, widthMm, heightMm, xMm?, yMm?, title? }: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ').slice(0, 200)}` }
  const d = parsed.data
  // Checked at the box's px size, before the box is clamped: the clamp only
  // moves a box, it never resizes one (stage clampBox), so the size is final.
  const box = drawingBox(d, surfaces.bounds())
  const checked = checkDrawing(d.svg, box)
  if (!checked.ok) return checked
  const { id } = surfaces.openDrawing({ ...d, svg: checked.svg })
  return { ok: true, id }
}
