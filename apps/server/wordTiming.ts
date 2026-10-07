/**
 * Word timings from ElevenLabs' `stream/with-timestamps` response.
 *
 * RECORDED SHAPE (docs/plans/2026-10-07-tv-voice.md, Evidence): the response is
 * NDJSON, one JSON object per line, each with `audio_base64` (an mp3 slice)
 * and `alignment` / `normalized_alignment`: parallel arrays `characters`,
 * `character_start_times_seconds`, `character_end_times_seconds`. Three facts
 * from the recording decide this module:
 *  1. Times are ABSOLUTE from the start of the audio, not per chunk.
 *  2. Many lines carry `alignment: null` (audio only), and an alignment chunk
 *     can end MID-WORD ("Hubb" | "le"): words must be built over all chunks
 *     so far, and the trailing run is not a finished word until whitespace or
 *     the end of the stream.
 *  3. `alignment.characters` joins back to the text we sent exactly (so the
 *     words match the speech bubble's text); `normalized_alignment` has extra
 *     spaces. We use `alignment`.
 */
export interface Alignment {
  characters: string[]
  character_start_times_seconds: number[]
  character_end_times_seconds: number[]
}
export interface TimedWord { w: string; startMs: number; endMs: number }
export interface TimedChunk { audio?: Buffer; alignment?: Alignment }

const isSpace = (c: string) => /^\s$/.test(c)

/** Whitespace-separated words over a (possibly growing) alignment. `complete`
 * false drops a trailing run that is not yet followed by whitespace. */
export function wordsFromAlignment(a: Alignment, complete = true): TimedWord[] {
  const words: TimedWord[] = []
  let w = '', start = 0, end = 0, open = false
  const n = Math.min(a.characters.length, a.character_start_times_seconds.length, a.character_end_times_seconds.length)
  for (let i = 0; i < n; i++) {
    const c = a.characters[i]
    if (isSpace(c)) {
      if (open) { words.push({ w, startMs: start, endMs: end }); w = ''; open = false }
      continue
    }
    if (!open) { start = Math.round(a.character_start_times_seconds[i] * 1000); open = true }
    w += c
    end = Math.round(a.character_end_times_seconds[i] * 1000)
  }
  if (open && complete) words.push({ w, startMs: start, endMs: end })
  return words
}

/** Joins alignment chunks (null ones skipped) into one growing alignment. */
export function createAlignmentAccumulator() {
  const all: Alignment = { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] }
  return {
    add(a: Alignment | null | undefined) {
      if (!a || !Array.isArray(a.characters)) return
      all.characters.push(...a.characters)
      all.character_start_times_seconds.push(...a.character_start_times_seconds)
      all.character_end_times_seconds.push(...a.character_end_times_seconds)
    },
    words: (complete: boolean) => wordsFromAlignment(all, complete),
  }
}

/** Parses the NDJSON body into audio + alignment chunks. A network read can
 * split a line anywhere, so lines are buffered until their newline. A line
 * that is not JSON throws: the caller treats that as "timings unavailable". */
export async function* parseTimestampStream(body: AsyncIterable<Uint8Array>): AsyncGenerator<TimedChunk> {
  const decoder = new TextDecoder()
  let buffer = ''
  const parse = (line: string): TimedChunk => {
    const j = JSON.parse(line) as { audio_base64?: unknown; alignment?: Alignment | null }
    return {
      audio: typeof j.audio_base64 === 'string' && j.audio_base64 ? Buffer.from(j.audio_base64, 'base64') : undefined,
      alignment: j.alignment ?? undefined,
    }
  }
  for await (const part of body) {
    buffer += decoder.decode(part, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1)
      if (line) yield parse(line)
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) yield parse(buffer.trim())
}
