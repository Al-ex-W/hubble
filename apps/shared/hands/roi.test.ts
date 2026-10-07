import { describe, expect, it } from 'vitest'
import { cropPixels, roiParam, toFullFrame } from './roi.ts'

/**
 * The room camera's crop rule. Label: schema-derived. Oracle: camera.py's
 * `LosslessCrop.pixels` (pinned 995f275) worked by hand for each case:
 *   x0 = max(0, min(W, int(x*W)) // 16 * 16)
 *   x1 = min(W, -(-int((x+w)*W) // 16) * 16)
 */
const W = 1920
const H = 1080

describe('cropPixels follows the Pi exactly', () => {
  it('snaps the origin down and the far edge up to the 16 px grid', () => {
    // Break caught: mapping landmarks with the requested rectangle instead of
    // the snapped one. 0.1*1920 = 192 (on grid); 0.1*1080 = 108 -> 96;
    // (0.1+0.3)*1920 = 768 (on grid); (0.1+0.3)*1080 = 432 (on grid).
    expect(cropPixels({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, W, H)).toEqual({ x: 192, y: 96, w: 576, h: 336 })
    // 0.123*1920 = 236.16 -> int 236 -> 224; (0.123+0.2)*1920 = 620.16 -> 620 -> ceil 624.
    // 0.47*1080 = 507.6 -> 507 -> 496; (0.47+0.21)*1080 = 734.4 -> 734 -> ceil 736.
    expect(cropPixels({ x: 0.123, y: 0.47, w: 0.2, h: 0.21 }, W, H)).toEqual({ x: 224, y: 496, w: 400, h: 240 })
  })

  it('clamps at the bottom-right, where 1080 is not on the grid', () => {
    // Break caught: a crop reported as 1088 px tall (the grid ceiling past the
    // frame), shifting nothing but failing the video-size check, or a crop
    // the Pi never sends. The Pi clamps to the frame: min(1080, 1088).
    expect(cropPixels({ x: 0.5, y: 0.9, w: 0.5, h: 0.1 }, W, H)).toEqual({ x: 960, y: 960, w: 960, h: 120 })
    // x + w past 1 is allowed per value and clamped by the Pi too.
    expect(cropPixels({ x: 0.9, y: 0, w: 0.5, h: 1 }, W, H)).toEqual({ x: 1728, y: 0, w: 192, h: 1080 })
  })

  it('refuses an empty crop and values outside 0..1, as the Pi does', () => {
    // Break caught: opening a stream the Pi answers with an error, then
    // mapping landmarks with a rectangle that does not exist.
    expect(() => cropPixels({ x: 0.5, y: 0.5, w: 0, h: 0.2 }, W, H)).toThrow(/empty/)
    expect(() => cropPixels({ x: -0.1, y: 0, w: 0.5, h: 0.5 }, W, H)).toThrow(/fractions/)
    expect(() => cropPixels({ x: 0, y: 0, w: 1.2, h: 0.5 }, W, H)).toThrow(/fractions/)
  })

  it('maps a crop pixel back to the full frame by the crop origin, not a scale', () => {
    // Break caught: landmarks sent in crop pixels (the spatial service would
    // map them through the full-frame calibration to the wrong key).
    const crop = cropPixels({ x: 0.123, y: 0.47, w: 0.2, h: 0.21 }, W, H)
    expect(toFullFrame({ x: 0, y: 0 }, crop)).toEqual({ x: 224, y: 496 })
    expect(toFullFrame({ x: 10.5, y: 20.25 }, crop)).toEqual({ x: 234.5, y: 516.25 })
  })

  it('sends exactly the fractions it maps with', () => {
    // Break caught: the request and the mapping computed from different
    // roundings of the same ROI.
    expect(roiParam({ x: 0.123, y: 0.47, w: 0.2, h: 0.21 })).toBe('0.123,0.47,0.2,0.21')
  })
})
