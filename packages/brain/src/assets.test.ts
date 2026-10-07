import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { loadRecording } from '@hubble/stage/testing'
import type { AssetInfo, RenderStreamLine, Scene, StageEvent } from '@hubble/stage'
import { createBrain } from './render.ts'

/**
 * Library assets through the brain (#30): the prompt offers exactly the
 * library's ids, and an answer can only show an asset the library has.
 * Fixtures: recorded answers with one Asset line added inside their panel
 * (label: mechanical mutation of a recording): scene-linear-center, whose
 * panel has room below it, and scene-linear-left, whose panel reaches almost
 * to the table's edge. Oracle: the published events and the system prompt
 * the model was sent.
 */
const usage = () => ({ inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } }) as never
const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: usage(), warnings: [] })
const LLM = { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'aixia-labs' }
// A wide, short strip: fits under the recorded panel's content on the table.
const diagram: AssetInfo = { id: 'right-triangle', kind: 'image', title: 'Right triangle with legs a, b and hypotenuse c', aspect: 0.2, url: '/api/assets/right-triangle/file' }
// The same picture at a tall aspect: the recorded panel would run off the table.
const tall: AssetInfo = { ...diagram, aspect: 0.75 }
const rec = loadRecording('scene-linear-center')
const full = loadRecording('scene-linear-left')
const withAsset = (id: string, text = rec.text) => text.replace('</Panel>', `<Asset id="${id}"/></Panel>`)

async function render(answer: string, scene: Scene) {
  const prompts: unknown[] = []
  const brain = createBrain({ llm: LLM, model: () => new MockLanguageModelV4({ doGenerate: async (o) => (prompts.push(o.prompt), textResult(answer)) }) })
  const lines: RenderStreamLine[] = []
  await brain.render({ intent: 'show me the diagram', scene }, (l) => lines.push(l))
  const events = lines.flatMap((l) => (l.kind === 'event' ? [l.event] : [])) as StageEvent[]
  return { events, system: JSON.stringify(prompts[0]) }
}
const assetPieces = (ev: StageEvent[]) => ev.filter((e) => e.type === 'piece' && e.tag === 'Asset').map((e) => (e as Extract<StageEvent, { type: 'piece' }>).attrs.id)

describe('library assets in the brain', () => {
  it('publishes an asset the library has, and offers it in the prompt', async () => {
    expect(rec.text).toContain('</Panel>') // the mutation has a panel to go into
    const { events, system } = await render(withAsset('right-triangle'), { ...rec.scene!, assets: [diagram] })
    expect(assetPieces(events)).toEqual(['right-triangle'])
    expect(system).toContain('right-triangle')
  })

  it('reserves the asset\'s real height: a picture that pushes the panel off the table fails verification', async () => {
    // Break caught: the asset's height not reaching the layout guard, so an
    // answer whose panel runs 300 px past the table edge is published.
    const { events } = await render(withAsset('right-triangle', full.text), { ...full.scene!, assets: [tall] })
    expect(assetPieces(events)).toEqual([])
  })

  it('never publishes an asset id the library does not have', async () => {
    // Break caught: the brain parsing with the base catalog (or a free-text
    // id), so a made-up id reaches displays as a request for a file.
    const { events } = await render(withAsset('secret-plans'), { ...rec.scene!, assets: [diagram] })
    expect(assetPieces(events)).toEqual([])
  })

  it('without a library, Asset is not offered and not shown', async () => {
    const { events, system } = await render(withAsset('right-triangle'), rec.scene!)
    expect(assetPieces(events)).toEqual([])
    expect(system).not.toContain('<Asset')
  })
})
