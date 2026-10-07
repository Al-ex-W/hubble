// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIT_FLOOR_MM, PX_PER_MM, fit, render } from './public/ipad.js'

// The page's drawing, in a DOM (happy-dom). A file of its own because
// happy-dom replaces the global URL, which tasks.ts's manifest path needs.

// Fixture: the committed notebooks manifest (synthetic, its own label). The
// oracle is the raw JSON, not tasks.ts's loader.
const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), '../../packages/stage/fixtures/notebooks/manifest.json')
const RAW = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, { lines: string[] }>
const task = (id: string) => ({ id, lines: RAW[id]!.lines })

function page() {
  document.body.innerHTML = '<main id="sheet"><h1 id="title"></h1><ol id="task"></ol></main>'
  return { root: document.getElementById('sheet')!, list: document.getElementById('task')! }
}

describe('several problems on the iPad (#88)', () => {
  it('numbers the problems in the order given, with every line of each', () => {
    // Catches: numbers out of tick order (the brain is told "problem 2" is
    // the second pick), a dropped line, or a problem missing from the sheet.
    const { root, list } = page()
    const ids = ['projectile', 'linear', 'system']
    render(root, { textMm: 8, task: task(ids[0]!), tasks: ids.map(task) })
    const items = [...list.querySelectorAll('li')]
    expect(items).toHaveLength(3)
    items.forEach((li, i) => {
      expect(li.querySelector('.n')!.textContent).toBe(`${i + 1}.`)
      expect([...li.querySelectorAll('p')].map((p) => p.textContent)).toEqual(RAW[ids[i]!]!.lines)
    })
    expect(root.querySelector('#title')!.textContent).toContain('3')
  })

  it('draws the state\'s numbers, gaps included, not the position (review #93)', () => {
    // Catches: numbering by position, which turned "2." into "1." on the
    // projectile problem when problem 1 was unticked.
    const { root, list } = page()
    const ids = ['projectile', 'system']
    render(root, { textMm: 8, task: task(ids[0]!), tasks: ids.map(task), numbers: [2, 4] })
    expect([...list.querySelectorAll('.n')].map((n) => n.textContent)).toEqual(['2.', '4.'])
  })

  it('draws one task unnumbered, also from a server that sends no tasks list', () => {
    // Catches: a lone "1." on a single-task sheet, and the page breaking
    // against a pre-#88 worksheet server (view.tasks missing).
    const { root, list } = page()
    render(root, { textMm: 8, task: task('limit') })
    expect(list.querySelectorAll('li')).toHaveLength(1)
    expect(list.querySelector('.n')).toBeNull()
    expect([...list.querySelectorAll('p')].map((p) => p.textContent)).toEqual(RAW.limit!.lines)
  })

  it('steps the text down until the problems fit, never up, never below 4 mm', () => {
    // happy-dom has no layout, so the list's height is modelled: content
    // grows with the text size (11 lines at 1.35 em + gaps, the worst four
    // problems) in a 180 mm box, the space between title and ruler. Oracle:
    // that plain arithmetic, solved for the size by hand below.
    // Catches: fitting upward past the operator's size, a loop that never
    // shrinks, or one that shrinks below the readable floor.
    const { root, list } = page()
    const px = () => parseFloat(root.style.getPropertyValue('--text'))
    const box = (contentMmPerEm: number, boxMm: number) => {
      Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => px() * contentMmPerEm })
      Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => boxMm * PX_PER_MM })
    }
    const perEm = 11 * 1.35 + 4 * 0.35 * 1 + 3 * 0.6 // ≈ 18.05 em of content
    box(perEm, 180)
    // 180 / 18.05 ≈ 9.97 mm: 8 fits as asked, 20 steps down to 9.5.
    expect(fit(root, list, 8)).toBe(8)
    expect(fit(root, list, 20)).toBe(9.5)
    expect(px()).toBeCloseTo(9.5 * PX_PER_MM, 1)
    box(perEm, 40) // fits nowhere: stops at the floor rather than vanishing
    expect(fit(root, list, 8)).toBe(FIT_FLOOR_MM)
  })
})

it('stops at the 4 mm floor within 32 layout reads when nothing fits (review #93)', () => {
  // The reviewer's fail-fast test: throwing from the getter aborts a
  // synchronous loop that a Vitest timeout can't (a mutant that drops the
  // floor spun forever in the first mutation run). 20 mm to 4 mm in 0.5 mm
  // steps is 32 reads.
  const root = document.createElement('div')
  const list = document.createElement('ol')
  let reads = 0
  Object.defineProperty(list, 'scrollHeight', {
    get() {
      if (++reads > 32) throw new Error('fit exceeded 32 layout reads')
      return 100
    },
  })
  Object.defineProperty(list, 'clientHeight', { get: () => 1 })
  expect(fit(root, list, 20)).toBe(4)
  expect(reads).toBeLessThanOrEqual(32)
})
