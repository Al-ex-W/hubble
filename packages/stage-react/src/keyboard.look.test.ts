import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The projected keyboard's look on the room's white table (7 Oct).
 *
 * Oracle: the measured scheme, not this stylesheet's own values. H28
 * photographed each candidate scheme on the real table through the room
 * camera and scored it by CIELAB contrast on exact masks
 * (experiments/room-cli/keyboard_scheme_stats.py). The winner was blue keys
 * (#3d7bff at 60 %) with bold UNLIT letters, plus full white for the pressed
 * key and the trail: 17.5 against 13.4 for white keys. These tests pin the
 * rules that result rests on, so a later edit can't quietly bring back the
 * black-cloth look that vanished on white.
 *
 * Read as text, not computed styles: happy-dom doesn't apply external CSS to
 * SVG, and the rules are the contract.
 */
const css = readFileSync(new URL('./keyboard.css', import.meta.url), 'utf8')
const rule = (selector: string) => {
  const i = css.indexOf(`${selector} {`)
  expect(i, `missing rule ${selector}`).toBeGreaterThanOrEqual(0)
  return css.slice(i, css.indexOf('}', i))
}
const vars = Object.fromEntries([...rule('.swk').matchAll(/(--swk-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
// Typed return: resolve calls itself (a variable can point at another), and
// TypeScript can't infer a recursive function's return type.
const resolve = (v: string): string => v.replace(/var\((--swk-[\w-]+)\)/g, (_: string, n: string): string => resolve(vars[n] ?? '?')).trim()
const prop = (selector: string, name: string) => {
  const m = rule(selector).match(new RegExp(`(?:^|[;{\\s])${name}:\\s*([^;]+);`))
  return m ? resolve(m[1]) : undefined
}

describe('the projected keyboard on a white table', () => {
  it('fills keys with the measured blue and draws their letters as no light, bold', () => {
    // Breaks caught: keys back to near-transparent (invisible on white);
    // letters drawn as light (light on light, the old look's failure); thin
    // letters (round 1: thin unlit letters were the weakest contrast, 11.9).
    expect(prop('.swk-key rect', 'fill')).toBe('rgba(61, 123, 255, 0.6)')
    expect(prop('.swk-key text', 'fill')).toBe('#000')
    expect(Number(prop('.swk-key text', 'font-weight'))).toBeGreaterThanOrEqual(700)
    expect(prop('.swk-glyph', 'stroke')).toBe('#000')
  })

  it('lights the pressed key, the crossed keys and the trail in full white', () => {
    // Break caught: a pressed key or trail in a tint of the key colour, which
    // the measurements found hardest to see over blue keys.
    expect(prop('.swk-key.hot rect', 'fill')).toBe('#fff')
    expect(prop('.swk-key.lit rect', 'fill')).toBe('#fff')
    expect(prop('.swk-trail-line', 'stroke')).toBe('#fff')
  })

  it('draws text on the bare table as light, never as no light', () => {
    // Break caught: copying "letters are unlit" to text that sits on the bare
    // table (the typed line, the candidates), where no light is just more
    // white table, so the text would disappear.
    for (const sel of ['.swk-text', '.swk-cand.best text', '.swk-cand text', '.swk-placeholder']) {
      const fill = prop(sel, 'fill')!
      expect(fill, sel).not.toBe('#000')
      expect(fill, sel).toMatch(/3d7bff|61, 123, 255/i)
    }
  })
})
