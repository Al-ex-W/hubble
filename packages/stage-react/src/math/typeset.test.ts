import { describe, expect, it } from 'vitest'
import { listRecordings, loadRecording } from '@hubble/stage/testing'
import { TEX_CACHE_SIZE, sanitizeSvg, texCacheSize, typeset } from './typeset.ts'

/** Every Math body the model has really written (label: recording). */
const mathBodies = (text: string) => [...text.matchAll(/<Math[^>]*>([\s\S]*?)<\/Math>/g)].map((m) => m[1])

describe('typeset', () => {
  it('typesets every Math body in the recorded streams', () => {
    const bodies = listRecordings().flatMap((name) => mathBodies(loadRecording(name).text))
    // Pinned so a shrinking corpus fails loudly.
    expect(bodies.length).toBe(92)
    for (const body of bodies) {
      const result = typeset(body)
      expect(result.ok, `failed to typeset: ${body}`).toBe(true)
      if (result.ok) expect(result.glyphs).toBeGreaterThan(0)
    }
  })

  it('rejects truncated TeX', () => {
    expect(typeset('\\frac{1}{').ok).toBe(false)
  })

  it('strips the mjx-container wrapper', () => {
    const result = typeset('\\frac{1}{2}')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.svg).not.toContain('<mjx-container')
  })

  it('never turns model TeX into links, styles or handlers', () => {
    // Break caught (#17): with AllPackages the html package made
    // \\href{javascript:…} a live <a> inside dangerouslySetInnerHTML. The
    // model writes the TeX, so each of these is reachable from an answer.
    const hostile = [
      '\\href{javascript:alert(1)}{x = 4}',
      '\\style{background:url(https://example.com/x)}{x}',
      '\\class{st-panel}{x}',
      '\\cssId{root}{x}',
      '\\bbox[style="position:fixed;inset:0"]{x}',
      '\\texttip{x}{tip}',
      '\\require{html}\\href{javascript:alert(1)}{x}',
    ]
    for (const tex of hostile) {
      const r = typeset(tex)
      if (!r.ok) continue // shown as plain text by MathInk, which is safe
      expect(r.svg, tex).not.toMatch(/<a\b|href|javascript:|\son[a-z]+=|position:fixed|background|st-panel|id="root"/i)
    }
  })

  it('strips handlers, links and foreign markup from SVG, keeping the baseline', () => {
    const svg =
      '<svg style="vertical-align: -0.566ex;" onload="alert(1)" width="2ex"><a href="javascript:alert(1)"><g style="fill:red" data-c="78"><path d="M0 0"/></g></a>' +
      '<foreignObject><div onclick="x()">hi</div></foreignObject><use xlink:href="#g"/></svg>'
    expect(sanitizeSvg(svg)).toBe('<svg style="vertical-align: -0.566ex;" width="2ex"><g data-c="78"><path d="M0 0" /></g><use /></svg>')
  })

  it('keeps the TeX cache bounded over a long session', () => {
    // Break caught: an unbounded cache grows with every line ever drawn on a
    // table that runs all day.
    for (let i = 0; i < TEX_CACHE_SIZE + 50; i++) typeset(`x = ${i}`)
    expect(texCacheSize()).toBe(TEX_CACHE_SIZE)
    expect(typeset('x = 3').ok).toBe(true)
  })
})
