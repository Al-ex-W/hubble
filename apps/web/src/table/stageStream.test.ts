import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The shared stage stream (stageStream.ts). Fixture: synthetic EventSource
 * (no browser here); the lines are the hub's own shapes (kind: surfaces /
 * overlay). The limit it protects is real: 7 established Chrome connections
 * to :5173 measured 2026-10-06, send and reload stuck behind them.
 */
class FakeSource {
  static all: FakeSource[] = []
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0
  closed = false
  constructor(readonly url: string) {
    FakeSource.all.push(this)
  }
  close() {
    this.closed = true
    this.readyState = 2
  }
  /** What a browser does when the server answers an HTTP error: give up for good. */
  fail() {
    this.readyState = 2
    this.onerror?.()
  }
  emit(line: unknown) {
    this.onmessage?.({ data: JSON.stringify(line) })
  }
}

beforeEach(() => {
  FakeSource.all = []
  vi.stubGlobal('EventSource', FakeSource)
  vi.resetModules()
})
afterEach(() => vi.unstubAllGlobals())

describe('the stage stream is one connection per page', () => {
  it('four hooks share one EventSource', async () => {
    const { subscribeStage } = await import('./stageStream.ts')
    const offs = [1, 2, 3, 4].map(() => subscribeStage({ line: () => {} }))
    // Break caught: one EventSource per hook, which used 4 of Chrome's 6
    // per-host connections and left send/MIDI queued for 90 s.
    expect(FakeSource.all).toHaveLength(1)
    offs.forEach((off) => off())
  })

  it('a hook that mounts late still gets the state the server replayed on connect', async () => {
    const { subscribeStage } = await import('./stageStream.ts')
    const early: unknown[] = []
    subscribeStage({ line: (l) => early.push(l) })
    const src = FakeSource.all[0]!
    src.onopen?.()
    src.emit({ kind: 'surfaces', rev: 1, surfaces: [] })
    src.emit({ kind: 'overlay', layer: 'lesson', shapes: [] })
    const late: unknown[] = []
    subscribeStage({ line: (l) => late.push(l) })
    // Break caught: sharing the connection but dropping the hub's replay, so
    // a panel mounted after the first never saw the table until it changed.
    expect(late).toEqual(early)
  })

  it('a late hook gets the replayed state but no touch lines (#89)', async () => {
    const { subscribeStage } = await import('./stageStream.ts')
    const early: { kind?: string }[] = []
    subscribeStage({ line: (l) => early.push(l) })
    const src = FakeSource.all[0]!
    src.onopen?.()
    src.emit({ kind: 'overlay', layer: 'lesson', shapes: [] })
    src.emit({ kind: 'touch', id: 1, phase: 'down', p: { x: 10, y: 10 } })
    const late: { kind?: string }[] = []
    subscribeStage({ line: (l) => late.push(l) })
    // Live subscribers still see the touch...
    expect(early.map((l) => l.kind)).toEqual(['overlay', 'touch'])
    // Break caught: buffering touch lines like state, so a ripple layer that
    // mounts late replays a burst of ripples at spots touched long ago.
    expect(late.map((l) => l.kind)).toEqual(['overlay'])
  })

  it('a reconnect starts the replay over and tells every hook', async () => {
    const { subscribeStage } = await import('./stageStream.ts')
    let opens = 0
    subscribeStage({ line: () => {}, open: () => opens++ })
    const src = FakeSource.all[0]!
    src.onopen?.()
    src.emit({ kind: 'surfaces', rev: 9, surfaces: [] })
    src.onopen?.() // the server restarted: it replays from rev 1
    src.emit({ kind: 'surfaces', rev: 1, surfaces: [] })
    const late: { rev?: unknown }[] = []
    subscribeStage({ line: (l) => late.push(l as { rev?: unknown }) })
    // Break caught: a late hook replayed the dead server's rev 9 after the
    // new rev 1, and refused the live set as "older".
    expect(opens).toBe(2)
    expect(late.map((l) => l.rev)).toEqual([1])
  })

  it('closes when the last hook leaves, and reopens for the next', async () => {
    const { subscribeStage } = await import('./stageStream.ts')
    const a = subscribeStage({ line: () => {} })
    const b = subscribeStage({ line: () => {} })
    a()
    expect(FakeSource.all[0]!.closed).toBe(false)
    b()
    // Break caught: a page that unmounted its panels still holding a slot.
    expect(FakeSource.all[0]!.closed).toBe(true)
    subscribeStage({ line: () => {} })
    expect(FakeSource.all).toHaveLength(2)
  })
})

describe('the stage stream survives a server restart', () => {
  it('reopens after the browser gives up (HTTP error), with a growing pause, and replays from scratch', async () => {
    // Break caught (audit 7 Oct, HIGH; the owner's "500" after a restart):
    // Vite answers 500 while the server restarts, the browser closes the
    // EventSource for good, and /table, the Show preview and the bench froze
    // until a reload.
    vi.useFakeTimers()
    try {
      const { subscribeStage } = await import('./stageStream.ts')
      let opens = 0
      const off = subscribeStage({ line: () => {}, open: () => opens++ })
      FakeSource.all[0]!.fail()
      expect(FakeSource.all).toHaveLength(1)
      vi.advanceTimersByTime(499)
      expect(FakeSource.all).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(FakeSource.all).toHaveLength(2) // reopened after 0.5 s
      FakeSource.all[1]!.fail()
      vi.advanceTimersByTime(999)
      expect(FakeSource.all).toHaveLength(2)
      vi.advanceTimersByTime(1)
      expect(FakeSource.all).toHaveLength(3) // then after 1 s: backing off
      FakeSource.all[2]!.onopen?.()
      expect(opens).toBe(1) // the new connection tells every hook to start over
      off()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a merely dropped connection to the browser, and never reopens once nobody listens', async () => {
    // Breaks caught: opening a SECOND connection while the browser is already
    // retrying (two EventSources = the 6-connection freeze again); and a
    // closed page section reviving a connection after it unsubscribed.
    vi.useFakeTimers()
    try {
      const { subscribeStage } = await import('./stageStream.ts')
      const off = subscribeStage({ line: () => {} })
      FakeSource.all[0]!.onerror?.() // readyState still CONNECTING: the browser retries itself
      vi.advanceTimersByTime(10_000)
      expect(FakeSource.all).toHaveLength(1)
      FakeSource.all[0]!.fail()
      off()
      vi.advanceTimersByTime(10_000)
      expect(FakeSource.all).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
