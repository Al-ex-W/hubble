/**
 * Splits the room camera's MJPEG stream into whole JPEG frames.
 *
 * ONE parser for both sides (#84): the browser's hand tracker reads the same
 * stream our server's camera manager does, and a second copy would drift —
 * a header spelling, a length rule, an end-marker scan — until one side cuts
 * a frame the other half and MediaPipe sees a torn picture with no error
 * anywhere. It lives in apps/shared/ rather than packages/room because the
 * browser cannot import @hubble/room (node:http, ws and jpeg-js would be
 * bundled into the page); apps/shared/ already owns the cross-boundary crop
 * rule (roi.ts), so the camera's stream format belongs beside it.
 *
 * Shaped by a recording of the real stream (pi-projector /camera/stream,
 * 2026-10-06, apps/web/src/hands/fixtures/room-mjpeg-3.bin):
 * multipart/x-mixed-replace with boundary `frame`, and every part carries
 * `Content-Length`. So frames are cut by that length, not by scanning for the
 * JPEG end marker: FF D9 can appear inside an embedded thumbnail, and a scan
 * would cut such a frame in half.
 *
 * Chunks arrive at arbitrary byte offsets (a fetch reader splits wherever the
 * network did), so the parser keeps whatever is incomplete and waits.
 */
const HEADER_END = [13, 10, 13, 10]
// A header longer than this means we are not looking at a part header (lost
// sync); drop it rather than buffering a whole stream looking for one.
const MAX_HEADER = 4096

export function createMjpegParser(onFrame: (jpeg: Uint8Array) => void) {
  let buf = new Uint8Array(0)
  let need = -1 // body bytes still expected for the current part, or -1 while reading a header

  const indexOf = (seq: number[], from: number) => {
    outer: for (let i = from; i <= buf.length - seq.length; i++) {
      for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer
      return i
    }
    return -1
  }

  return {
    push(chunk: Uint8Array) {
      const next = new Uint8Array(buf.length + chunk.length)
      next.set(buf)
      next.set(chunk, buf.length)
      buf = next
      for (;;) {
        if (need < 0) {
          const end = indexOf(HEADER_END, 0)
          if (end < 0) {
            if (buf.length > MAX_HEADER) buf = buf.slice(buf.length - HEADER_END.length)
            return
          }
          const header = new TextDecoder('latin1').decode(buf.subarray(0, end))
          const m = /content-length:\s*(\d+)/i.exec(header)
          buf = buf.slice(end + HEADER_END.length)
          // A part without a length can't be cut safely: skip to the next header.
          need = m ? Number(m[1]) : -1
          continue
        }
        if (buf.length < need) return
        onFrame(buf.slice(0, need))
        buf = buf.slice(need)
        need = -1
      }
    },
  }
}
