import { describe, expect, it } from 'vitest'
import type { RenderStreamLine } from '@hubble/stage'
import { applyTableLine, IDLE, type TableState } from './tableState.ts'

const start = (renderId: string): RenderStreamLine => ({ kind: 'start', renderId, intent: 'x', model: 'm', t: 0 })
const text = (renderId: string, id: string): RenderStreamLine => ({ kind: 'event', renderId, t: 1, event: { type: 'text', id, text: id } as never })
const fold = (lines: RenderStreamLine[]) => lines.reduce<TableState>((s, l, i) => applyTableLine(s, l, i), IDLE)

describe('the projector', () => {
  it('drops lines from any render but the one it started', () => {
    // Break caught: a late line of an older answer appearing inside the new one.
    const s = fold([start('a'), text('a', 'a1'), start('b'), text('a', 'a2'), text('b', 'b1')])
    expect(s.renderId).toBe('b')
    expect(s.events.map((e) => (e as { id: string }).id)).toEqual(['b1'])
  })

  it('plays a repeated render again from the top', () => {
    const once = fold([start('a'), text('a', 'a1')])
    const again = fold([start('a'), text('a', 'a1'), start('a'), text('a', 'a1')])
    expect(again.events).toHaveLength(1)
    expect(again.key).not.toBe(once.key)
  })
})
