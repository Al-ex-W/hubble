import { cropPixels, roiParam, toFullFrame, type Rect, type Roi } from '../../../shared/hands/roi.ts'
import type { HandObservation } from '../../../server/spatial/observations.ts'
import type { Hand } from './types.ts'

/**
 * The room camera as the hand tracker sees it, cropped to the keyboard (#84),
 * and the ONLY place room-camera landmarks are turned into what leaves the
 * browser.
 *
 * Why one module: the camera now streams a crop (about 45 fps instead of 7),
 * but everything downstream (the spatial service's calibration, the
 * operator's camera view) works in full-frame pixels. Every landmark must be
 * shifted by the crop origin and every frame reported as the full 1920x1080,
 * in BOTH payloads (the spatial observation and the hands mirror). One
 * forgotten path types at the wrong key or draws the hand in the wrong place,
 * so both are built here and tested together.
 */
export interface RoomView {
  /** The stream to open: cropped when the server knows the keyboard, else the full frame. */
  url: string
  /** The rectangle the Pi crops (full-frame px), or null for the full frame. */
  crop: Rect | null
  /** The calibrated full frame every observation must report, or null when unknown (no crop). */
  frame: { width: number; height: number; geometry: string } | null
}

export const FULL: RoomView = { url: '/api/camera/stream', crop: null, frame: null }

/** What GET /api/camera/roi answered, as a view. Anything unexpected falls back to the full frame. */
export function viewFor(body: unknown): RoomView {
  const b = body as { roi?: Roi | null; frame?: { width: number; height: number; geometry: string } } | null
  if (!b?.roi || !b.frame) return FULL
  try {
    return { url: `/api/camera/stream?roi=${roiParam(b.roi)}`, crop: cropPixels(b.roi, b.frame.width, b.frame.height), frame: b.frame }
  } catch {
    return FULL
  }
}

export async function fetchRoomView(fetcher: typeof fetch = fetch): Promise<RoomView> {
  try {
    const r = await fetcher('/api/camera/roi', { signal: AbortSignal.timeout(2000) })
    return r.ok ? viewFor(await r.json()) : FULL
  } catch {
    return FULL
  }
}

/**
 * The full-frame size to report for a decoded video frame, or null when the
 * video is not the crop we asked for (the Pi in another mode, say 4K, or a
 * crop changed under us). Null means: post nothing. A guessed scale would
 * type at the wrong key, which is worse than not typing.
 */
export function frameSize(video: { videoWidth: number; videoHeight: number }, view: RoomView): { width: number; height: number } | null {
  if (!view.crop) return { width: video.videoWidth, height: video.videoHeight }
  if (video.videoWidth !== view.crop.w || video.videoHeight !== view.crop.h) return null
  return { width: view.frame!.width, height: view.frame!.height }
}

const full = (view: RoomView, x: number, y: number) => (view.crop ? toFullFrame({ x, y }, view.crop) : { x, y })

/** The spatial observation for one frame, in full-frame px, or null (see frameSize). */
export function observationFor(
  hands: Hand[],
  video: { videoWidth: number; videoHeight: number },
  view: RoomView,
  meta: { session: string; seq: number; capturedAt: number; input: HandObservation['input'] },
): HandObservation | null {
  const size = frameSize(video, view)
  if (!size) return null
  return {
    session: meta.session,
    seq: meta.seq,
    capturedAt: meta.capturedAt,
    geometry: 'room:full-frame',
    width: size.width,
    height: size.height,
    input: meta.input,
    hands: hands.map((h) => {
      const point = (i: number) => full(view, h.lm[i]![0], h.lm[i]![1])
      return { index: point(8), pinch: { thumb: point(4), wrist: point(0), middle: point(9) } }
    }),
  } as HandObservation
}

/** The hands mirror body (the operator's camera view draws it over the full frame), or null. */
export function mirrorFor(hands: Hand[], video: { videoWidth: number; videoHeight: number }, view: RoomView, pinch: boolean) {
  const size = frameSize(video, view)
  if (!size) return null
  return {
    source: 'room' as const,
    width: size.width,
    height: size.height,
    pinch,
    hands: hands.map((h) => ({ lm: h.lm.map(([x, y]) => { const p = full(view, x, y); return [p.x, p.y] as [number, number] }) })),
  }
}

/**
 * The one owner of "which crop is live, and which stream carries it" (#84,
 * review of #85).
 *
 * Why it exists: the hand tracker maps every landmark with the CURRENT view's
 * crop. When the keyboard moves, a new stream with a new crop is opened and
 * swapped in. If the view and the stream ever change apart (one assignment
 * lost, or a slower earlier reopen landing after a newer one), landmarks from
 * one crop get mapped with the other crop's offset, and pinch typing hits the
 * wrong key with no error anywhere. So the pair changes only here, together,
 * and only for the newest reopen:
 *   - begin() hands out a ticket for a reopen;
 *   - commit(ticket, view, cam) swaps BOTH in, but only if no newer ticket was
 *     handed out; otherwise it refuses, and the caller stops that stream.
 *
 * The <video> element itself is switched by onSwap, inside the same commit,
 * so nothing can read the new view with the old stream in between.
 */
export function createRoomSwitch<C>(onSwap: (view: RoomView, cam: C | null, previous: C | null) => void) {
  let ticket = 0
  let view: RoomView = FULL
  let cam: C | null = null
  return {
    get view() {
      return view
    },
    get cam() {
      return cam
    },
    begin() {
      return ++ticket
    },
    commit(t: number, nextView: RoomView, nextCam: C | null): boolean {
      if (t !== ticket) return false
      const previous = cam
      view = nextView
      cam = nextCam
      onSwap(view, cam, previous)
      return true
    },
    /** Forget everything (tracker stopped): later commits from old tickets are refused. */
    reset() {
      ticket++
      view = FULL
      cam = null
    },
  }
}
