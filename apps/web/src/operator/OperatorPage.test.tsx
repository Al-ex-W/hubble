// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperatorPage } from './OperatorPage.tsx'

/**
 * The operator page with its embedded virtual MiniLab, against a stand-in
 * server (label: schema-derived status bodies, the shape operator.ts's
 * /api/operator/status returns; Ode to Joy opens on E4 = 64).
 *
 * The server side of each button is proven over HTTP in
 * apps/server/operator.test.ts; this proves the page sends the embedded
 * panel's clicks to the right route and shows the server's lesson, which
 * the server tests can't see (review #40, findings 2 and 3).
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base = {
  act: 'math',
  mode: 'idle',
  lesson: null as null | { song: string; index: number; total: number; expected: number | null },
  room: { kind: 'emulator', ok: true, displays: 3, lights: 2 },
  camera: { calibrated: false, seen: 0 },
  midi: { lastAt: null, agoMs: null },
  brain: { configured: false, lastRender: null },
}
let status = base
let posts: { url: string; body: unknown }[] = []

let host: HTMLElement
let root: Root
beforeEach(() => {
  status = base
  posts = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/operator/status') return new Response(JSON.stringify(status))
    return new Response('{}')
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))
const embedded = () => host.querySelector('.op-midi')!
const nextKeys = () => [...embedded().querySelectorAll('.vkey.next')].map((k) => k.getAttribute('title'))

describe('OperatorPage', () => {
  it("the virtual MiniLab shows the server's lesson, and follows it when the act changes elsewhere", async () => {
    status = { ...base, act: 'lesson', lesson: { song: 'Ode to Joy', index: 0, total: 15, expected: 64 } }
    await act(async () => root.render(createElement(OperatorPage)))
    await flush()
    // Break caught (finding 3): the embedded panel keeping its own copy that
    // said "no lesson" with no key lit while the lesson was running.
    expect(nextKeys()).toEqual(['E4'])
    expect(embedded().textContent).toContain('Ode to Joy: 0/15')

    // Reset elsewhere (another tab, or the reset button): the next poll says so.
    status = base
    await act(async () => void (host.querySelector('button.danger') as HTMLButtonElement).click())
    await flush()
    // Break caught: the old lit key staying on the virtual MiniLab after reset.
    expect(nextKeys()).toEqual([])
    expect(embedded().textContent).toContain('no lesson')
  })

  it("the virtual MiniLab's song buttons start the act through the operator route", async () => {
    await act(async () => root.render(createElement(OperatorPage)))
    await flush()
    const ode = [...embedded().querySelectorAll('button')].find((b) => b.textContent === 'Ode to Joy')!
    await act(async () => void ode.click())
    await flush()
    // Break caught (finding 2): /api/lesson/start skips the answer dismissal,
    // so the math answer stayed projected beside the lit key.
    expect(posts.map((p) => p.url)).toEqual(['/api/operator/act'])
    expect(posts[0]!.body).toEqual({ act: 'lesson', song: 'ode-to-joy' })

    const stop = [...embedded().querySelectorAll('button')].find((b) => b.textContent === 'stop')!
    await act(async () => void stop.click())
    await flush()
    expect(posts.at(-1)).toEqual({ url: '/api/operator/act', body: { act: 'math' } })
  })

  it('the iPad worksheet checkbox hosts it, then shows the address to open', async () => {
    // Owner (#60): "just a checkbox". Breaks caught: the box posting to the
    // wrong route or shape, and the page showing an address while the server
    // says the worksheet is off.
    const off = { on: false, url: null, shown: null, ruler: false, tasks: [{ id: 'linear', task: 'Lös ekvationen: / 5(2x - 3) = 4x + 9' }] }
    status = { ...base, worksheet: off } as typeof base
    await act(async () => root.render(createElement(OperatorPage)))
    await flush()
    const box = host.querySelector('.op-sheet input[type=checkbox]') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(host.querySelector('.op-url')).toBeNull()

    status = { ...base, worksheet: { ...off, on: true, url: 'http://192.168.42.18:8793/', shown: { taskId: 'linear', textMm: 8 } } } as typeof base
    await act(async () => void box.click())
    await flush()
    expect(posts).toContainEqual({ url: '/api/operator/worksheet', body: { on: true } })
    expect(host.querySelector('.op-url a')!.getAttribute('href')).toBe('http://192.168.42.18:8793/')
  })
})
