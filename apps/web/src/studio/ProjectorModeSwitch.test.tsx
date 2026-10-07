// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectorModeSwitch } from './ProjectorModeSwitch.tsx'

/** Synthetic: a stand-in server. Oracle is the request sent and the pressed state drawn from the SSE event. */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

it('POSTs the chosen mode, and shows the SERVER mode as pressed (catches: a switch that trusts its own last click)', async () => {
  let source!: { onmessage: (e: { data: string }) => void }
  vi.stubGlobal('EventSource', class { onmessage: unknown; constructor() { source = this as never } close() {} })
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const host = document.createElement('div'); document.body.append(host)
  await act(async () => { createRoot(host).render(createElement(ProjectorModeSwitch)) })
  const [canvas, calibrate] = [...host.querySelectorAll('button')]
  expect(canvas.getAttribute('aria-pressed')).toBe('true')
  expect(fetchMock).not.toHaveBeenCalled() // mounting alone must not fire a request
  await act(async () => { calibrate.click() })
  expect(fetchMock).toHaveBeenCalledWith('/api/projector/mode', expect.objectContaining({ method: 'POST', body: JSON.stringify({ mode: 'calibrate' }) }))
  expect(calibrate.getAttribute('aria-pressed')).toBe('false') // not yet: the server has not said so
  await act(async () => { source.onmessage({ data: JSON.stringify({ mode: 'calibrate', since: 'x' }) }) })
  expect(calibrate.getAttribute('aria-pressed')).toBe('true')
  expect(canvas.getAttribute('aria-pressed')).toBe('false')
  // Catches: a client that trusts any event and leaves both buttons unpressed / the projector on an unknown mode.
  await act(async () => { source.onmessage({ data: JSON.stringify({ mode: 'party', since: 'y' }) }) })
  expect(calibrate.getAttribute('aria-pressed')).toBe('true')
})
