import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createObservationClient } from './observationClient.ts'
import { createKeyboardInputClient } from './keyboardInputClient.ts'
import { openRoomCamera, type RoomCamera } from './roomCamera.ts'
import { createRoomSwitch, fetchRoomView, mirrorFor, observationFor } from './roomView.ts'
import { createLandmarker, type Landmarker } from './landmarker.ts'
import { createFrameGate } from './frameGate.ts'
import { startCamera } from '../ipad/ipadCamera.ts'
import { useSurfaces } from '../table/surfaces.ts'
import type { Hand } from './types.ts'

/**
 * THE room-camera hand tracker for the page (#75): one MediaPipe instance,
 * one room camera stream, one input grant, whichever mode is on screen.
 *
 * Why a provider and not HandPanel: HandPanel lived in Setup, and the
 * operating surface mounts one mode at a time, so switching to Show for the
 * demo unmounted the tracker and pinch typing silently stopped. The tracker
 * now sits above both modes (OperatingSurface), and every view of it (Show's
 * toggle and dot, Setup's debug overlay) only reads it. Two views each owning
 * a tracker would mean two camera streams from the Pi (its bandwidth is the
 * room's scarcest thing, #84) and two grants fighting over the keyboard.
 *
 * Start/stop is ipadCamera.ts's `startCamera`, reused on purpose: it already
 * disposes a stream or landmarker that arrives after stop, and its stop always
 * gives the keyboard input back to pointer mode (#95 hit exactly that leak:
 * the grant outlived the camera and nobody's pinches kept "typing").
 *
 * Only the ROOM camera lives here. HandPanel's local-webcam path (the bench's
 * printed keyboard) stays in HandPanel: it is a developer tool, never part of
 * a show, and feeds the bench's own swipe keyboard rather than the server.
 */

export interface RoomHandsState {
  phase: 'off' | 'starting' | 'running'
  /** What to show next to the dot: the last error, or "loading…", or the live line. */
  text: string
  fps: number
  hands: number
  /** The crop note (#84): '' for the full frame, or a mismatch warning (then nothing types). */
  crop: string
  pinch: boolean
  /** The server's word on the grant, polled while pinch typing is on. */
  inputStatus: string
  /** A grant request is in flight. */
  selectingInput: boolean
}

export type FrameListener = (hands: Hand[], video: HTMLVideoElement) => void

export interface RoomHands {
  state: RoomHandsState
  start(): void
  stop(): void
  /** On: start the tracker if it isn't running, then take the grant. Off: release the grant only. */
  setPinch(on: boolean): Promise<void>
  /** Every tracked frame, for an overlay (Setup's debug view). Returns the unsubscribe. */
  onFrame(listener: FrameListener): () => void
}

const OFF: RoomHandsState = { phase: 'off', text: 'off', fps: 0, hands: 0, crop: '', pinch: false, inputStatus: 'diagnostics only', selectingInput: false }

const Ctx = createContext<RoomHands | null>(null)

export function useRoomHands(): RoomHands {
  const v = useContext(Ctx)
  // A view without the provider would silently show "off" forever; fail loud
  // instead, so a new page that forgets to mount it is caught at once.
  if (!v) throw new Error('useRoomHands needs <RoomHandsProvider> above it')
  return v
}

export function RoomHandsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RoomHandsState>(OFF)
  const patch = (p: Partial<RoomHandsState>) => setState((s) => ({ ...s, ...p }))
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const inputRef = useRef(createKeyboardInputClient())
  const listeners = useRef(new Set<FrameListener>())
  // The current session's stop (startCamera's), or null when off.
  const stopRef = useRef<(() => void) | null>(null)
  // Bumped by every start and stop: a reopen or a grant that resolves for an
  // older session must not attach to this one.
  const runToken = useRef(0)
  const [running, setRunning] = useState(false)

  // The live crop and its stream change only together, newest reopen first
  // (createRoomSwitch, #85). The swap also switches the <video>, inside the
  // same commit, so the loop never maps a new stream with the old crop.
  const roomSwitch = useMemo(
    () =>
      createRoomSwitch<RoomCamera>((_view, cam, previous) => {
        const v = videoRef.current
        if (v && cam) {
          v.srcObject = cam.stream
          void v.play().catch(() => undefined)
        }
        previous?.stop()
      }),
    [],
  )

  const stop = useCallback(() => {
    runToken.current++
    const s = stopRef.current
    stopRef.current = null
    s?.() // releases the grant (startCamera's `released`)
    roomSwitch.cam?.stop()
    roomSwitch.reset()
    if (videoRef.current) videoRef.current.srcObject = null
    setRunning(false)
    setState(OFF)
  }, [roomSwitch])

  const start = useCallback(() => {
    if (stopRef.current) return
    const token = ++runToken.current
    patch({ phase: 'starting', text: 'starting room camera…' })
    stopRef.current = startCamera<{ getTracks(): { stop(): void }[] }, Landmarker>({
      wake: async () => null, // the laptop doesn't sleep mid-show; only the iPad needs a wake lock
      stream: async () => {
        // Cropped to the keyboard when the server knows where it is (~45 fps
        // against ~7 for the full frame, #84).
        const ticket = roomSwitch.begin()
        const view = await fetchRoomView()
        const cam = await openRoomCamera(view.url)
        if (!roomSwitch.commit(ticket, view, cam)) {
          cam.stop()
          throw new Error('superseded')
        }
        // startCamera stops "tracks" on stop: here that means whichever room
        // stream is live by then (the follow below may have swapped it).
        return { getTracks: () => [{ stop: () => roomSwitch.cam?.stop() }] }
      },
      play: async () => {
        const v = videoRef.current
        if (v) await v.play()
      },
      landmarker: () => createLandmarker(),
      run: (lm) => {
        if (token !== runToken.current) return () => undefined
        setRunning(true)
        patch({ phase: 'running', text: `${lm.source} assets · waiting for frames` })
        return runLoop(lm)
      },
      released: () => inputRef.current.disable(),
      status: (text) => patch({ text }),
      error: (e) => {
        if (token !== runToken.current) return
        const message = e instanceof Error ? e.message : String(e)
        stop()
        patch({ text: `room camera or tracker failed: ${message}` })
      },
    })
  }, [roomSwitch, stop])

  // One landmark frame per CAMERA frame (frameGate: a 60 Hz display shows a
  // 30 fps frame twice, and counting it twice let one noisy sample pass the
  // two-frame pinch confirmation, review #42).
  const runLoop = (lm: Landmarker) => {
    const v = videoRef.current!
    const observations = createObservationClient()
    const session = crypto.randomUUID()
    const fresh = createFrameGate()
    let seq = 0
    let raf = 0
    let frames = 0
    let since = performance.now()
    let lastMirror = 0
    let mirrorBusy = false
    const loop = () => {
      raf = requestAnimationFrame(loop)
      if (v.readyState < 2 || !fresh(v.currentTime)) return
      const t = performance.now()
      const frame = lm.detect(v, t)
      const view = roomSwitch.view
      // Full-frame px whatever the crop; null when the video isn't the crop
      // we asked for, and then nothing is sent (roomView.ts says why).
      const obs = observationFor(frame.hands, v, view, { session, seq: ++seq, capturedAt: t, input: inputRef.current.current() })
      if (obs) observations.post(obs)
      for (const l of listeners.current) l(frame.hands, v)
      // The operator's camera view mirror, ~10 a second (handsMirror.ts).
      if (!mirrorBusy && t - lastMirror > 100) {
        lastMirror = t
        mirrorBusy = true
        const body = mirrorFor(frame.hands, v, view, false) ?? { source: 'room', width: v.videoWidth, height: v.videoHeight, pinch: false, hands: [] }
        void fetch('/api/input/hands', { method: 'POST', signal: AbortSignal.timeout(2500), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          .catch(() => undefined)
          .finally(() => (mirrorBusy = false))
      }
      frames++
      if (t - since > 1000) {
        const crop = view.crop
          ? v.videoWidth === view.crop.w && v.videoHeight === view.crop.h
            ? `keyboard crop ${view.crop.w}×${view.crop.h}`
            : `CROP MISMATCH (video ${v.videoWidth}×${v.videoHeight}): not typing`
          : 'full frame'
        const fps = Math.round((frames * 1000) / (t - since))
        patch({ fps, hands: frame.hands.length, crop, text: `${lm.source} assets · ${fps} fps · ${crop} · ${frame.hands.length} hand(s)` })
        frames = 0
        since = t
      }
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      observations.stop()
    }
  }

  // While pinch typing is on, poll the server's view of the grant: another
  // source (the iPad, Setup's pointer) can take it away, and the operator must
  // see that rather than pinch at a keyboard that no longer listens.
  useEffect(() => {
    if (!state.pinch) return
    let stopped = false
    let busy = false
    const timer = setInterval(() => {
      if (busy) return
      busy = true
      void fetch('/api/keyboard/input', { signal: AbortSignal.timeout(2000) })
        .then((r) => r.json())
        .then((s: { token: string; reason: string }) => {
          if (!stopped) patch({ inputStatus: s.token === inputRef.current.current()?.token ? s.reason : 'input mode changed; enable again' })
        })
        .catch(() => {
          if (!stopped) patch({ inputStatus: 'input server unavailable' })
        })
        .finally(() => (busy = false))
    }, 500)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [state.pinch])

  const setPinch = useCallback(
    async (on: boolean) => {
      if (!on) {
        inputRef.current.disable()
        patch({ pinch: false, inputStatus: 'diagnostics only' })
        return
      }
      if (!stopRef.current) start()
      const run = runToken.current
      patch({ selectingInput: true })
      try {
        if ((await inputRef.current.enable()) && run === runToken.current) patch({ pinch: true, inputStatus: 'open pinch to begin' })
        // The tracker stopped while the grant was in flight: give it back.
        else if (run !== runToken.current) inputRef.current.disable()
      } catch (e) {
        if (run === runToken.current) patch({ inputStatus: e instanceof Error ? e.message : 'Cannot enable pinch typing' })
      } finally {
        patch({ selectingInput: false })
      }
    },
    [start],
  )

  // The page going away (or the provider remounting) ends the session and
  // releases the grant: a grant without a tracker would leave the keyboard
  // listening to nobody's pinches (#95).
  useEffect(() => () => stop(), [stop])

  const onFrame = useCallback((l: FrameListener) => {
    listeners.current.add(l)
    return () => void listeners.current.delete(l)
  }, [])

  const value = useMemo<RoomHands>(() => ({ state, start, stop, setPinch, onFrame }), [state, start, stop, setPinch, onFrame])
  return (
    <Ctx.Provider value={value}>
      {/* The tracker's video, mounted once for the page. Not display:none:
          a browser may stop decoding a video it never lays out, and the loop
          would then see no new frames. 1 px, invisible, out of the way. */}
      <video
        ref={videoRef}
        muted
        playsInline
        aria-hidden
        style={{ position: 'fixed', left: 0, top: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
      />
      {/* Only while running: the surface stream is only needed to follow the keyboard. */}
      {running && <FollowKeyboard roomSwitch={roomSwitch} runToken={runToken} />}
      {children}
    </Ctx.Provider>
  )
}

/**
 * Follow the keyboard (#84/#85): when it opens, closes or moves, ask for the
 * new crop and swap ONLY the stream (not the tracker, not the grant).
 * Debounced 800 ms (a drag moves it many times a second, and each reopen costs
 * the Pi a stream), and re-asked every 5 s, because a calibration installed or
 * replaced moves the crop with the keyboard standing still. Its own component,
 * mounted only while the tracker runs, so an idle page holds no subscription.
 */
function FollowKeyboard({ roomSwitch, runToken }: { roomSwitch: ReturnType<typeof createRoomSwitch<RoomCamera>>; runToken: { current: number } }) {
  const surfaces = useSurfaces()
  const kb = surfaces?.find((x) => x.kind === 'keyboard')
  const kbKey = kb ? `${Math.round(kb.box.x)},${Math.round(kb.box.y)},${Math.round(kb.box.w)},${Math.round(kb.box.h)}` : 'none'
  useEffect(() => {
    const token = runToken.current
    const follow = async () => {
      const ticket = roomSwitch.begin()
      const view = await fetchRoomView()
      if (token !== runToken.current || view.url === roomSwitch.view.url) return
      const next = await openRoomCamera(view.url).catch(() => null)
      if (!next) return
      // Refused when a newer reopen landed or the tracker stopped: stale stream.
      // On success the switch's onSwap moves the <video> and stops the old one.
      if (token !== runToken.current || !roomSwitch.commit(ticket, view, next)) next.stop()
    }
    const timer = setTimeout(() => void follow(), 800)
    const recheck = setInterval(() => void follow(), 5000)
    return () => {
      clearTimeout(timer)
      clearInterval(recheck)
    }
  }, [kbKey, roomSwitch, runToken])
  return null
}
