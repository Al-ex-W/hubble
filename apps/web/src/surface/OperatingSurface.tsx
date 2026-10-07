import { useState } from 'react'
import { ChatPreview } from '../preview/ChatPreview.tsx'
import { ProjectorModeSwitch } from '../studio/ProjectorModeSwitch.tsx'
import { ShowView } from './ShowView.tsx'
import { usePuppetAssistant } from '../hubble/assistant/usePuppetAssistant.ts'
import { MidiBridge } from '../input/MidiBridge.tsx'
import { PianoSpeaker } from '../input/PianoSpeaker.tsx'
import { RoomHandsProvider } from '../hands/RoomHands.tsx'
import { isMirror, UiSyncCtx, useUiSyncSource } from './uiSync.ts'
import { DisplaysControl } from './DisplaysControl.tsx'
import { ScreensPreview } from './ScreensPreview.tsx'
import './surface.css'

/**
 * The operating surface at :5173/ (#75): one page, two modes.
 *
 * - **Show** is for demoing: two act cards in show order, asking the puppet
 *   master, and a live preview of the table.
 * - **Setup** is the development bench: chat with model controls, the to-scale
 *   simulator, hand tracker, room rehearsal, debug, and the show column.
 *
 * Why modes, not one page with everything: the owner, 7 Oct: "the UI is
 * confusing … I do not know how to control and demo stuff". Every control had
 * equal weight. The owner picked this split from three mock-ups.
 *
 * Only one mode is mounted at a time. That keeps the page's single
 * LessonPanel invariant (#66), and Setup's heavier panels (the simulator, the
 * local webcam tracker) cost nothing during a show. The ROOM hand tracker is
 * the exception: it is mounted above both modes (RoomHandsProvider, #75),
 * because pinch typing is part of the show and died when Show unmounted
 * Setup's tracker.
 */
export type Mode = 'show' | 'setup'

const KEY = 'hubble.surface.mode'

/**
 * Show unless this browser last chose Setup. Remembered per browser, so a
 * reload mid-demo doesn't drop the operator into the bench. Storage can be
 * missing or throw (private mode, blocked site data), and then it's Show.
 */
export function initialMode(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Mode {
  try {
    return storage?.getItem(KEY) === 'setup' ? 'setup' : 'show'
  } catch {
    return 'show'
  }
}

export function OperatingSurface({ mirror = isMirror() }: { mirror?: boolean } = {}) {
  const [localMode, setMode] = useState<Mode>(() => (mirror ? 'show' : initialMode()))
  const sync = useUiSyncSource(mirror, { mode: localMode })
  // The mirror (TV 1, `?mirror=1`) draws the operator's mode, never its own.
  const mode: Mode = mirror ? sync.ui.mode : localMode
  // The ONE puppet-master conversation on this page, mounted here (not in ShowView) so it
  // survives Show/Setup switches and nothing else on the page opens a second session.
  // followTableInput: this page is the conversation's home, so text typed on the
  // projected keyboard or by pinch typing (published by the server's ask seam)
  // becomes a turn here. Only this page opts in, or every open tab would answer it.
  // A mirror never opts in: the TV must not answer (and speak) a second time.
  const assistant = usePuppetAssistant({ followTableInput: !mirror })
  const choose = (m: Mode) => {
    if (mirror) return
    setMode(m)
    sync.report({ mode: m })
    try {
      localStorage.setItem(KEY, m)
    } catch {
      // Not remembered; the mode still switches.
    }
  }
  const main = <div className="surface-main">{mode === 'show' ? <ShowView assistant={assistant} /> : mirror ? <MirrorSetup /> : <ChatPreview />}</div>
  return (
    <UiSyncCtx.Provider value={sync}>
      {/* Capture phase: any press anywhere makes this page the one the TV follows. */}
      <div className={`surface${mirror ? ' surface-mirror' : ''}`} onPointerDownCapture={sync.touch} onKeyDownCapture={sync.touch}>
        <header className="surface-bar">
          <strong>hubble</strong>
          <div className="surface-modes" role="tablist" aria-label="mode">
            {(['show', 'setup'] as const).map((m) => (
              <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => choose(m)}>
                {m === 'show' ? 'Show' : 'Setup'}
              </button>
            ))}
          </div>
          {mode === 'setup' && !mirror && <ProjectorModeSwitch />}
          {mode === 'setup' && !mirror && <DisplaysControl />}
          {mode === 'setup' && !mirror && <ScreensPreview compact />}
          <small>{mode === 'show' ? 'what to press during the demo' : 'calibration, rehearsal and developer tools'}</small>
          {mirror && <span className="surface-mirror-badge">mirror · following the operator</span>}
          {/* The piano's speaker (#121), above both modes like MidiBridge. Not on
              a mirror: the TV would play every note a second time. */}
          {!mirror && <PianoSpeaker />}
        </header>
        {/* The real MiniLab is forwarded here, above both modes: it must work
            whatever is on screen (MidiBridge.tsx says why). A mirror skips it:
            a TV that forwarded MIDI too would press every key twice. The room
            hand tracker's provider stays (Show's PinchToggle needs it); it
            only starts on a press, and a mirror takes no presses. */}
        {mirror ? (
          <RoomHandsProvider>{main}</RoomHandsProvider>
        ) : (
          <MidiBridge>
            <RoomHandsProvider>{main}</RoomHandsProvider>
          </MidiBridge>
        )}
      </div>
    </UiSyncCtx.Provider>
  )
}

/**
 * What TV 1 shows while the operator is in Setup. Not the bench itself: the
 * bench (ChatPreview) sends its own default scene and drives the simulator on
 * mount, and a second copy on the TV replaced the real bench's state once
 * already (routes.ts, review of #61). So the TV says where the operator is.
 */
function MirrorSetup() {
  return (
    <div className="surface-mirror-setup">
      <h2>Setup</h2>
      <p>The operator is calibrating and rehearsing. The show resumes here.</p>
    </div>
  )
}
