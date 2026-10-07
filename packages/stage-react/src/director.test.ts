import { describe, expect, it } from 'vitest'
import { createStageParser, type StageEvent } from '@hubble/stage'
import { listRecordings, loadRecording } from '@hubble/stage/testing'
import { createDirector } from './director.ts'

/**
 * Fixtures: the recorded aixia-labs streams (label: recording), parsed with
 * the real parser and fed to the director at their recorded arrival times.
 */
interface Timed {
  t: number
  events: StageEvent[]
}

function recordedEvents(name: string): Timed[] {
  const rec = loadRecording(name)
  const parser = createStageParser()
  const out: Timed[] = []
  rec.payloads.forEach((data, i) => {
    if (data === '[DONE]') return
    const delta = JSON.parse(data).choices?.[0]?.delta?.content
    if (delta) out.push({ t: rec.times[i], events: parser.push(delta) })
  })
  out.push({ t: rec.times.at(-1) ?? 0, events: parser.end() })
  return out
}

const NAMES = listRecordings()

/** Every scheduled unit in arrival order, with its arrival and reveal time. */
function units(timed: Timed[], speed = 1) {
  const director = createDirector({ speed })
  const seen: { key: string; arrival: number; revealAt: number }[] = []
  for (const { t, events } of timed) {
    director.push(events, t)
    for (const e of events) {
      if (e.type === 'open' || (e.type === 'piece' && e.tag !== 'Pause')) {
        seen.push({ key: e.id, arrival: t, revealAt: director.state.nodes.get(e.id)!.revealAt })
      } else if (e.type === 'text') {
        const words = director.state.nodes.get(e.id)!.words
        seen.push({ key: `${e.id}:${words.length}`, arrival: t, revealAt: words.at(-1)!.revealAt })
      }
    }
  }
  return { director, seen }
}

describe('createDirector over recorded streams', () => {
  it.each(NAMES)('%s: reveals in the order the model wrote, never before arrival', (name) => {
    const { seen } = units(recordedEvents(name))
    // Break caught: a reorder would show step 3 before step 2; an early reveal
    // would show something that has not been received yet.
    for (let i = 0; i < seen.length; i++) {
      expect(seen[i].revealAt).toBeGreaterThanOrEqual(seen[i].arrival)
      if (i > 0) expect(seen[i].revealAt).toBeGreaterThanOrEqual(seen[i - 1].revealAt)
    }
  })

  it.each(NAMES)('%s: spreads the burst into a readable sequence', (name) => {
    const timed = recordedEvents(name)
    const arrivedBy = timed.at(-1)!.t
    const { director } = units(timed)
    // Every recording arrives in under 1.4 s. Break caught: revealing at
    // arrival time would flash the whole answer in about a second.
    expect(director.state.settlesAt).toBeGreaterThan(arrivedBy + 1500)
  })

  it('holds back what follows a recorded Pause by at least its length', () => {
    const timed = recordedEvents('general-buttons')
    const { director } = units(timed)
    const items = [...director.state.nodes.values()].filter((n) => n.tag === 'Item')
    // The recording writes <Pause ms={400}/> between consecutive Items.
    expect(items[1].words[0].revealAt - items[0].words.at(-1)!.revealAt).toBeGreaterThanOrEqual(400)
  })

  it('scales the whole timeline with speed', () => {
    const timed = recordedEvents('math-linear').map((x) => ({ ...x, t: 0 }))
    const normal = units(timed, 1).director.state.settlesAt
    const slow = units(timed, 0.25).director.state.settlesAt
    expect(slow).toBeCloseTo(normal * 4, 5)
  })
})
