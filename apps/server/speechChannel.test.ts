import { describe, expect, it } from 'vitest'
import type { Response } from 'express'
import { createSpeechChannel } from './speechChannel.ts'

// Provenance: synthetic. A fake Response records the SSE wire text; the oracle is the parsed `data:` lines.
function fakeClient() {
  const written: string[] = []
  const res = { writeHead() {}, write: (t: string) => { written.push(t); return true }, writableLength: 0, on() {}, destroy() {} } as unknown as Response
  return { res, lines: () => written.filter(t => t.startsWith('data: ')).map(t => JSON.parse(t.slice(6))) }
}
const words = [{ w: 'Hi', startMs: 0, endMs: 100 }]

describe('speech channel: playing gate and words', () => {
  it('publishes nothing but speech before `playing`, and flushes the held timings at it', () => {
    // Break caught: words published against the speech event's time, so the TV runs ahead of the voice by the TTS start-up.
    let t = 1000
    const ch = createSpeechChannel({ now: () => t }); const c = fakeClient(); ch.subscribe(c.res)
    const tl = ch.timeline('a')
    tl.addWords(words, false); t = 1200
    expect(c.lines()).toEqual([])
    t = 1500; tl.playing()
    expect(c.lines()).toEqual([
      { type: 'playing', id: 'a', startedAt: 1500, at: 1500 },
      { type: 'words', id: 'a', words, startedAt: 1500, done: false, at: 1500 },
    ])
    t = 1600; tl.addWords([...words, { w: 'there', startMs: 120, endMs: 300 }], true)
    expect(c.lines().at(-1)).toMatchObject({ type: 'words', done: true, startedAt: 1500, at: 1600 })
  })

  it('only the first `playing` counts (a stall/resume fires it again)', () => {
    // Break caught: the start moving mid-line, so the TV's reveal jumps backwards.
    let t = 1
    const ch = createSpeechChannel({ now: () => t }); const c = fakeClient(); ch.subscribe(c.res)
    const tl = ch.timeline('a'); tl.playing(); t = 99; tl.playing()
    expect(c.lines()).toHaveLength(1)
  })

  it('never replays words, playing or level, and tags replayed speech so a display shows it as history', () => {
    // Break caught: a reconnecting TV re-running a long-finished reveal, or popping a bubble for an old line.
    const ch = createSpeechChannel({ now: () => 5 })
    ch.publish({ type: 'speech', id: 'a', text: 'Old line' })
    const tl = ch.timeline('a'); tl.playing(); tl.addWords(words, true); ch.level({ level: 0.5, at: 5 })
    const late = fakeClient(); ch.subscribe(late.res)
    expect(late.lines()).toEqual([{ type: 'speech', id: 'a', text: 'Old line', at: 5, replay: true }])
  })
})

describe('speech channel: level', () => {
  it('forwards at most one frame per 50 ms of frame time but always the drop to silence', () => {
    // Break caught: a 100 ms batch of 5 frames flooding the SSE, or the orb staying lit because the final 0 was throttled away.
    const ch = createSpeechChannel(); const c = fakeClient(); ch.subscribe(c.res)
    for (const [level, at] of [[0.2, 1000], [0.3, 1010], [0.4, 1049], [0.5, 1050], [0, 1060]] as const) ch.level({ level, at })
    expect(c.lines().map(l => [l.level, l.at])).toEqual([[0.2, 1000], [0.5, 1050], [0, 1060]])
    expect(c.lines().every(l => l.type === 'level')).toBe(true)
  })
})
