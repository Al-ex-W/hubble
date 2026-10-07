import type { Writable } from 'node:stream'
import type { SpatialService } from './service.ts'
import type { SpatialFrame } from './frame.ts'

/** Latest-state observation, not a lossless remote gesture bus. A blocked
 * browser keeps one in-flight write plus one replaceable pending frame. The
 * keyboard's in-process subscriber remains lossless and never waits for HTTP.
 * Reconnect receives the current frame; old pinch actions are never replayed.
 */
export function streamSpatial(spatial: SpatialService, sink: Writable) {
  let closed = false
  let blocked = false
  let pending: SpatialFrame | null = null
  let deadline: ReturnType<typeof setTimeout> | null = null
  let unsubscribe = () => {}
  const cleanup = () => {
    if (closed) return
    closed = true
    pending = null
    if (deadline) clearTimeout(deadline)
    unsubscribe()
    sink.off('drain', drain)
    sink.off('close', cleanup)
    sink.off('finish', cleanup)
    sink.off('error', cleanup)
  }
  const send = (frame: SpatialFrame) => {
    if (closed) return
    if (blocked) { pending = frame; return }
    blocked = !sink.write(`id: ${frame.session}:${frame.seq}\nevent: spatial\ndata: ${JSON.stringify(frame)}\n\n`)
    if (blocked) {
      deadline = setTimeout(() => { cleanup(); sink.destroy() }, 5000)
      deadline.unref()
    }
    // end() can itself wait for a slow peer. Keep the deadline until finish,
    // even for the final state, rather than retaining that socket indefinitely.
    if (frame.state === 'stopped') { unsubscribe(); sink.end() }
  }
  const drain = () => {
    blocked = false
    if (deadline) clearTimeout(deadline)
    deadline = null
    const next = pending
    pending = null
    if (next) send(next)
  }
  sink.on('drain', drain)
  sink.on('close', cleanup)
  sink.on('finish', cleanup)
  sink.on('error', cleanup)
  unsubscribe = spatial.subscribe(send)
  // Subscription immediately supplies latest state, including an already
  // stopped service. Its synchronous callback may close before assignment.
  if (closed) unsubscribe()
  return cleanup
}
