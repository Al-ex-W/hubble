import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createAlignmentAccumulator, parseTimestampStream, wordsFromAlignment, type Alignment } from './wordTiming.ts'

// Fixtures: RECORDINGS (2026-10-07) of ElevenLabs POST .../stream/with-timestamps, one entry per NDJSON
// line, audio stripped (fixtures/eleven-timestamps-2026-10-07/). Oracle: the text we sent, split by a
// plain regex, and the recorded end time of each word's last character; never wordsFromAlignment itself.
const load = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/eleven-timestamps-2026-10-07/${n}.json`, import.meta.url), 'utf8')) as
  { text: string; lines: { alignment: Alignment | null }[] }
const rec1 = load('probe1'), rec2 = load('probe2')

describe('word timings from a recorded alignment', () => {
  it('pins the corpus: 2 recordings, 5 and 6 lines, only two lines carry alignment', () => {
    // Break caught: the corpus shrinking silently.
    expect([rec1.lines.length, rec2.lines.length]).toEqual([5, 6])
    expect(rec1.lines.filter(l => l.alignment).length).toBe(2)
  })

  it('yields the sent text word for word, with times from the recording, across a chunk that splits "Hubble"', () => {
    // Break caught: building words per chunk ("Hubb" + "le" as two words), or taking times per chunk instead of absolute.
    const acc = createAlignmentAccumulator()
    for (const l of rec1.lines) acc.add(l.alignment)
    const words = acc.words(true)
    expect(words.map(w => w.w)).toEqual(rec1.text.split(/\s+/))
    const hubble = words.find(w => w.w === 'Hubble.')!
    // Oracle: recorded start of 'H' (0.755 s) and end of '.' in chunk 2 (1.185 s).
    expect([hubble.startMs, hubble.endMs]).toEqual([755, 1185])
    for (let i = 1; i < words.length; i++) expect(words[i].startMs).toBeGreaterThanOrEqual(words[i - 1].endMs - 1)
    expect(words.at(-1)!.endMs).toBe(2229)
  })

  it('does not report the trailing, possibly unfinished word until the stream is complete', () => {
    // Break caught: the TV flashing "Hubb" after the first chunk, then "Hubble."
    const acc = createAlignmentAccumulator()
    acc.add(rec1.lines[0].alignment)
    expect(acc.words(false).map(w => w.w)).toEqual(['Hi', 'there,', 'I', 'am'])
    expect(acc.words(true).map(w => w.w).at(-1)).toBe('Hubb')
  })

  it('keeps symbols and numbers as sent ($25), not the normalised spelling', () => {
    // Break caught: using normalized_alignment, whose text has extra spaces and need not equal what the bubble shows.
    const acc = createAlignmentAccumulator()
    for (const l of rec2.lines) acc.add(l.alignment)
    expect(acc.words(true).map(w => w.w)).toEqual(rec2.text.split(/\s+/))
  })

  it('ignores a null or garbled alignment', () => {
    expect(wordsFromAlignment({ characters: [], character_start_times_seconds: [], character_end_times_seconds: [] })).toEqual([])
    const acc = createAlignmentAccumulator(); acc.add(null); acc.add({} as any); expect(acc.words(true)).toEqual([])
  })
})

describe('parseTimestampStream', () => {
  it('rebuilds lines split at arbitrary byte boundaries and decodes the audio', async () => {
    // Break caught: a network read ending mid-line (JSON.parse throws, the say loses its timings).
    const lines = rec1.lines.map((l, i) => JSON.stringify({ audio_base64: Buffer.from(`mp3-${i}`).toString('base64'), alignment: l.alignment }))
    const bytes = new TextEncoder().encode(lines.join('\n') + '\n')
    async function* chunks() { for (let i = 0; i < bytes.length; i += 37) yield bytes.slice(i, i + 37) }
    const out: { audio?: Buffer; alignment?: Alignment }[] = []
    for await (const c of parseTimestampStream(chunks())) out.push(c)
    expect(out.map(c => c.audio?.toString())).toEqual(['mp3-0', 'mp3-1', 'mp3-2', 'mp3-3', 'mp3-4'])
    expect(out.filter(c => c.alignment).length).toBe(2)
  })

  it('throws on a non-JSON body so the caller can fall back to plain audio', async () => {
    async function* mp3() { yield new TextEncoder().encode('ID3\x03\x00') }
    await expect((async () => { for await (const _ of parseTimestampStream(mp3())) { /* drain */ } })()).rejects.toThrow()
  })
})
