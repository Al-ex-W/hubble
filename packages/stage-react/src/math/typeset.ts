import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
// Imported only to register every package's configuration; which ones are
// switched on is TEX_PACKAGES below, never AllPackages itself.
import 'mathjax-full/js/input/tex/AllPackages.js'

/**
 * Typeset one complete LaTeX string to inline SVG.
 *
 * The document is created once and reused: MathJax's TeX parser loads its
 * macro tables on first use, which is expensive, and the parser is stateless
 * across `convert` calls. `liteAdaptor` runs identically in the browser bundle
 * and under Node (Vitest), so there is no DOM requirement at all.
 */
/**
 * The TeX the table may use. AllPackages included `html` (\\href, \\style,
 * \\class, \\cssId), so a model answer containing \\href{javascript:…}{x}
 * became a live link inside dangerouslySetInnerHTML (#17). The model writes
 * the TeX, so the TeX must not be able to write markup. Every macro in the
 * recorded corpus is base or ams; the rest are pure-notation packages a
 * worked solution plausibly needs. Left out on purpose: html, bbox (CSS
 * styles), action (tooltips and toggles), unicode (font families),
 * require/autoload (load code at runtime), newcommand/configmacros (macro
 * definitions), noerrors/noundefined (they would turn bad TeX into drawn red
 * text instead of the merror that `typeset` reports as a failure).
 */
export const TEX_PACKAGES = ['base', 'ams', 'boldsymbol', 'cancel', 'color', 'mathtools', 'braket', 'gensymb', 'mhchem']

/**
 * Second line of defence, on the produced markup: whatever a package does,
 * nothing that can navigate, run script or restyle the page survives. Drops
 * <a>, <foreignObject>, <script> and <style> elements, any on* handler, any
 * href, and every style attribute except MathJax's own `vertical-align` on the
 * root <svg> (which keeps the baseline right). Works on the serialised string
 * because liteAdaptor escapes `"` inside attribute values, so `name="…"` is a
 * reliable attribute boundary.
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<(script|style|foreignObject)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?a\b[^>]*>/gi, '')
    .replace(/<([a-zA-Z][\w:-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>/g, (_m, tag: string, attrs: string, close: string) => {
      const kept = [...attrs.matchAll(/\s+([^\s=>\/]+)(?:\s*=\s*"([^"]*)")?/g)].filter(([, name, value]) => {
        const n = name.toLowerCase()
        if (n.startsWith('on') || n.endsWith('href')) return false
        if (n === 'style') return tag.toLowerCase() === 'svg' && /^\s*vertical-align:\s*-?[\d.]+ex;?\s*$/.test(value ?? '')
        return true
      })
      return `<${tag}${kept.map(([a]) => a).join('')}${close ? ' /' : ''}>`
    })
}

let documentSingleton: ReturnType<typeof mathjax.document> | null = null
let adaptorSingleton: ReturnType<typeof liteAdaptor> | null = null

function getDocument() {
  if (!documentSingleton) {
    adaptorSingleton = liteAdaptor()
    RegisterHTMLHandler(adaptorSingleton)
    documentSingleton = mathjax.document('', {
      InputJax: new TeX({ packages: TEX_PACKAGES }),
      OutputJax: new SVG({ fontCache: 'none' }),
    })
  }
  return documentSingleton
}

export type TypesetResult =
  | { ok: true; svg: string; glyphs: number }
  | { ok: false; error: string }

/**
 * Recently typeset TeX, oldest first. A new answer remounts every MathInk, so
 * per-component memoisation alone re-typesets the same lines again (MathJax is
 * the slowest thing the table's Raspberry Pi does). Bounded, because a long
 * session would otherwise keep every line it ever drew; a Map iterates in
 * insertion order, so re-inserting on a hit makes it least-recently-used.
 */
export const TEX_CACHE_SIZE = 200
const cache = new Map<string, TypesetResult>()

export function typeset(tex: string): TypesetResult {
  const hit = cache.get(tex)
  if (hit) {
    cache.delete(tex)
    cache.set(tex, hit)
    return hit
  }
  const result = typesetUncached(tex)
  cache.set(tex, result)
  if (cache.size > TEX_CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return result
}

/** Exposed for the bound test only. */
export const texCacheSize = () => cache.size

function typesetUncached(tex: string): TypesetResult {
  const document = getDocument()
  const adaptor = adaptorSingleton!

  let outer: string
  try {
    // display:true gives display-style fractions/limits, which is what a
    // hand-written sum or fraction on a table looks like; the returned markup
    // carries explicit width/height in `ex` so the parent's font-size governs
    // the projected size.
    const node = document.convert(tex, { display: true })
    outer = adaptor.outerHTML(node)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  // MathJax does not throw on bad TeX: it renders an <merror> node carrying the
  // reason in data-mjx-error. That is the only signal a partial TeX string
  // reached the renderer, so it must be treated as failure, never drawn.
  const mjxError = /data-mjx-error="([^"]*)"/.exec(outer)
  if (mjxError || outer.includes('<merror')) {
    return { ok: false, error: (mjxError?.[1] ?? 'invalid TeX') || 'invalid TeX' }
  }

  // Strip the mjx-container wrapper; callers only want the <svg>.
  const svgMatch = /<svg[\s\S]*<\/svg>/.exec(outer)
  if (!svgMatch) return { ok: false, error: 'no SVG produced' }
  const svg = sanitizeSvg(svgMatch[0])
  // Fail closed: if anything link- or handler-shaped got past the sanitiser
  // (markup it could not parse), show the TeX source as text instead.
  if (/<a\b|\son[a-z]+\s*=|href\s*=|javascript:/i.test(svg)) return { ok: false, error: 'unsafe markup in typeset output' }

  const glyphs = svg.match(/<path\b/g)?.length ?? 0
  if (glyphs === 0) return { ok: false, error: 'no glyphs produced' }

  return { ok: true, svg, glyphs }
}
