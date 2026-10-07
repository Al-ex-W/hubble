// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePuppetAssistant } from './usePuppetAssistant.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Schema-derived server events and a fake Audio. No live audio or model recording is
// claimed; assertions inspect the actual HTTP requests.
let assistant: ReturnType<typeof usePuppetAssistant>
const roots: ReturnType<typeof createRoot>[] = []
function mount(options?: Parameters<typeof usePuppetAssistant>[0]) {
  const div = document.createElement('div'); document.body.append(div)
  const root = createRoot(div); roots.push(root)
  function Probe() { assistant = usePuppetAssistant(options); return <div>{assistant.state}</div> }
  act(() => root.render(<Probe />))
  return div
}
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.clearAllMocks()
})
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

describe('typed turns', () => {
  it('a typed turn requests audio, plays the streamed speech, and acks {ok} only after playback ends', async () => {
    // Break caught: with no voice mode, `audio` used to follow the (now removed) mic flag. If it
    // is false or missing, the server never streams audio and Hubble stays silent on every typed
    // turn. Also: acknowledging when play() resolves instead of when playback ENDS lets the next
    // tool edit the canvas while the introduction is still being spoken.
    const requests: Array<{ url: string; body?: any }> = []
    let player: any
    class FakeAudio {
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn()
      constructor(public src: string) { if (src.startsWith('/api/')) player = this }
      play = vi.fn(async () => {})
    }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url === '/api/puppet/sessions') return Response.json({ id: 'conversation' })
      if (url.endsWith('/turn')) return new Response('{"type":"speech","id":"speech-1","text":"Before the edit","audio":true}\n{"type":"done"}\n')
      return new Response(null, { status: 204 })
    }))
    mount()
    let pending!: Promise<boolean>
    await act(async () => { pending = assistant.send('Make a tool'); await tick(10) })
    expect(requests.filter(x => x.url.endsWith('/turn')).map(x => x.body)).toEqual([{ text: 'Make a tool', audio: true }])
    // The audio element was pointed at THIS speech's audio route, and is audibly "speaking".
    expect(player?.src).toBe('/api/puppet/sessions/conversation/speech/speech-1')
    expect(player.play).toHaveBeenCalled()
    expect(assistant.state).toBe('speaking')
    expect(requests.some(x => x.url.endsWith('/ack'))).toBe(false)
    await act(async () => { player.onended(); await pending })
    const acks = requests.filter(x => x.url.endsWith('/ack'))
    expect(acks.map(x => x.body)).toEqual([{ ok: true }])
    expect(player.removeAttribute).toHaveBeenCalledWith('src')
    expect(assistant.busy).toBe(false)
    expect(assistant.state).toBe('idle')
  })

  it('Stop during playback silences the audio and posts cancel', async () => {
    // Break caught: Stop leaves the server turn running (cancel never posted). The pause is also done by the playback finally-block, so only the cancel is mutation-proven here.
    const requests: string[] = []
    let player: any
    class FakeAudio {
      onended: (() => void) | null = null; onerror: (() => void) | null = null
      pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn()
      constructor(public src: string) { if (src.startsWith('/api/')) player = this }
      play = vi.fn(async () => {})
    }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url)
      if (url === '/api/puppet/sessions') return Response.json({ id: 'conversation' })
      if (url.endsWith('/turn')) return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"type":"speech","id":"s","text":"Hi","audio":true}\n')) } }))
      return new Response(null, { status: 204 })
    }))
    mount()
    await act(async () => { void assistant.send('hello').catch(() => {}); await tick(10) })
    expect(player).toBeDefined()
    const cancelsBefore = requests.filter(x => x.endsWith('/cancel')).length
    await act(async () => { assistant.stopTurn(); await tick(10) })
    expect(player.pause).toHaveBeenCalled()
    expect(requests.filter(x => x.endsWith('/cancel')).length).toBe(cancelsBefore + 1)
    expect(assistant.busy).toBe(false)
  })

  it('a second typed turn while one runs is dropped client-side: no abort, no second POST', async () => {
    // Break caught: a new send aborting the running turn (a stray message killing a demo answer
    // mid-speech), or a second POST that the server would 409.
    const posts: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/turn')) {
        posts.push(JSON.parse(String(init!.body)).text)
        return new Response(new ReadableStream({ async start(c) { await gate; c.enqueue(new TextEncoder().encode('{"type":"done"}\n')); c.close() } }))
      }
      if (url === '/api/puppet/sessions') return Response.json({ id: 'conversation' })
      return new Response(null, { status: 204 })
    }))
    mount()
    await act(async () => { void assistant.send('first question'); await tick() })
    expect(assistant.busy).toBe(true)
    let second: boolean | undefined
    await act(async () => { second = await assistant.send('something else'); await tick() })
    expect(second).toBe(false)
    expect(posts).toEqual(['first question'])
    expect(assistant.turns.filter(t => t.role === 'user')).toHaveLength(1)
    await act(async () => { release(); await tick() })
    expect(assistant.busy).toBe(false)
  })

  it('sends the viewer\'s selected voice in the turn body, and none before they pick', async () => {
    // Break caught: the select changes the UI but the turn never carries the id
    // (or the default is sent unasked, overriding the hosted agent voice).
    // Schema-derived /voices answer; localStorage is the real happy-dom one.
    localStorage.clear()
    const turns: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/puppet/voices') return Response.json({ voices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], default: 'a' })
      if (url === '/api/puppet/sessions') return Response.json({ id: 'conversation' })
      if (url.endsWith('/turn')) { turns.push(JSON.parse(String(init?.body))); return new Response('{"type":"done"}\n') }
      return new Response(null, { status: 204 })
    }))
    mount()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(assistant.voice).toBe('a')
    await act(async () => { await assistant.send('one') })
    act(() => assistant.setVoice('b'))
    await act(async () => { await assistant.send('two') })
    expect(turns.map(t => t.voice)).toEqual([undefined, 'b'])
    expect(localStorage.getItem('hubble.puppet.voice')).toBe('b')
  })

  it('falls back to the server default when the stored voice is no longer listed', async () => {
    // Break caught: a stale localStorage id is sent and every turn 400s.
    localStorage.setItem('hubble.puppet.voice', 'gone')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ voices: [{ id: 'a', label: 'A' }], default: 'a' })))
    mount()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(assistant.voice).toBe('a')
    localStorage.clear()
  })
})

describe('table input (opt-in followTableInput)', () => {
  // Provenance: synthetic. A fake EventSource stands in for GET /api/puppet/input/events;
  // the event shape is the server's own PuppetInput (puppetInput.ts, covered by its test).
  const sources: FakeSource[] = []
  class FakeSource {
    onmessage: ((m: MessageEvent) => void) | null = null
    closed = false
    constructor(public url: string) { sources.push(this) }
    close() { this.closed = true }
    // A closed EventSource delivers nothing, like the real one.
    emit(input: object) { if (this.closed) return; this.onmessage?.({ data: JSON.stringify(input) } as MessageEvent) }
  }
  const input = (id: string, text: string) => ({ type: 'input', id, text, from: 'keyboard', at: 1 })
  function stub(turns: any[], gate?: Promise<void>) {
    class FakeAudio { play = vi.fn(async () => {}); pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn() }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('EventSource', FakeSource)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/turn')) {
        turns.push(JSON.parse(String(init!.body)))
        return new Response(new ReadableStream({ async start(c) { await gate; c.enqueue(new TextEncoder().encode('{"type":"done"}\n')); c.close() } }))
      }
      if (url === '/api/puppet/sessions') return Response.json({ id: 'conversation' })
      return new Response(null, { status: 204 })
    }))
  }
  afterEach(() => { sources.length = 0 })

  it('turns a table input into a normal typed turn with audio:true', async () => {
    // Break caught: SEND on the projected keyboard / pinch typing reaching the server and
    // the landing page ignoring it, so the puppet master never answers what was typed.
    const turns: any[] = []
    stub(turns)
    mount({ followTableInput: true })
    expect(sources.map(x => x.url)).toEqual(['/api/puppet/input/events'])
    await act(async () => { sources[0]!.emit(input('1', 'explain the last step')); await tick(30) })
    expect(turns).toEqual([{ text: 'explain the last step', audio: true }])
    expect(assistant.turns.filter(t => t.role === 'user').map(t => t.content)).toEqual(['explain the last step'])
  })

  it('does nothing without the flag: no stream is opened, so a turn never starts from another tab', async () => {
    // Break caught: every page using the hook (studio, operator) starting its own turn,
    // and speaking it, for one sentence typed on the table.
    const turns: any[] = []
    stub(turns)
    mount()
    await act(async () => { await tick(30) })
    expect(sources).toHaveLength(0)
    expect(turns).toEqual([])
  })

  it('drops an input while a turn runs, says so, and does not run it afterwards', async () => {
    // Break caught: a table input aborting the running turn, or queueing and replaying later.
    const turns: any[] = []
    let release!: () => void
    stub(turns, new Promise<void>(r => { release = r }))
    mount({ followTableInput: true })
    await act(async () => { sources[0]!.emit(input('1', 'first')); await tick() })
    await act(async () => { sources[0]!.emit(input('2', 'second')); await tick() })
    expect(assistant.notice).toMatch(/busy/)
    await act(async () => { release(); await tick(30) })
    expect(turns.map(t => t.text)).toEqual(['first'])
  })

  it('runs one input once even if the same id is delivered twice, and closes the stream on unmount', async () => {
    // Break caught: a reconnect re-delivering an input as a second spoken turn.
    const turns: any[] = []
    stub(turns)
    mount({ followTableInput: true })
    await act(async () => { sources[0]!.emit(input('1', 'hello')); await tick(30) })
    await act(async () => { sources[0]!.emit(input('1', 'hello')); await tick(30) })
    expect(turns).toHaveLength(1)
    for (const root of roots.splice(0)) act(() => root.unmount())
    expect(sources[0]!.closed).toBe(true)
  })

  it('stops following when superseded: closes the stream, says so, and ignores later inputs', async () => {
    // Break caught: the older of two `/` tabs keeps answering table input (two different
    // answers spoken on the TVs for one SEND), or reconnects and steals the conversation back.
    const turns: any[] = []
    stub(turns)
    mount({ followTableInput: true })
    await act(async () => { sources[0]!.emit({ type: 'superseded', at: 1 }); await tick(10) })
    expect(sources[0]!.closed).toBe(true)
    expect(assistant.notice).toMatch(/Another screen/)
    await act(async () => { sources[0]!.emit(input('9', 'late')); await tick(30) })
    expect(turns).toEqual([])
  })
})
