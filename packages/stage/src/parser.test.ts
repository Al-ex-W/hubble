import { describe, expect, it } from 'vitest'
import { CATALOG } from './catalog.ts'
import { createStageParser } from './parser.ts'
import type { StageEvent } from './protocol.ts'
import { listRecordings, loadRecording } from './testing.ts'

/**
 * Fixtures: packages/stage/fixtures/stage-streams/*.jsonl, recorded from aixia-labs with the
 * shipping prompt (label: recording). Cases marked "mutation" apply one
 * scripted change to a recording; no model output is typed by hand.
 *
 * Oracles come from the recording itself through independent regexes, never
 * from the parser.
 */

interface Recording {
  name: string
  deltas: string[]
  text: string
}

const loadRecordings = (): Recording[] => listRecordings().map(loadRecording)

const RECORDINGS = loadRecordings()

/**
 * Independent oracle for "the model closed every raw body": every <Math> and
 * <Equations> open tag has its own close tag. Recordings that fail this are
 * real model mistakes, kept as the most valuable fixtures we have.
 */
const RAW_TAGS = ['Math', 'Equations']
const wellFormed = (text: string) =>
  RAW_TAGS.every((t) => (text.match(new RegExp(`<${t}[\\s>]`, 'g')) ?? []).length === (text.match(new RegExp(`</${t}>`, 'g')) ?? []).length)
const CLEAN = RECORDINGS.filter((r) => wellFormed(r.text))

function run(chunks: string[], { finish = true } = {}): StageEvent[] {
  const parser = createStageParser()
  const events: StageEvent[] = []
  for (const c of chunks) events.push(...parser.push(c))
  if (finish) events.push(...parser.end())
  return events
}

const pieces = (events: StageEvent[], tag?: string) =>
  events.filter((e): e is Extract<StageEvent, { type: 'piece' }> => e.type === 'piece' && (!tag || e.tag === tag))

/** Independent oracle: every body of a raw (`whole`) tag, in order, from the full recorded text. */
const bodiesOf = (tag: string, text: string) => [...text.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1])
const mathBodies = (text: string) => bodiesOf('Math', text)

/** Every tag whose body is raw and shown only once closed: the ones a cut stream must never show in part. */
const WHOLE_TAGS = Object.entries(CATALOG)
  .filter(([, spec]) => spec.policy === 'whole')
  .map(([tag]) => tag)

/** Independent oracle: the words of every Text/Item, in order. */
const proseBodies = (text: string) =>
  [...text.matchAll(/<(Text|Item)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)].map((m) => m[2].replace(/\s+/g, ' ').trim())

/** Groups text events back into one string per words element. */
function proseFromEvents(events: StageEvent[]): string[] {
  const order: string[] = []
  const byId = new Map<string, string>()
  for (const e of events) {
    if (e.type === 'open' && (e.tag === 'Text' || e.tag === 'Item')) {
      order.push(e.id)
      byId.set(e.id, '')
    } else if (e.type === 'text') byId.set(e.id, (byId.get(e.id) ?? '') + e.text)
  }
  return order.map((id) => (byId.get(id) ?? '').replace(/\s+/g, ' ').trim())
}

describe('createStageParser over recorded streams', () => {
  it('reads the full recorded corpus', () => {
    // Pinned so a silently shrinking corpus fails loudly.
    expect(RECORDINGS.length).toBe(42)
    // And the malformed set is exactly the one recorded model mistake.
    expect(RECORDINGS.filter((r) => !wellFormed(r.text)).map((r) => r.name)).toEqual(['adv-limit'])
  })

  it.each(RECORDINGS.map((r) => [r.name, r] as const))(
    '%s: emits every Math exactly as recorded, never a fragment',
    (_name, rec) => {
      // Break caught: emitting Math on open, or before </Math> arrives, would
      // put partial TeX on the table. 147 recorded deltas end mid-Math.
      const got = pieces(run(rec.deltas), 'Math').map((p) => p.body)
      expect(got).toEqual(mathBodies(rec.text))
    },
  )

  it.each(RECORDINGS.map((r) => [r.name, r] as const))('%s: prose arrives as whole words, complete', (_name, rec) => {
    const events = run(rec.deltas)
    // Break caught: flushing a words element at a chunk edge shows "Subtr".
    // Exactly one word per event (a trailing space, or none for the last one):
    // "B C " as one event means words were held back and released together.
    for (const e of events) if (e.type === 'text') expect(e.text).toMatch(/^\S+ ?$/)
    expect(proseFromEvents(events)).toEqual(proseBodies(rec.text))
  })

  it.each(CLEAN.map((r) => [r.name, r] as const))('%s: ends complete, with nothing dropped', (_name, rec) => {
    const events = run(rec.deltas)
    // The corpus is 20/20 clean (census), so any drop here is a parser bug.
    expect(events.filter((e) => e.type === 'drop')).toEqual([])
    expect(events.at(-1)).toEqual({ type: 'end', reason: 'complete' })
  })

  it.each(RECORDINGS.map((r) => [r.name, r] as const))(
    '%s: the result does not depend on where the network splits chunks',
    (_name, rec) => {
      // Mechanical mutation: the same stream re-chunked one character at a
      // time. Break caught: any state that assumes a tag arrives in one delta.
      expect(run([...rec.text])).toEqual(run(rec.deltas))
    },
  )

  it.each(RECORDINGS.map((r) => [r.name, r] as const))(
    '%s: the result does not depend on chunks splitting a whitespace run',
    (_name, rec) => {
      // Mechanical mutation: double every space, then cut between the two, so
      // one delta ends in whitespace and the next one starts with it. Models
      // and proxies both emit deltas like that. Break caught: the second word
      // of the run stalled behind the leading space, then came out glued to
      // the following words, or not at all if the stream stopped.
      const text = rec.text.replace(/ /g, '  ')
      const chunks = text.split(/(?<= )(?= )/)
      expect(chunks.length).toBeGreaterThan(1)
      expect(run(chunks)).toEqual(run([text]))
      const cut = chunks.slice(0, Math.ceil(chunks.length / 2))
      expect(run(cut)).toEqual(run([cut.join('')]))
    },
  )

  it.each(RECORDINGS.map((r) => [r.name, r] as const))(
    '%s: a stream cut at any point never shows a partial piece',
    (_name, rec) => {
      // Mechanical mutation: truncate at every character. This is the stage
      // failure mode: the model or the network stops mid-answer.
      // Every raw tag, not only Math: a Heading or Button cut mid-body is the
      // same failure, a fragment of words projected as if it were finished.
      const full = new Map(WHOLE_TAGS.map((t) => [t, new Set(bodiesOf(t, rec.text))]))
      for (let cut = 0; cut < rec.text.length; cut++) {
        const events = run([rec.text.slice(0, cut)])
        for (const p of pieces(events)) if (p.body) expect(full.get(p.tag)?.has(p.body), `${p.tag} "${p.body}" at cut ${cut}`).toBe(true)
        // Every opened element is closed, so the renderer never waits forever.
        const opened = events.filter((e) => e.type === 'open').map((e) => (e as { id: string }).id)
        const closed = new Set(events.filter((e) => e.type === 'close').map((e) => (e as { id: string }).id))
        for (const id of opened) expect(closed.has(id)).toBe(true)
        expect(events.at(-1)?.type).toBe('end')
      }
    },
  )

  it('recovers from a raw body the model never closed (recorded adv-limit)', () => {
    const rec = RECORDINGS.find((r) => r.name === 'adv-limit')!
    const events = run(rec.deltas)
    // Break caught: without recovery the unclosed Equations swallows step 3,
    // the plot and the note, and the table shows half an answer.
    const drops = events.filter((e) => e.type === 'drop')
    expect(drops).toHaveLength(1)
    expect(drops[0]).toMatchObject({ reason: 'malformed' })
    expect(pieces(events, 'Plot')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'open' && e.tag === 'Note')).toHaveLength(1)
    expect(proseFromEvents(events)).toContain('Let u = 3x, u → 0.')
    expect(events.at(-1)).toEqual({ type: 'end', reason: 'complete' })
  })

  it('keeps a literal < inside Math (recorded inequality)', () => {
    const rec = RECORDINGS.find((r) => r.name === 'math-inequality')!
    expect(pieces(run(rec.deltas), 'Math').map((p) => p.body)).toEqual(['x - 7 < 4', 'x < 11'])
  })

  it('parses recorded attributes into typed values', () => {
    const plot = pieces(run(RECORDINGS.find((r) => r.name === 'adv-quadratic-graph')!.deltas), 'Plot')
    expect(plot[0].attrs).toEqual({ fn: 'x^2 - 5*x + 6', xmin: 0, xmax: 5, ymin: -1, ymax: 6, points: '2,0; 3,0', label: 'y = x² − 5x + 6' })
    const pause = pieces(run(RECORDINGS.find((r) => r.name === 'general-buttons')!.deltas), 'Pause')
    expect(pause[0].attrs).toEqual({ ms: 400 })
    const opens = run(RECORDINGS.find((r) => r.name === 'math-linear')!.deltas).filter((e) => e.type === 'open')
    // Bare `highlight` on the last step is a boolean true.
    expect(opens.filter((e) => e.type === 'open' && e.tag === 'Step').at(-1)).toMatchObject({ attrs: { highlight: true } })
  })

  it('links every element to an already-open parent', () => {
    for (const rec of RECORDINGS) {
      const open = new Set<string>()
      for (const e of run(rec.deltas)) {
        if ((e.type === 'open' || e.type === 'piece') && e.parent !== null) expect(open.has(e.parent)).toBe(true)
        if (e.type === 'open') open.add(e.id)
        if (e.type === 'close') open.delete(e.id)
      }
    }
  })
})

describe('createStageParser refuses what must never render (mutations of recordings)', () => {
  const base = RECORDINGS.find((r) => r.name === 'math-linear')!
  const baseMath = mathBodies(base.text)

  it('drops a markdown code fence around the answer and keeps the answer', () => {
    const events = run(['```jsx\n', ...base.deltas, '\n```'])
    expect(pieces(events, 'Math').map((p) => p.body)).toEqual(baseMath)
    expect(events.some((e) => e.type === 'drop' && e.reason === 'stray-text')).toBe(true)
    // Nothing from the fence leaks into any rendered text.
    for (const e of events) if (e.type === 'text') expect(e.text).not.toContain('`')
  })

  it('drops an unknown tag together with everything inside it', () => {
    const mutated = base.text.replace('<Steps>', '<table><tr><td><Math>9</Math></td></tr></table><Steps>')
    const events = run([mutated])
    expect(pieces(events, 'Math').map((p) => p.body)).toEqual(baseMath)
    expect(events).toContainEqual(expect.objectContaining({ type: 'drop', reason: 'unknown-tag' }))
  })

  it('skips a refused subtree whatever a quoted < inside it does to the chunking', () => {
    // Mutation: a nested refused tag whose attribute value holds a `<`. Read
    // whole, the quotes keep the `<` out of the tag syntax; cut right after
    // that `<` (or one character at a time), a quote-unaware skipper took the
    // `<` for a new tag, lost the nested open, ended the skip at the inner
    // close and projected the Math 9 that was meant to be hidden.
    const mutated = base.text.replace('<Steps>', '<table><table title="a<b">x</table><Math>9</Math></table><Steps>')
    const at = mutated.indexOf('a<') + 2
    for (const chunks of [[mutated], [mutated.slice(0, at), mutated.slice(at)], [...mutated]]) {
      const events = run(chunks)
      expect(pieces(events, 'Math').map((p) => p.body)).toEqual(baseMath)
      expect(events.at(-1)).toEqual({ type: 'end', reason: 'complete' })
    }
  })

  it('withholds a word split across a whitespace run when the stream stops', () => {
    // Mutation: the double space of the re-chunk case, then the stream stops
    // after the next word's trailing space. Break caught: that word was
    // already complete but stalled behind the leading space and was lost.
    const text = base.text.replace('Subtract 4x from both', 'Subtract  4x from both')
    const at = text.indexOf('Subtract ') + 'Subtract '.length
    const events = run([text.slice(0, at), text.slice(at, text.indexOf('from both'))])
    expect(proseFromEvents(events).at(-1)).toBe('Subtract 4x')
  })

  it('drops an element whose attribute is a JavaScript expression', () => {
    const rec = RECORDINGS.find((r) => r.name === 'general-buttons')!
    const events = run([rec.text.replace('ms={400}', 'ms={delay * 2}')])
    expect(events).toContainEqual(expect.objectContaining({ type: 'drop', reason: 'expression' }))
    // The first Pause is gone; the second (untouched) survives.
    expect(pieces(events, 'Pause').length).toBe(pieces(run(rec.deltas), 'Pause').length - 1)
  })

  it('drops a component placed where it is not allowed', () => {
    const events = run([base.text.replace('<Heading>', '<Item>stray</Item><Heading>')])
    expect(events).toContainEqual(expect.objectContaining({ type: 'drop', reason: 'not-allowed-here' }))
    expect(proseFromEvents(events)).not.toContain('stray')
  })

  it('drops an element missing a required attribute', () => {
    const rec = RECORDINGS.find((r) => r.name === 'adv-quadratic-graph')!
    const events = run([rec.text.replace(/fn="[^"]*"/, '')])
    expect(events).toContainEqual(expect.objectContaining({ type: 'drop', reason: 'bad-attribute' }))
  })

  it('discards an unfinished Math when the stream stops inside it', () => {
    const cut = base.text.indexOf('6x = 24') + 3 // inside the third Math body
    const events = run([base.text.slice(0, cut)])
    expect(pieces(events, 'Math').map((p) => p.body)).toEqual(baseMath.slice(0, 2))
    expect(events).toContainEqual(expect.objectContaining({ type: 'drop', reason: 'unfinished' }))
    expect(events.at(-1)).toEqual({ type: 'end', reason: 'truncated' })
  })

  it('keeps a literal < in prose and carries on parsing after it', () => {
    const rec = RECORDINGS.find((r) => r.name === 'recipe-soup')!
    const events = run([...rec.text.replace('Simmer gently for 1.5 hours.', 'Simmer gently for < 2 hours.')])
    // Break caught: reading "< " as the start of a tag stalls the parser and
    // silently loses the rest of the answer.
    expect(proseFromEvents(events)).toContain('Simmer gently for < 2 hours. Skim the foam.')
    expect(pieces(events, 'Heading').length).toBe(1)
    expect(events.at(-1)).toEqual({ type: 'end', reason: 'complete' })
  })

  it('keeps a > inside a quoted attribute value', () => {
    const rec = RECORDINGS.find((r) => r.name === 'math-inequality')!
    const mutated = rec.text.replace('<Steps>', '<Highlight target="task" label="x > 11 here"/><Steps>')
    const highlight = pieces(run([...mutated]), 'Highlight')
    expect(highlight[0].attrs).toEqual({ target: 'task', label: 'x > 11 here' })
  })

  it('withholds a word that was cut off when the stream stops mid-prose', () => {
    const cut = base.text.indexOf('Subtract 4x from both') + 'Subtract 4x from bo'.length
    const events = run([base.text.slice(0, cut)])
    // Break caught: flushing the tail on truncation would project "bo".
    expect(proseFromEvents(events).at(-1)).toBe('Subtract 4x from')
  })

  it('implicitly closes prose when the model opens a sibling without closing it', () => {
    const events = run([base.text.replace('Expand the parentheses.</Text>', 'Expand the parentheses.')])
    // Break caught: treating "<Math>" inside Text as literal would project raw markup.
    expect(pieces(events, 'Math').map((p) => p.body)).toEqual(baseMath)
    for (const e of events) if (e.type === 'text') expect(e.text).not.toContain('<')
  })
})
