// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TableSurface } from '@hubble/stage'
import { useSurfaces } from './surfaces.ts'

/**
 * The hook against a stand-in EventSource (label: schema-derived lines).
 * The pure rev rule is tested in surfaces.test.ts; this proves the hook really
 * forgets the old revision when the connection reopens (review #38: that
 * reset could be removed with every test still green).
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeEventSource {
  static last: FakeEventSource
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  constructor() {
    FakeEventSource.last = this
  }
  close() {}
}
const send = (rev: number, ids: string[]) =>
  act(() => FakeEventSource.last.onmessage?.({ data: JSON.stringify({ kind: 'surfaces', rev, surfaces: ids.map((id) => ({ id }) as TableSurface) }) }))

let host: HTMLElement
let root: Root
let seen: readonly TableSurface[] | null = null
function Probe() {
  seen = useSurfaces()
  return null
}
beforeEach(() => {
  ;(globalThis as { EventSource: unknown }).EventSource = FakeEventSource
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(() => act(() => root.unmount()))

describe('useSurfaces', () => {
  it('is null until a set arrives, then accepts a restarted server counting from 1 again', async () => {
    await act(async () => root.render(createElement(Probe)))
    expect(seen).toBeNull()
    await send(7, ['a', 'b'])
    expect(seen!.map((s) => s.id)).toEqual(['a', 'b'])
    await send(3, ['stale'])
    expect(seen!.map((s) => s.id)).toEqual(['a', 'b']) // an older line on the same connection is dropped
    // The server restarted: the browser reconnects and the new server's set is rev 1.
    await act(() => FakeEventSource.last.onopen?.())
    await send(1, ['fresh'])
    // Break caught: the display refusing every set from a restarted server as "older".
    expect(seen!.map((s) => s.id)).toEqual(['fresh'])
  })
})
