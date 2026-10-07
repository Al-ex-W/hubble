// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Surface } from '@hubble/stage'
import { CalibrationPattern } from './CalibrationPattern.tsx'
import { patternGeometry, DEFAULT_SURFACE } from './calibrationGeometry.ts'

/**
 * Provenance: schema-derived / synthetic. Surfaces are the DEFAULT_SURFACE
 * (organisers' SPEC 1.55 m over 1920 px) and a deliberately DIFFERENT synthetic
 * one (1000 px at 2 mm/px) so a hard-coded 0.807 cannot pass. Oracles are
 * plain arithmetic on mm and the attributes read back from the rendered SVG
 * (DOM parse), never the geometry helper's own output.
 */
const SYNTHETIC: Surface = { widthPx: 1000, heightPx: 625, mmPerPx: 2 }

function render(surface: Surface, since = 'T') {
  const host = new DOMParser().parseFromString(renderToStaticMarkup(createElement(CalibrationPattern, { surface, since })), 'text/html')
  return host
}
const num = (el: Element | null, a: string) => Number(el!.getAttribute(a))

describe('calibration pattern geometry', () => {
  for (const [name, surface] of [['default', DEFAULT_SURFACE], ['synthetic 2 mm/px', SYNTHETIC]] as const) {
    describe(name, () => {
      const doc = render(surface)
      it('200 mm rulers are exactly 200/mmPerPx px long (catches: a wrong mm to px conversion)', () => {
        const rulers = [...doc.querySelectorAll('[data-role=ruler]')]
        expect(rulers).toHaveLength(2)
        for (const r of rulers) {
          expect(num(r, 'data-length-px')).toBeCloseTo(200 / surface.mmPerPx, 9)
          const l = r.querySelector('line')!
          const len = Math.hypot(num(l, 'x2') - num(l, 'x1'), num(l, 'y2') - num(l, 'y1'))
          expect(len).toBeCloseTo(200 / surface.mmPerPx, 6)
        }
        expect(rulers.map((r) => r.getAttribute('data-orientation')).sort()).toEqual(['h', 'v'])
        expect(doc.body.textContent).toContain('should measure 200 mm on the table')
        expect(doc.body.textContent).toContain('if not, mm/px is wrong')
        expect(doc.body.textContent).toContain(`${surface.mmPerPx.toFixed(4)} mm/px`)
      })

      it('nine marks sit at inset 150 mm and mm/px-scaled px, numbered from the far (top, lidar) row (catches: swapped rows or a wrong inset)', () => {
        const marks = [...doc.querySelectorAll('[data-role=mark]')]
        expect(marks.map((m) => num(m, 'data-mark'))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
        const wMm = surface.widthPx * surface.mmPerPx
        const hMm = surface.heightPx * surface.mmPerPx
        const xs = [150, wMm / 2, wMm - 150]
        const ys = [150, hMm / 2, hMm - 150]
        marks.forEach((m, i) => {
          const mmX = xs[i % 3], mmY = ys[Math.floor(i / 3)]
          expect(num(m, 'data-px-x')).toBeCloseTo(mmX / surface.mmPerPx, 6)
          expect(num(m, 'data-px-y')).toBeCloseTo(mmY / surface.mmPerPx, 6)
          expect(num(m.querySelector('circle'), 'cx')).toBeCloseTo(mmX / surface.mmPerPx, 6)
          expect(num(m, 'data-mm-x')).toBeCloseTo(mmX, 0)
        })
        // Mark 2 is the one nearest the lidar: top row, middle.
        expect(num(marks[1], 'data-px-y')).toBeLessThan(num(marks[7], 'data-px-y'))
      })

      it('grid: 100 mm lines, every 500 mm thick and labelled (catches: thick lines on the wrong multiple)', () => {
        const major = [...doc.querySelectorAll('[data-role=major-v]')].map((l) => num(l, 'data-mm'))
        expect(major).toEqual(Array.from({ length: 5 }, (_, k) => k * 500).filter((mm) => mm <= surface.widthPx * surface.mmPerPx))
        const minorV = doc.querySelectorAll('[data-role=minor-v]').length
        const majorV = major.length
        expect(minorV + majorV).toBe(Math.floor((surface.widthPx * surface.mmPerPx) / 100) + 1)
        for (const l of doc.querySelectorAll('[data-role=major-v]')) expect(num(l, 'x1')).toBeCloseTo(num(l, 'data-mm') / surface.mmPerPx, 6)
        expect(doc.querySelector('[data-role=grid-label]')!.textContent).toMatch(/mm$/)
      })

      it('border and corners sit at the frame edge, labelled with their pixel coordinates', () => {
        const b = doc.querySelector('[data-role=border]')!
        // A 2 px stroke centred 1 px in covers exactly the outer 2 px.
        expect([num(b, 'x') - num(b, 'stroke-width') / 2, num(b, 'y') - 1]).toEqual([0, 0])
        expect(num(b, 'x') + num(b, 'width') + num(b, 'stroke-width') / 2).toBe(surface.widthPx)
        expect(num(b, 'y') + num(b, 'height') + 1).toBe(surface.heightPx)
        expect(b.getAttribute('stroke-width')).toBe('2')
        const labels = [...doc.querySelectorAll('[data-role=corner]')].map((c) => c.getAttribute('data-label'))
        expect(labels).toEqual(['0,0', `${surface.widthPx - 1},0`, `${surface.widthPx - 1},${surface.heightPx - 1}`, `0,${surface.heightPx - 1}`])
        const svg = doc.querySelector('svg')!
        expect(svg.getAttribute('viewBox')).toBe(`0 0 ${surface.widthPx} ${surface.heightPx}`)
        const centre = doc.querySelector('[data-role=centre]')!
        expect([num(centre, 'data-px-x'), num(centre, 'data-px-y')]).toEqual([surface.widthPx / 2, surface.heightPx / 2].map(Math.floor))
      })
    })
  }

  it('the default surface is Julius\'s 1920 x 1200 over 1550 mm (catches: a private mm/px)', () => {
    expect(DEFAULT_SURFACE).toEqual({ widthPx: 1920, heightPx: 1200, mmPerPx: 1550 / 1920 })
    const doc = render(DEFAULT_SURFACE, '2026-10-07T10:00:00.000Z')
    expect(doc.body.textContent).toContain('1550 x 968.8 mm')
    expect(doc.body.textContent).toContain('(960,600)')
    expect(doc.body.textContent).toContain('since 2026-10-07T10:00:00.000Z')
  })

  it('geometry exposes the same numbers the SVG draws', () => {
    expect(patternGeometry(SYNTHETIC).rulers[0].lengthPx).toBe(100)
  })
})

// ---- the projector page switches on the mode ----
const mode = vi.hoisted(() => ({ value: 'canvas' as 'canvas' | 'calibrate' }))
vi.mock('./projectorMode.ts', async (orig) => ({ ...(await orig<typeof import('./projectorMode.ts')>()), useProjectorMode: () => ({ mode: mode.value, since: 'S', choose: vi.fn(), error: '' }) }))
vi.mock('../hubble/assistant/usePuppetAssistant.ts', () => ({ usePuppetAssistant: () => ({ send: vi.fn(), select: vi.fn(), turns: [], busy: false, error: '', activity: '', stopTurn: vi.fn() }) }))
vi.mock('../hubble/assistant/VoiceSelect.tsx', () => ({ VoiceSelect: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('projector page', () => {
  afterEach(() => { document.body.innerHTML = ''; window.history.replaceState({}, '', '/') })
  async function mount(url: string, projector = true) {
    window.history.replaceState({}, '', url)
    const { StudioPage } = await import('./StudioPage.tsx')
    class FakeEventSource { onmessage: unknown; onerror: unknown; close() {} }
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    const host = document.createElement('div'); document.body.append(host)
    await act(async () => { createRoot(host).render(createElement(StudioPage, { projector })) })
    return host
  }
  it('shows the pattern when mode=calibrate and the canvas otherwise (catches: a mode switch that does nothing)', async () => {
    mode.value = 'calibrate'
    expect((await mount('/studio/projector')).querySelector('[data-calibration-pattern]')).not.toBeNull()
    document.body.innerHTML = ''
    mode.value = 'canvas'
    expect((await mount('/studio/projector')).querySelector('[data-calibration-pattern]')).toBeNull()
  })
  it('?calibrate=1 forces the pattern on the projector view only', async () => {
    mode.value = 'canvas'
    expect((await mount('/studio/projector?calibrate=1')).querySelector('[data-calibration-pattern]')).not.toBeNull()
    document.body.innerHTML = ''
    mode.value = 'calibrate'
    expect((await mount('/studio?calibrate=1', false)).querySelector('[data-calibration-pattern]')).toBeNull()
  })
})
