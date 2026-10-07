import { describe, expect, it } from 'vitest'
import { readNdjson } from './ndjson.ts'

// Provenance: MECHANICAL MUTATION of a synthetic two-event NDJSON body, re-chunked
// at every byte offset (the same technique the stage parser tests use).
const body = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(c) { chunks.forEach(x => c.enqueue(x)); c.close() } })
const bytes = new TextEncoder().encode('{"type":"text","delta":"é"}\n{"type":"done"}\n')

describe('readNdjson', () => {
  it('yields the same events however the bytes are chunked, including inside a UTF-8 character', async () => {
    // Break caught: parsing per chunk instead of per line (JSON.parse of half an object).
    for (let cut = 1; cut < bytes.length; cut++) {
      const out: unknown[] = []
      for await (const e of readNdjson<{ type: string }>(body([bytes.slice(0, cut), bytes.slice(cut)]), e => e.type === 'done')) out.push(e)
      expect(out).toEqual([{ type: 'text', delta: 'é' }, { type: 'done' }])
    }
  })

  it('stops at the terminal event even if the stream stays open', async () => {
    // Break caught: waiting for stream close, hanging the Run button forever when
    // the server forgets to end the response.
    const open = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes) } })
    const out: unknown[] = []
    for await (const e of readNdjson<{ type: string }>(open, e => e.type === 'done')) out.push(e)
    expect(out).toHaveLength(2)
  })
})
