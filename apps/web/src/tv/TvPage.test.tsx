// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('../hubble/orb/Orb.tsx', () => ({ Orb: ({ state }: { state: string }) => <i data-orb={state} /> }))
import { TvPage, BUBBLE_HOLD_MS } from './TvPage.tsx'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('TvPage (minimal)', () => {
  it('shows a speech line in the bubble, then hides it after the hold', () => {
    // Break caught: the TV never reacting to /api/puppet/speech/events, or the
    // bubble staying up forever after the line ended.
    vi.useFakeTimers()
    let source: any
    vi.stubGlobal('EventSource', class { onmessage: any; close = vi.fn(); constructor(public url: string) { source = this } })
    const div = document.createElement('div'); document.body.append(div)
    act(() => createRoot(div).render(<TvPage screen={null} />))
    expect(source.url).toBe('/api/puppet/speech/events')
    expect(div.querySelector('.tv-bubble-on')).toBeNull()
    act(() => source.onmessage({ data: JSON.stringify({ type: 'turn', phase: 'start' }) }))
    expect(div.querySelector('.tv-bubble-on')).toBeNull()
    act(() => source.onmessage({ data: JSON.stringify({ type: 'speech', id: 'a', text: 'Hello there' }) }))
    expect(div.querySelector('.tv-bubble-on')?.textContent).toBe('Hello there')
    act(() => { vi.advanceTimersByTime(BUBBLE_HOLD_MS + 1) })
    expect(div.querySelector('.tv-bubble-on')).toBeNull()
  })
})
