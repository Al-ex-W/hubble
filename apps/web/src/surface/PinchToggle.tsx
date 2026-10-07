import { useRoomHands } from '../hands/RoomHands.tsx'

/**
 * Show mode's pinch typing switch and its light (#75).
 *
 * One button, because during a demo the operator has one question: "can the
 * audience type by pinching right now?" On starts the page's one room-camera
 * tracker (RoomHands.tsx) and takes the keyboard's input grant; off gives the
 * grant back and stops the tracker, so the Pi's camera bandwidth is free
 * again. The light says whether it is really working: green only when frames
 * arrive AND the grant is ours; the fps and hands seen let the operator tell
 * "no hand in view" from "camera stalled" at a glance.
 */
export function PinchToggle() {
  const { state, stop, setPinch } = useRoomHands()
  const on = state.pinch || state.phase !== 'off'
  const level = state.phase === 'running' && state.pinch && state.fps > 0 && !state.crop.startsWith('CROP MISMATCH') ? 'ok' : on ? 'warn' : 'bad'
  const text =
    state.phase === 'off'
      ? state.text === 'off' ? 'off' : state.text // keep a failure visible after the tracker stopped itself
      : state.phase === 'starting'
        ? state.text
        : `${state.fps} fps · ${state.hands} hand${state.hands === 1 ? '' : 's'} · ${state.pinch ? state.inputStatus : 'not typing'}${state.crop.startsWith('CROP MISMATCH') ? ' · crop mismatch' : ''}`
  return (
    <>
      <button
        className={`show-arm ${on ? 'pinch-on' : ''}`}
        disabled={state.selectingInput}
        onClick={() => (on ? stop() : void setPinch(true))}
        title="Start the room camera hand tracker and let pinches type on the projected keyboard"
      >
        pinch typing: {on ? 'ON' : 'off'}
      </button>
      <span className={`show-light ${level}`} title={state.text}>
        <b>hands</b> {text}
      </span>
    </>
  )
}
