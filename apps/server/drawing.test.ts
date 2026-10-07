import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { checkDrawing, MAX_SVG_CHARS } from './drawing.ts'

/**
 * Fixtures: the accepted drawings are RECORDINGS: the SVGs aixia-labs wrote
 * through draw_svg on 7 Oct (packages/brain/fixtures/table-agent/draw-*.json).
 * Each refused case is a MECHANICAL MUTATION of the recorded star: one unsafe
 * thing spliced in, so the test shows exactly that thing is what's refused.
 * Oracle: the refusal reason's wording, and the parsed output's attributes.
 */
const drawn = (name: string) => {
  const r = JSON.parse(readFileSync(new URL(`../../packages/brain/fixtures/table-agent/${name}.json`, import.meta.url), 'utf8')) as { calls: { name: string; input: { svg: string } }[] }
  return r.calls.find((c) => c.name === 'draw_svg')!.input.svg
}
const STAR = drawn('draw-star')
const BOX = { w: 743, h: 743 }
const inject = (inner: string) => STAR.replace('</svg>', `${inner}</svg>`)
const attr = (a: string) => STAR.replace('<polygon ', `<polygon ${a} `)

describe('checkDrawing accepts what the model really draws', () => {
  // Break caught: the check refusing the model's ordinary output, so every
  // "draw a star" failed and burned its retry.
  for (const name of ['draw-star', 'draw-smiley', 'draw-around-cup']) {
    it(`accepts the recorded ${name}`, () => {
      expect(checkDrawing(drawn(name), BOX).ok).toBe(true)
    })
  }

  it('normalises the size to the box, keeps the viewBox, and preserves the aspect', () => {
    const r = checkDrawing(drawn('draw-smiley'), { w: 272.4, h: 272.4 })
    if (!r.ok) throw new Error(r.error)
    // Break caught: the model's own width="200" kept, so a 220 mm drawing
    // came out 200 px (~161 mm) whatever size the agent asked for.
    expect(r.svg).toMatch(/^<svg[^>]* width="272"/)
    expect(r.svg).toMatch(/^<svg[^>]* height="272"/)
    expect(r.svg).toContain('viewBox="0 0 200 200"')
    expect(r.svg).toContain('preserveAspectRatio="xMidYMid meet"')
  })

  it('allows references inside the drawing (a gradient by url(#id), <use href="#id">)', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#ff0"/></linearGradient><circle id="c" r="10"/></defs><rect width="100" height="100" fill="url(#g)"/><use href="#c" x="50" y="50"/></svg>'
    // Break caught: the url()/href rules refusing the safe, in-document form.
    expect(checkDrawing(svg, BOX).ok).toBe(true)
  })
})

describe('checkDrawing refuses, with a reason the model can act on', () => {
  const refused: [string, string, RegExp][] = [
    ['a <script>', inject('<script>alert(1)</script>'), /<script>/],
    ['an onload handler', attr('onload="alert(1)"'), /onload/],
    ['a foreignObject', inject('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>'), /foreignObject/],
    ['an external <image>', inject('<image href="http://192.168.42.21/camera/frame" width="10" height="10"/>'), /<image>/],
    ['a javascript: link', inject('<a href="javascript:alert(1)"><circle r="5"/></a>'), /href="javascript:/],
    ['an xlink:href out', inject('<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="http://evil.example/s.svg#x"/>'), /xlink:href/],
    ['a CSS url() out', attr('style="fill:url(http://evil.example/p.png)"'), /url\(http:/],
    ['an @import', inject('<style>@import url(http://evil.example/a.css);</style>'), /@import/],
    ['animation', inject('<animate attributeName="r" from="1" to="9" dur="1s"/>'), /<animate>/],
    ['a DOCTYPE with entities', `<!DOCTYPE svg [<!ENTITY x "y">]>${STAR}`, /DOCTYPE/],
    ['an xml-stylesheet instruction', STAR.replace('<svg', '<?xml-stylesheet href="http://evil.example/a.css"?><svg'), /processing instructions/],
    ['malformed XML', STAR.replace('</svg>', ''), /not valid XML/],
    // Break caught: lenient parsing. These only WARN in xmldom (it doesn't
    // throw) and it "repairs" them into a document the model didn't write:
    // an unquoted attribute, an undefined HTML entity, text after the root.
    ['an unquoted attribute', STAR.replace('stroke-width="10"', 'stroke-width=10'), /not valid XML/],
    ['an HTML entity', inject('<text y="20">&nbsp;hi</text>'), /not valid XML/],
    ['content after the root', `${STAR}<circle r="1"/>`, /not valid XML/],
    ['a non-svg root', '<html><body>hi</body></html>', /root element must be <svg>/],
    ['no viewBox', STAR.replace(/ viewBox="[^"]*"/, ''), /viewBox/],
    // The raw cap's own message ("is N characters"), not the cap after
    // normalising: a 20 MB string must be refused before it is parsed at all.
    ['too large', inject(`<g>${'<circle r="1"/>'.repeat(Math.ceil(MAX_SVG_CHARS / 15))}</g>`), /is \d+ characters/],
  ]
  for (const [what, svg, reason] of refused) {
    // Break caught (each): that one way out of the drawing reaching the
    // stored state and every display, silently.
    it(`refuses ${what}`, () => {
      const r = checkDrawing(svg, BOX)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(reason)
    })
  }

  it('refuses a non-string or empty drawing', () => {
    expect(checkDrawing(undefined, BOX).ok).toBe(false)
    expect(checkDrawing('   ', BOX).ok).toBe(false)
  })
})
