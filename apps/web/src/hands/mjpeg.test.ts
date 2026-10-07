import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createMjpegParser } from './mjpeg.ts'

/*
 * Fixture: fixtures/room-mjpeg-3.bin, a RECORDING of the real room camera
 * stream (pi-projector /camera/stream, 2026-10-06 15:02Z, the first three
 * multipart parts as they came off the wire). The oracle is independent of the
 * parser: each part's bytes are cut with Python's own reading of the
 * Content-Length headers when the fixture was saved, re-derived here with a
 * plain regex over the headers.
 */
const REC = new Uint8Array(readFileSync(new URL('./fixtures/room-mjpeg-3.bin', import.meta.url)))
const lengths = [...Buffer.from(REC).toString('latin1').matchAll(/Content-Length: (\d+)\r\n\r\n/g)].map((m) => Number(m[1]))

describe('MJPEG parts from the room camera', () => {
  it('has the recorded parts', () => {
    expect(lengths).toHaveLength(3) // corpus pin
  })

  it('cuts every recorded part into one whole JPEG', () => {
    const got: Uint8Array[] = []
    createMjpegParser((f) => got.push(f)).push(REC)
    // Break caught: frames merged, split, or with header bytes left on.
    expect(got.map((f) => f.length)).toEqual(lengths)
    for (const f of got) {
      expect([f[0], f[1]]).toEqual([0xff, 0xd8])
      expect([f.at(-2), f.at(-1)]).toEqual([0xff, 0xd9])
    }
  })

  it('MUTATION (re-chunked at every 997 bytes, and one byte at a time at the joins): same frames', () => {
    const whole: Uint8Array[] = []
    createMjpegParser((f) => whole.push(f)).push(REC)
    const got: Uint8Array[] = []
    const p = createMjpegParser((f) => got.push(f))
    let i = 0
    while (i < REC.length) {
      // A network read splits anywhere, including inside "\r\n\r\n".
      const step = i % 3 === 0 ? 1 : 997
      p.push(REC.subarray(i, i + step))
      i += step
    }
    // Break caught: a header or a body cut across two chunks lost or doubled.
    expect(got.map((f) => Buffer.from(f).toString('base64'))).toEqual(whole.map((f) => Buffer.from(f).toString('base64')))
  })

  it('holds a frame until all of it has arrived', () => {
    const got: Uint8Array[] = []
    const p = createMjpegParser((f) => got.push(f))
    // Just past the first body, partway into the second part.
    const firstEnd = Buffer.from(REC).indexOf('\r\n\r\n') + 4 + lengths[0]! + 40 + lengths[1]! / 2
    p.push(REC.subarray(0, firstEnd))
    expect(got).toHaveLength(1) // only the first part is complete
    // Break caught: a half-received frame handed on (a torn picture to MediaPipe).
    expect(got[0]!.length).toBe(lengths[0])
  })
})
