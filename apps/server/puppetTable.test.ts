import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { createPuppetAgent } from './puppetMaster.ts'
import { createPuppetTable, type PuppetTable, type TableSnapshot } from './puppetTable.ts'
import { createStudioStore } from './studio.ts'
import { createWebRoutes } from './webRoutes.ts'
import { createSurfaceManager } from './surfaces.ts'

// Provenance: schema-derived Vercel tool-call responses (as in puppetMaster.test.ts)
// and synthetic adapters. The adapter's operations are asserted against the
// surface manager's own state, an oracle independent of the tool code.
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }
const result = (content: any[], reason = 'stop') => ({ content, finishReason: { unified: reason, raw: reason }, usage, warnings: [] })
const call = (name: string, input: unknown, id = name) => ({ type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) })

const snapshot: TableSnapshot = { act: 'math', mode: 'idle', lesson: null, keyboardOpen: false, surfaces: [], assets: [], songs: ['ode-to-joy'], webAllow: ['en.wikipedia.org'], brain: true }
function fakeTable(log: string[], over: Partial<PuppetTable> = {}): PuppetTable {
  return {
    inspect: () => (log.push('inspect'), snapshot),
    showAnswer: async (intent) => (log.push(`answer:${intent}`), { answer: 'x = 2' }),
    setAct: (a, song) => void log.push(`act:${a}:${song ?? ''}`),
    openAsset: (id) => (log.push(`asset:${id}`), { surface: `asset-${id}` }),
    openWeb: async (url) => (log.push(`web:${url}`), { surface: 'web-1' }),
    drawSvg: () => (log.push('draw'), { surface: 'drawing-1' }),
    moveSurface: (id, dx, dy) => (log.push(`move:${id}:${dx}:${dy}`), true),
    raiseSurface: (id) => void log.push(`raise:${id}`),
    closeSurface: (id) => void log.push(`close:${id}`),
    openKeyboard: () => void log.push('kb-open'),
    closeKeyboard: () => void log.push('kb-close'),
    startLesson: (s) => void log.push(`lesson:${s}`),
    stopLesson: () => void log.push('lesson-stop'),
    clearTable: () => void log.push('clear'),
    ...over,
  }
}
const agentWith = (model: MockLanguageModelV4, table?: PuppetTable, speak: (t: string) => Promise<void> = async () => {}) =>
  createPuppetAgent({ model, store: createStudioStore(), signal: new AbortController().signal, emit: () => {}, speak, table })

describe('table tools through the agent', () => {
  it('are absent without an adapter and present with one', () => {
    // Break caught: the studio-only server advertising tools that have no table behind them.
    const names = (a: ReturnType<typeof agentWith>) => Object.keys(a.tools)
    const bare = names(agentWith(new MockLanguageModelV4()))
    const full = names(agentWith(new MockLanguageModelV4(), fakeTable([])))
    for (const n of ['inspect_table', 'show_answer', 'open_asset', 'open_web', 'draw_svg', 'move_surface', 'raise_surface', 'close_surface', 'open_keyboard', 'close_keyboard', 'set_act', 'start_lesson', 'stop_lesson', 'clear_table']) {
      expect(bare).not.toContain(n)
      expect(full).toContain(n)
    }
  })

  it('call the adapter, in the model\'s order, after the preceding say has finished playing', async () => {
    // Break caught: a table change (the answer appearing) before the person has
    // heard "let me show you", or calls reordered by parallel execution.
    const log: string[] = []
    let finish!: () => void
    const model = new MockLanguageModelV4({ doGenerate: [
      result([call('say', { text: 'Look.' }, 'a'), call('show_answer', { intent: 'Solve 2x=4' }, 'b'), call('open_asset', { id: 'a1' }, 'c'), call('move_surface', { id: 'answer', dx: 10, dy: -5 }, 'd'), call('open_keyboard', {}, 'e'), call('start_lesson', { song: 'ode-to-joy' }, 'f'), call('clear_table', {}, 'g')], 'tool-calls') as any,
      result([]) as any,
    ] })
    const pending = agentWith(model, fakeTable(log), () => (log.push('say'), new Promise<void>(r => { finish = r }))).generate({ prompt: 'go' })
    await new Promise(r => setTimeout(r, 30))
    expect(log).toEqual(['say'])
    finish()
    await pending
    expect(log).toEqual(['say', 'answer:Solve 2x=4', 'asset:a1', 'move:answer:10:-5', 'kb-open', 'lesson:ode-to-joy', 'clear'])
  })

  it('surface a show_answer failure as a tool error and let the turn continue', async () => {
    // Break caught: an unavailable brain throws out of the loop (the person
    // hears nothing) instead of reaching the model, which must then say so.
    const log: string[] = []
    const model = new MockLanguageModelV4({ doGenerate: [
      result([call('show_answer', { intent: 'Graph it' })], 'tool-calls') as any,
      result([call('say', { text: 'The table cannot answer right now.' })], 'tool-calls') as any,
      result([]) as any,
    ] })
    const table = fakeTable(log, { showAnswer: async () => { throw new Error('The table brain is not configured') } })
    await agentWith(model, table, async (t) => void log.push(`said:${t}`)).generate({ prompt: 'graph' })
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('The table brain is not configured')
    expect(log).toEqual(['said:The table cannot answer right now.'])
  })
})

describe('createPuppetTable', () => {
  // A runtime with only the parts the adapter touches: the real surface
  // manager (the oracle for "what is on the table") and counters for the rest.
  function setup(over: { webOpen?: (url: string) => Promise<{ id: string } | { status: number; error: string }>; ask?: any; setAct?: any } = {}) {
    const lines: unknown[] = []
    const surfaces = createSurfaceManager({ publish: (l) => void lines.push(l) })
    const calls: string[] = []
    const runtime = {
      surfaces,
      keyboard: { open: () => void calls.push('kb-open'), close: () => void calls.push('kb-close'), state: () => null },
      state: () => ({ act: 'math', mode: 'idle', lesson: null }),
      startLesson: (s: string) => void calls.push(`start:${s}`),
      stopLesson: () => void calls.push('stop'),
      tableCleared: () => void calls.push('cleared'),
    } as any
    const library = { list: () => [{ id: 'pic', kind: 'image', title: 'A picture', aspect: 1, url: '/u' }], get: (id: string) => (id === 'pic' ? { id: 'pic', kind: 'image', title: 'A picture', aspect: 1, url: '/u', widthMm: 100, heightMm: 100, file: '/f', type: 'image/png' } : undefined), path: () => undefined } as any
    let dismissed = 0
    const table = createPuppetTable({ runtime, dismiss: () => void dismissed++, library, webAllow: ['en.wikipedia.org'], openWeb: over.webOpen ?? (async () => ({ status: 403, error: 'host not allowed' })), ask: over.ask, setAct: over.setAct ?? (() => ({ status: 200 })) })
    return { table, surfaces, calls, dismissed: () => dismissed }
  }

  it('opens a library asset as the route does, and refuses an unknown id naming the choices', () => {
    // Break caught: an invented asset id opening something, or a model-supplied path reaching the file system.
    const { table, surfaces } = setup()
    expect(table.openAsset('pic')).toEqual({ surface: 'asset-pic' })
    expect(surfaces.list().map(s => s.id)).toEqual(['asset-pic'])
    expect(() => table.openAsset('../etc/passwd')).toThrow(/pic/)
  })

  it('validates surface ids, existence and move size with the route\'s rules', () => {
    // Break caught: moving or closing something that is not there appears to succeed; an absurd move reaches the manager.
    const { table, surfaces } = setup()
    table.openAsset('pic')
    expect(() => table.closeSurface('no such!')).toThrow(/not a surface id/)
    expect(() => table.raiseSurface('ghost')).toThrow(/no surface/)
    expect(() => table.moveSurface('asset-pic', 99_999, 0)).toThrow(/at most/)
    expect(() => table.moveSurface('asset-pic', NaN, 0)).toThrow()
    const before = surfaces.list()[0].box.x
    table.moveSurface('asset-pic', 40, 0)
    expect(surfaces.list()[0].box.x).toBe(before + 40)
    table.closeSurface('asset-pic')
    expect(surfaces.list()).toHaveLength(0)
  })

  it('clears the table through the operator\'s own path, and starts a lesson only for a known song', () => {
    // Break caught: 'constructor' (review #40) or a typo clearing the table before the song is refused.
    const { table, surfaces, calls, dismissed } = setup()
    table.openAsset('pic')
    expect(() => table.startLesson('constructor')).toThrow(/ode-to-joy/)
    expect(surfaces.list()).toHaveLength(1)
    expect(calls).toEqual([])
    table.startLesson('ode-to-joy')
    expect(surfaces.list()).toHaveLength(0)
    expect(calls).toEqual(['cleared', 'start:ode-to-joy'])
    expect(dismissed()).toBe(1) // no answer surface was open, so the hub is dismissed like the operator does
  })

  it('refuses a non-allow-listed host through the real web route\'s verdict, and opens an allowed one', async () => {
    // Break caught: open_web becoming a way around the allow-list (the model is
    // as untrusted as any page on the room network).
    const opened: string[] = []
    const host = { ids: () => [], open: async (_id: string, url: string) => void opened.push(url) } as any
    const { table, surfaces } = setup()
    const routes = createWebRoutes(host, ['en.wikipedia.org'])
    routes.mount({ post() {}, get() {} } as any, surfaces)
    const real = createPuppetTable({ ...(table as any), runtime: { surfaces } as any, dismiss() {}, library: { list: () => [] } as any, webAllow: ['en.wikipedia.org'], openWeb: (u) => routes.open(u), setAct: () => ({ status: 200 }) })
    await expect(real.openWeb('https://evil.example/')).rejects.toThrow(/not allowed/)
    await expect(real.openWeb('https://en.wikipedia.org.evil.example/')).rejects.toThrow(/not allowed/)
    expect(opened).toEqual([])
    expect(surfaces.list()).toHaveLength(0)
    expect(await real.openWeb('https://en.wikipedia.org/wiki/Pi')).toEqual({ surface: 'web-1' })
    expect(opened).toEqual(['https://en.wikipedia.org/wiki/Pi'])
  })

  it('draw_svg goes through the table agent\'s check: a script is refused with the reason, a clean drawing opens', () => {
    // Break caught: the puppet master's draw_svg as a way around the check
    // the table agent's tool and POST /api/surfaces/drawing use.
    const { table, surfaces } = setup()
    const real = createPuppetTable({ ...(table as any), runtime: { surfaces } as any, dismiss() {}, library: { list: () => [] } as any, webAllow: [], openWeb: async () => ({ id: 'x' }), setAct: () => ({ status: 200 }) })
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" stroke="#ff0" fill="none"/></svg>'
    expect(() => real.drawSvg({ svg: svg.replace('</svg>', '<script>x()</script></svg>'), widthMm: 100, heightMm: 100 })).toThrow(/refused.*<script>/)
    expect(surfaces.list()).toHaveLength(0)
    expect(real.drawSvg({ svg, widthMm: 100, heightMm: 100 })).toEqual({ surface: 'drawing-1' })
  })

  it('reports an unavailable brain, a failed render and a thrown render as errors the model can read', async () => {
    // Break caught: show_answer claiming success (or crashing the turn) when
    // the brain is missing, superseded, or throws.
    const ctl = new AbortController().signal
    await expect(setup().table.showAnswer('x', ctl)).rejects.toThrow(/not configured/)
    await expect(setup({ ask: async () => ({ ok: false, error: 'superseded by a newer request' }) }).table.showAnswer('x', ctl)).rejects.toThrow(/superseded/)
    await expect(setup({ ask: async () => { throw new Error('boom') } }).table.showAnswer('x', ctl)).rejects.toThrow(/boom/)
    expect(await setup({ ask: async () => ({ ok: true, answer: 'x=2' }) }).table.showAnswer('x', ctl)).toEqual({ answer: 'x=2' })
  })
})

describe('show_answer conversation context (parity with Julius render_answer)', () => {
  // Provenance: synthetic; the fake table records exactly what the tool handed it.
  const run = async (model: MockLanguageModelV4, table: PuppetTable, turn: any) => {
    const agent = createPuppetAgent({ model, store: createStudioStore(), signal: new AbortController().signal, emit: () => {}, speak: async () => {}, table, tableTurn: turn })
    await agent.generate({ prompt: 'go' })
  }
  const twice = () => new MockLanguageModelV4({ doGenerate: [
    result([call('show_answer', { intent: 'Solve 2x=4' }, 'a'), call('show_answer', { intent: 'Explain the last step' }, 'b')], 'tool-calls') as any,
    result([]) as any,
  ] })

  it('passes the earlier answers as history, then grows it, and hands over the turn\'s scene and image', async () => {
    // Break caught: "explain the last step" reaching the brain with no earlier answer (history dropped
    // or not recorded), or the notebook photo / scene of the turn never reaching the brain.
    const seen: any[] = []
    const table = fakeTable([], { showAnswer: async (intent, _s, ctx) => (seen.push({ intent, ctx }), { answer: `A(${intent})` }) })
    const turn = { history: [{ intent: 'earlier', answer: 'A0' }], image: 'data:image/png;base64,AA', scene: { surface: { widthPx: 1, heightPx: 1, mmPerPx: 1 }, objects: [] } }
    await run(twice(), table, turn)
    expect(seen[0].ctx).toEqual({ history: [{ intent: 'earlier', answer: 'A0' }], image: turn.image, scene: turn.scene })
    expect(seen[1].ctx.history).toEqual([{ intent: 'earlier', answer: 'A0' }, { intent: 'Solve 2x=4', answer: 'A(Solve 2x=4)' }])
    expect(turn.history).toHaveLength(3) // the session's array grew in place
  })

  it('records nothing for a failed render and caps the history at 6', async () => {
    // Break caught: a failed render becoming "the last answer" (a follow-up asks about nothing),
    // or an unbounded history inflating every brain request.
    const failing = fakeTable([], { showAnswer: async () => { throw new Error('no') } })
    const turn: any = { history: [] }
    await run(twice(), failing, turn)
    expect(turn.history).toEqual([])
    const full: any = { history: Array.from({ length: 6 }, (_, i) => ({ intent: `q${i}`, answer: `a${i}` })) }
    await run(twice(), fakeTable([]), full)
    expect(full.history).toHaveLength(6)
    expect(full.history.at(-1).intent).toBe('Explain the last step')
  })

  it('set_act goes through the one act switch and a refusal reaches the model as an error', () => {
    // Break caught: set_act succeeding silently when operator.setAct refused (unknown song).
    const acts: unknown[][] = []
    const ok = createPuppetTable({ runtime: {} as any, dismiss() {}, library: { list: () => [] } as any, webAllow: [], openWeb: async () => ({ id: 'x' }), setAct: (...a) => (acts.push(a), { status: 200 }) })
    ok.setAct('lesson', 'ode-to-joy')
    expect(acts).toEqual([['lesson', 'ode-to-joy']])
    const refused = createPuppetTable({ runtime: {} as any, dismiss() {}, library: { list: () => [] } as any, webAllow: [], openWeb: async () => ({ id: 'x' }), setAct: () => ({ status: 404, error: 'unknown song' }) })
    expect(() => refused.setAct('lesson', 'nope')).toThrow(/unknown song/)
  })
})
