// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperatingSurface, initialMode } from './OperatingSurface.tsx'
import { PRESETS } from './presets.ts'

/**
 * The operating surface's two modes (#75), against a stand-in server.
 * Labels: schema-derived. The status body is the shape apps/server/operator.ts's
 * GET /api/operator/status returns, and the turn body is the brain's
 * TurnResult. Oracles are the requests the page sends and the DOM it draws,
 * never the components' own helpers.
 *
 * Setup mode is the bench, already tested in ChatPreview.test.tsx. Here it
 * is stubbed to a marker, so these tests are about the switch and Show.
 */
vi.mock('../preview/ChatPreview.tsx', () => ({ ChatPreview: () => createElement('div', { 'data-mock': 'bench' }, createElement('div', { 'data-mock': 'lesson' })) }))
// The real LessonPanel needs Web MIDI, which happy-dom lacks. A marker lets
// the tests count how many are mounted.
// The page mounts the puppet master hook once. Mocked at the module so the tests assert the
// wiring (what Show hands to send / stopTurn), not the hook's own streaming (its own tests).
const assistant = vi.hoisted(() => ({
  value: null as unknown,
  send: null as unknown as (...a: unknown[]) => Promise<boolean>,
  stopTurn: null as unknown as (...a: unknown[]) => void,
  mounts: 0,
  options: [] as unknown[],
}))
vi.mock('../hubble/assistant/usePuppetAssistant.ts', () => ({
  usePuppetAssistant: (opts?: unknown) => {
    assistant.mounts++
    assistant.options.push(opts)
    return assistant.value
  },
}))
vi.mock('../lesson/LessonPanel.tsx', () => ({ LessonPanel: () => createElement('div', { 'data-mock': 'lesson' }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STATUS = {
  act: 'math',
  mode: 'idle',
  lesson: null,
  keys: 25,
  keySource: 'camera',
  room: { kind: 'none', ok: true },
  camera: { calibrated: true, seen: 1 },
  midi: { lastAt: null, agoMs: null },
  brain: { configured: true, lastRender: null },
  worksheet: { on: false, url: null, shown: null, ruler: false, tasks: [{ id: 'linear', task: 'Lös ekvationen: 5(2x - 3) = 4x + 9' }, { id: 'limit', task: 'Beräkna gränsvärdet' }, { id: 'system', task: 'Solve the system: | 2x + 3y = 12 | x - y = 1' }, { id: 'integral', task: 'Beräkna integralen: | ∫ x·eˣ dx' }, { id: 'quadratic', task: 'Solve: | x² - 5x + 6 = 0' }], maxPicks: 4 },
  output: { room: null, requiresArm: false, active: false },
}
const idle = (over: Record<string, unknown> = {}) => ({ state: 'idle', turns: [], error: null, busy: false, activity: '', voices: [], voice: undefined, setVoice: () => {}, send: assistant.send, stopTurn: assistant.stopTurn, ...over })

let status: unknown = STATUS
let posts: { url: string; body: Record<string, unknown> }[] = []
let host: HTMLElement
let root: Root

beforeEach(() => {
  status = STATUS
  posts = []
  assistant.send = vi.fn(async () => true)
  assistant.stopTurn = vi.fn()
  assistant.mounts = 0
  assistant.value = idle()
  // An in-memory store: Node 25's own global localStorage (no
  // --localstorage-file) shadows happy-dom's and has no working methods.
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/operator/piano') {
      const enabled = init?.method === 'POST' ? JSON.parse(String(init.body)).enabled : false
      if (init?.method === 'POST') posts.push({ url, body: { enabled } })
      return new Response(JSON.stringify({ enabled, available: true, calibrated: false, status: enabled ? 'searching' : 'off', ageMs: null, snapshot: null }))
    }
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
      posts.push({ url, body })
      return new Response('{}')
    }
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
const render = async () => {
  await act(async () => root.render(createElement(OperatingSurface)))
  await flush()
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!

describe('the operating surface', () => {
  it('opens in Show, and honours a stored Setup', () => {
    // Break caught: the demo laptop opening on the developer bench, or a
    // throwing storage (private mode) taking the page down.
    expect(initialMode({ getItem: () => null })).toBe('show')
    expect(initialMode({ getItem: () => 'setup' })).toBe('setup')
    expect(initialMode({ getItem: () => 'nonsense' })).toBe('show')
    expect(
      initialMode({
        getItem: () => {
          throw new Error('denied')
        },
      }),
    ).toBe('show')
  })

  it('switches between Show and Setup with exactly one MiniLab in either', async () => {
    // Break caught: both modes mounted at once. Each LessonPanel forwards
    // every MIDI key, so two would send each press twice (#66).
    await render()
    expect(host.querySelector('.show')).not.toBeNull()
    await act(async () => button('show the virtual MiniLab').click())
    expect(host.querySelectorAll('[data-mock="lesson"]')).toHaveLength(1)
    await act(async () => button('Setup').click())
    expect(host.querySelector('.show')).toBeNull()
    expect(host.querySelector('[data-mock="bench"]')).not.toBeNull()
    expect(host.querySelectorAll('[data-mock="lesson"]')).toHaveLength(1)
    expect(localStorage.getItem('hubble.surface.mode')).toBe('setup')
  })

  it('is the conversation home: it follows keyboard and pinch input', async () => {
    // Break caught: SEND / pinch text is published by the server but no page turns it
    // into a puppet-master turn (the hook only listens when asked to).
    await render()
    expect(assistant.options.at(-1)).toEqual({ followTableInput: true })
  })

  it('asks the puppet master, typed or preset, and never the table agent', async () => {
    // Break caught: Show still posting /api/agent/turn (Julius's agent) instead of the owner's
    // assistant, or a preset sending the wrong words. Oracle: the exact strings handed to send().
    await render()
    const input = host.querySelector<HTMLInputElement>('input[aria-label="question"]')!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, 'what is x?')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => host.querySelector('form.show-ask')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    for (const p of PRESETS) await act(async () => button(p.label).click())
    expect((assistant.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['what is x?', ...PRESETS.map((p) => p.text)])
    expect(PRESETS.map((p) => p.label)).toEqual(['Solve it step by step', 'Show the graph', 'Explain the last step', 'Give me a hint'])
    expect(posts.some((p) => p.url === '/api/agent/turn' || p.url === '/api/render')).toBe(false)
    expect(input.value).toBe('')
  })

  it('shows what Hubble said, its activity and a working Stop, and no recorded backups', async () => {
    // Break caught: Stop not wired to stopTurn; fallback buttons still rendered (owner: no backups);
    // presets still clickable mid-turn.
    assistant.value = idle({ busy: true, activity: 'Working: show answer', turns: [{ id: 1, role: 'user', content: 'hi' }, { id: 2, role: 'assistant', content: 'Let us solve it.' }] })
    await render()
    expect(host.querySelector('.show-convo')?.textContent).toContain('Hubble: Let us solve it.')
    expect(host.querySelector('.show-activity')?.textContent).toContain('Working: show answer')
    expect(button(PRESETS[0].label).disabled).toBe(true)
    await act(async () => button('Stop').click())
    expect(assistant.stopTurn).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toMatch(/recorded/i)
    expect(posts.some((p) => p.url === '/api/operator/fallback')).toBe(false)
  })

  it('says plainly when the model fails', async () => {
    // Break caught: a failed turn leaving the operator staring at nothing.
    assistant.value = idle({ error: 'ElevenLabs audio could not be played.' })
    await render()
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Hubble could not answer: ElevenLabs audio could not be played.')
  })

  const box = (id: string) => host.querySelector<HTMLInputElement>(`.show-picks-list input[aria-label="${id}"]`)!
  const tick = async (id: string) => {
    await act(async () => box(id).click())
    await flush()
  }
  const sheetPosts = () => posts.filter((p) => p.url === '/api/operator/worksheet').map((p) => p.body)

  it('the Problems menu: the first tick hosts the worksheet and shows that problem, in one request (#88)', async () => {
    // Break caught: a menu that needs the worksheet switched on first; a
    // tick while it is off would then silently do nothing.
    await render()
    expect(host.querySelector('.show-picks-list')).toBeNull()
    await act(async () => button('Problems ▾').click())
    await tick('limit')
    expect(sheetPosts()).toEqual([{ on: true, taskIds: ['limit'] }])
  })

  it('each tick sends the whole list in tick order, also before the poll catches up (#88)', async () => {
    // Breaks caught: sending only the ticked id (the iPad would drop the
    // others); sorting into menu order (renumbers problems the audience has
    // seen); and two quick ticks both starting from the stale server list,
    // the second undoing the first. The stand-in server never changes its
    // status here, so only the menu's own record of what it sent can carry
    // the first tick into the second.
    status = { ...STATUS, worksheet: { ...STATUS.worksheet, on: true, shown: { taskId: 'system', taskIds: ['system'], textMm: 8 } } }
    await render()
    await act(async () => button('Problems ▾ 1').click())
    await tick('linear')
    await tick('integral')
    expect(sheetPosts()).toEqual([
      { on: true, taskIds: ['system', 'linear'] },
      { on: true, taskIds: ['system', 'linear', 'integral'] },
    ])
    // Numbers are the server's: the confirmed one shows its number, the two
    // the stand-in server never confirmed show "…", not a guess.
    const numbers = [...host.querySelectorAll('.show-pick.on')].map((l) => `${l.querySelector('.show-pick-n')!.textContent} ${l.querySelector('input')!.getAttribute('aria-label')}`)
    expect(numbers.sort()).toEqual(['1 system', '… integral', '… linear'])
  })

  it('at the cap the rest wait, and the last problem cannot be unticked (#88)', async () => {
    // Breaks caught: a fifth tick reaching the server (refused there, but the
    // operator sees a tick that did nothing), and an empty iPad.
    const four = ['linear', 'limit', 'system', 'integral']
    status = { ...STATUS, worksheet: { ...STATUS.worksheet, on: true, shown: { taskId: 'linear', taskIds: four, textMm: 8 } } }
    await render()
    await act(async () => button('Problems ▾ 4').click())
    expect(box('quadratic').disabled).toBe(true)
    expect(four.every((id) => !box(id).disabled)).toBe(true)
    status = { ...STATUS, worksheet: { ...STATUS.worksheet, on: true, shown: { taskId: 'limit', taskIds: ['limit'], textMm: 8 } } }
    await act(async () => new Promise((r) => setTimeout(r, 1100)))
    expect(box('limit').checked).toBe(true)
    expect(box('limit').disabled).toBe(true)
    expect(box('quadratic').disabled).toBe(false)
  })

  it('shows the server\'s numbers, gaps included (review #93)', async () => {
    // Catches: numbering by position in the menu, so "2" there would not be
    // "problem 2" on the iPad after problem 1 was unticked.
    status = { ...STATUS, worksheet: { ...STATUS.worksheet, on: true, shown: { taskId: 'limit', taskIds: ['limit', 'system'], numbers: [2, 3], textMm: 8 } } }
    await render()
    await act(async () => button('Problems ▾ 2').click())
    const n = (id: string) => box(id).closest('label')!.querySelector('.show-pick-n')!.textContent
    expect([n('limit'), n('system')]).toEqual(['2', '3'])
  })

  it('reads a server from before #88 (taskId only, no cap) as one problem', async () => {
    // Break caught: the menu crashing, or offering several picks the old
    // server would refuse, during a half-updated deploy.
    const { maxPicks: _drop, ...old } = STATUS.worksheet
    status = { ...STATUS, worksheet: { ...old, on: true, shown: { taskId: 'limit', textMm: 8 } } }
    await render()
    await act(async () => button('Problems ▾ 1').click())
    expect(box('limit').checked).toBe(true)
    expect(box('linear').disabled).toBe(true)
  })

  it('names which calibration the camera light is on, standard or measured', async () => {
    // Break caught: the camera tile hiding that the room is running on the
    // committed standard map (the 7 Oct fallback) rather than a live run.
    // "calibrated" alone let the operator believe the room had been measured
    // today when it had not.
    status = { ...STATUS, camera: { calibrated: true, seen: 1, source: 'standard', at: '2026-10-07T06:20:00Z' } }
    await render()
    expect(host.querySelector('.show-status')?.textContent).toContain('calibrated (standard 06:20)')
    await act(async () => root.unmount())
    host.remove()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    status = { ...STATUS, camera: { calibrated: true, seen: 1, source: 'measured', at: '2026-10-07T07:15:00Z' } }
    await render()
    expect(host.querySelector('.show-status')?.textContent).toContain('calibrated (measured 07:15)')
  })

  it('a status body without the required fields reads as "full server not running", and Show stays up', async () => {
    // Break caught: trusting any JSON as a status. A throw while drawing the
    // status lights would unmount the whole surface mid-demo.
    status = {}
    await render()
    expect(host.querySelector('.show-acts')).not.toBeNull()
    expect(host.querySelector('.show-status')?.textContent).toContain('full server not running')
  })
})
