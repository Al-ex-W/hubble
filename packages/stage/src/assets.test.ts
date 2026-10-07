import { describe, expect, it } from 'vitest'
import { catalogFor, type AssetInfo } from './assets.ts'
import { CATALOG } from './catalog.ts'
import { createStageParser } from './parser.ts'
import { buildSystemPrompt } from './prompt.ts'
import { estimateHeight, resolvePanels } from './report.ts'
import { DEFAULT_SURFACE, type Scene } from './scene.ts'
import type { StageEvent } from './protocol.ts'

/**
 * Assets the model may name, through the per-request catalog. Label:
 * schema-derived (asset entries and answer texts written to the catalog's
 * grammar). Oracle: the parser's own events (piece vs drop) and plain
 * arithmetic for the estimate.
 */
const diagram: AssetInfo = { id: 'right-triangle', kind: 'image', title: 'Right triangle with legs a, b and hypotenuse c', aspect: 0.75, url: '/api/assets/right-triangle/file' }
const scene = (assets?: AssetInfo[]): Scene => ({ surface: DEFAULT_SURFACE, objects: [], assets })
const parse = (text: string, s: Scene) => {
  const p = createStageParser(catalogFor(s))
  return [...p.push(text), ...p.end()]
}
const pieces = (ev: StageEvent[]) => ev.filter((e) => e.type === 'piece').map((e) => (e as Extract<StageEvent, { type: 'piece' }>).tag)
const drops = (ev: StageEvent[]) => ev.filter((e) => e.type === 'drop').map((e) => (e as Extract<StageEvent, { type: 'drop' }>).reason)

describe('catalogFor', () => {
  it('with no assets is exactly the base catalog, so every prompt and parse stays as recorded', () => {
    // Break caught: the recorded corpus and the census shifting because a
    // table with no library suddenly gets an Asset component in its prompt.
    expect(catalogFor(scene())).toBe(CATALOG)
    expect(catalogFor(scene([]))).toBe(CATALOG)
    expect(buildSystemPrompt({ hasImage: false, scene: scene() }, catalogFor(scene()))).toBe(buildSystemPrompt({ hasImage: false, scene: scene() }))
  })

  it('lets the model place a library asset in a panel, and drops an id the library does not have', () => {
    const s = scene([diagram])
    expect(pieces(parse('<Canvas><Panel x={100} y={100} w={500}><Asset id="right-triangle"/></Panel></Canvas>', s))).toEqual(['Asset'])
    // Break caught: a made-up id reaching the renderer (a broken image, or a
    // request to a file the server must never serve).
    const ghost = parse('<Canvas><Panel x={100} y={100} w={500}><Asset id="secret-plans"/></Panel></Canvas>', s)
    expect(pieces(ghost)).toEqual([])
    expect(drops(ghost)).toContain('bad-attribute')
  })

  it('without a library an Asset is unknown, whatever its id', () => {
    const ev = parse('<Canvas><Panel x={100} y={100} w={500}><Asset id="right-triangle"/></Panel></Canvas>', scene())
    expect(pieces(ev)).toEqual([])
    expect(drops(ev).length).toBeGreaterThan(0)
  })

  it('lists the available ids and what they show in the prompt', () => {
    const prompt = buildSystemPrompt({ hasImage: false, scene: scene([diagram]) }, catalogFor(scene([diagram])))
    expect(prompt).toContain('<Asset ... />')
    expect(prompt).toContain('right-triangle')
    expect(prompt).toContain('Right triangle with legs a, b and hypotenuse c')
  })

  it.each(['<Canvas><Mark target="notebook"><Asset id="right-triangle"/></Mark></Canvas>', '<Canvas><Label x={10} y={10}><Asset id="right-triangle"/></Label></Canvas>'])(
    'never lets an Asset sit inside a spatial element: it ends up in the panel flow (%s)',
    (text) => {
      // Assets are laid out like Plot, inside a panel the guard checked, never
      // on an object like a Mark or a Label. Written inside one, the spatial
      // element is malformed and dropped and the Asset lands on the Canvas,
      // whose flow content is the implicit panel.
      const ev = parse(text, scene([diagram]))
      const canvas = ev.find((e) => e.type === 'open' && e.tag === 'Canvas') as Extract<StageEvent, { type: 'open' }>
      const asset = ev.find((e) => e.type === 'piece' && e.tag === 'Asset') as Extract<StageEvent, { type: 'piece' }> | undefined
      if (asset) expect(asset.parent).toBe(canvas.id)
    },
  )
})

describe('the layout estimate of an asset', () => {
  it('is the panel width times the asset aspect, so the guard reserves its real height', () => {
    // Break caught: an asset estimated at 0 px, so the guard lets the next
    // panel land on top of the picture.
    const s = scene([diagram])
    const ev = parse('<Canvas><Panel x={100} y={100} w={500}><Asset id="right-triangle"/></Panel></Canvas>', s)
    const withAsset = resolvePanels(ev, s)[0]!.height
    const empty = resolvePanels(parse('<Canvas><Panel x={100} y={100} w={500}></Panel></Canvas>', s), s)[0]!.height
    expect(withAsset - empty).toBeGreaterThan(300) // ~ inner width (500 minus padding) × 0.75
    const node = { tag: 'Asset', attrs: { id: 'right-triangle' }, body: '', text: '', children: [], id: 'x' }
    expect(estimateHeight(node as never, 400, DEFAULT_SURFACE, [diagram])).toBe(300)
    expect(estimateHeight({ ...node, attrs: { id: 'unknown' } } as never, 400, DEFAULT_SURFACE, [diagram])).toBe(0)
  })

  it('reserves an asset\'s height inside Columns too', () => {
    // Review #43 survivor: an Asset in a Column was estimated at 0 px when the
    // library wasn't passed down through Columns, so the guard let panels
    // overlap the picture.
    const s = scene([diagram])
    const withAsset = parse('<Canvas><Panel x={100} y={100} w={600}><Columns><Column><Text>Left</Text></Column><Column><Asset id="right-triangle"/></Column></Columns></Panel></Canvas>', s)
    const without = parse('<Canvas><Panel x={100} y={100} w={600}><Columns><Column><Text>Left</Text></Column><Column><Text>Right</Text></Column></Columns></Panel></Canvas>', s)
    expect(resolvePanels(withAsset, s)[0]!.height - resolvePanels(without, s)[0]!.height).toBeGreaterThan(150)
  })
})
