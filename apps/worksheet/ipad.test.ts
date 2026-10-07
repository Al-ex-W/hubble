import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PX_PER_MM, mm } from './public/ipad.js'

describe('the iPad page is real size', () => {
  it('maps the iPad (A16) screen to its real width', () => {
    // Oracle: Apple's tech specs, independent of the page: 2360 device px
    // across at 264 ppi is 227.1 mm, and Safari draws 2 device px per CSS px.
    const cssPxAcross = 2360 / 2
    expect(cssPxAcross / PX_PER_MM).toBeCloseTo((2360 / 264) * 25.4, 1)
    expect(mm(100)).toBe(`${(100 * PX_PER_MM).toFixed(2)}px`)
  })

  it('never uses CSS mm, which is 1.37x too small on the iPad', () => {
    // Catches: one size written as "8mm" in the page or its script. CSS
    // defines mm at 96 dpi, so it would silently draw at 0.73 real mm, and
    // the ruler would lie. Regex over the served files, not the code's helpers.
    for (const f of ['public/index.html', 'public/ipad.js']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/gm, '')
      expect(src, f).not.toMatch(/\d\s*mm\b/)
    }
  })
})
