// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OperatingSurface } from '../surface/OperatingSurface.tsx'

/**
 * The real MiniLab reaching the runtime (audit of 7 Oct).
 *
 * Label: schema-derived. The Web MIDI stand-in follows the spec's shape
 * (requestMIDIAccess -> MIDIAccess.inputs, MIDIInput.onmidimessage, data =
 * [status, note, velocity]), and, as Chrome does, it hands every
 * requestMIDIAccess call its OWN input objects. That is what turns a leaked
 * binding into a doubled press: on a shared object the second assignment
 * would just overwrite the first. Access is granted only when the test
 * resolves it, so StrictMode's mount, cleanup and re-mount all happen
 * before it, exactly as in the browser.
 *
 * Oracle: the POSTs to /api/input/midi, the one place a press is counted.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Input = { id: string; name: string; onmidimessage: ((m: { data: number[] }) => void) | null }
let grants: (() => void)[] = []
let inputs: Input[] = []
let midiPosts: unknown[] = []
let host: HTMLElement
let root: Root

beforeEach(() => {
  grants = []
  inputs = []
  midiPosts = []
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    configurable: true,
    value: () =>
      new Promise((resolve) => {
        const input: Input = { id: `minilab-${inputs.length}`, name: 'Minilab3 MIDI', onmidimessage: null }
        inputs.push(input)
        const map = new Map([[input.id, input]])
        grants.push(() => resolve({ inputs: map, onstatechange: null }))
      }),
  })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/input/midi') midiPosts.push(JSON.parse(String(init?.body)))
    return new Response(url === '/api/operator/status' ? '{}' : '{}')
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  delete (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess
})

/** Press a key on every input that has a handler, as the hardware would on each bound port object. */
const press = (note: number) => inputs.forEach((i) => i.onmidimessage?.({ data: [0x90, note, 100] }))

it('the default Show view forwards the real keyboard, once per press, under StrictMode', async () => {
  // Breaks caught:
  // (1) Show forwarding nothing until the virtual MiniLab backup is opened:
  //     the forwarder lived inside that panel, so the real keyboard was deaf
  //     in the default view.
  // (2) StrictMode's early cleanup leaving the first mount's late binding in
  //     place: two handlers, and every press counted twice (on site the
  //     lesson advanced and then flashed the same key red).
  await act(async () => root.render(createElement(StrictMode, null, createElement(OperatingSurface))))
  expect(host.querySelector('.show')).not.toBeNull()
  expect(host.querySelector('.lesson-panel')).toBeNull()
  // Grant every access request the effects made, in order, after the
  // StrictMode cleanup has run.
  await act(async () => {
    grants.forEach((g) => g())
    await Promise.resolve()
  })
  await act(async () => press(64))
  expect(midiPosts).toEqual([{ type: 'note-on', note: 64, velocity: 100, device: 'Minilab3 MIDI' }])
})
