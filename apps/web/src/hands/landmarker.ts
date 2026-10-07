import type { Frame, Hand } from './types.ts'

/**
 * MediaPipe's hand landmarker in the browser: a video frame in, 21 points per
 * hand out, in IMAGE PIXELS (the frame format the pipeline and the lab's
 * recordings share).
 *
 * Assets load from this server first (/mediapipe/, filled by
 * `npm run hands:assets`) and from the public CDNs only as a fallback. The
 * room's wifi reaches room.local; whether it reaches the internet is
 * unverified, and the hand tracker must not depend on it on the day.
 *
 * Pinned to 0.10.14, the version the hands lab ran live (and its model):
 * the 1.x line is newer than anything we have run on a real hand.
 */
const VERSION = '0.10.14'
const LOCAL = { wasm: '/mediapipe/wasm', model: '/mediapipe/hand_landmarker.task' }
const REMOTE = {
  wasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`,
  model: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
}

/**
 * Whether a URL really serves an asset. Not just `res.ok`: the dev server and
 * any SPA host answer a missing file with index.html and a 200, so a fresh
 * checkout without `npm run hands:assets` looked "local" and then failed to
 * load instead of falling back to the CDN (review #42).
 */
export async function isAsset(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { method: 'HEAD' })
    return res.ok && !(res.headers.get('content-type') ?? '').startsWith('text/html')
  } catch {
    return false
  }
}

/** Local assets when they are really there, else the CDN. */
export async function pickAssets(fetchImpl: typeof fetch = fetch): Promise<'local' | 'cdn'> {
  const ok = (await isAsset(`${LOCAL.wasm}/vision_wasm_internal.wasm`, fetchImpl)) && (await isAsset(LOCAL.model, fetchImpl))
  return ok ? 'local' : 'cdn'
}

export interface Landmarker {
  /** Where the assets came from, for the panel's status line. */
  source: 'local' | 'cdn'
  detect(video: HTMLVideoElement, t: number): Frame
  close(): void
}

export async function createLandmarker(): Promise<Landmarker> {
  // Loaded on demand: the bench must not pay for (or fail on) the vision
  // bundle until someone switches the hand tracker on.
  const vision = await import('@mediapipe/tasks-vision')
  const init = async (where: typeof LOCAL) => {
    const fileset = await vision.FilesetResolver.forVisionTasks(where.wasm)
    return vision.HandLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: where.model, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 2 })
  }
  let source = await pickAssets()
  let lm
  try {
    lm = await init(source === 'local' ? LOCAL : REMOTE)
  } catch (e) {
    // Local files present but broken (a partial copy, a stale wasm): the
    // CDN is still worth a try before giving up.
    if (source !== 'local') throw e
    source = 'cdn'
    lm = await init(REMOTE)
  }
  return {
    source,
    detect(video, t) {
      const w = video.videoWidth
      const h = video.videoHeight
      const r = lm.detectForVideo(video, t)
      const hands: Hand[] = r.landmarks.map((pts, i) => ({
        handedness: (r.handedness[i]?.[0]?.categoryName as 'Left' | 'Right') ?? 'Right',
        score: r.handedness[i]?.[0]?.score ?? 0,
        // MediaPipe gives 0..1 of the frame; image px keep the camera
        // homography an ordinary pixel map (and match the recordings).
        lm: pts.map((p) => [p.x * w, p.y * h] as [number, number]),
      }))
      return { t, hands }
    },
    close: () => lm.close(),
  }
}
