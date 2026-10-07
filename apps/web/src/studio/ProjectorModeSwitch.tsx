import { PROJECTOR_MODES, useProjectorMode } from './projectorMode.ts'
import './projectorMode.css'

/**
 * "Projector: canvas | calibrate". The projector is a kiosk nobody can click,
 * so this POSTs the mode to the server and the projector page follows over SSE.
 * The pressed state shows the SERVER's mode (from the event stream), not the
 * last button pressed here, so two open tabs never disagree about what the
 * table is showing.
 */
export function ProjectorModeSwitch() {
  const { mode, choose, error } = useProjectorMode()
  return (
    <div className="projector-mode">
      <span>Projector</span>
      <div className="projector-mode-tabs" role="group" aria-label="Projector mode">
        {PROJECTOR_MODES.map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => void choose(m)}>{m}</button>
        ))}
      </div>
      {error && <span className="projector-mode-error" role="alert">{error}</span>}
    </div>
  )
}
