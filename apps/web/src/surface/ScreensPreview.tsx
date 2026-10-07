import { useState } from 'react'
import { DISPLAY_LABEL, useDisplays } from './DisplaysControl.tsx'
import { useUiSync } from './uiSync.ts'

/**
 * "Screens": live mini-previews of what the projector and the two TVs show
 * (owner, 7 Oct: "make it so that I can see the preview of what the two TVs
 * [show]"). Each is the real page in a scaled iframe, not a re-drawing, so
 * what the preview shows is what the room's kiosk shows, by construction
 * (the same reasoning as Show's /table preview).
 *
 * Which page each display is pointed at comes from the shared display map
 * (useDisplays, the server's displays.ts), so a Setup re-point swaps the
 * preview too.
 *
 * Cost: each preview is a whole page with its own EventSources and, on
 * /table, MJPEG streams. Chrome allows six connections per host over plain
 * http, and three live previews plus the operator page used them all: a web
 * page on /table then stayed white in the owner's tab (7 Oct, 13:52). So only
 * ONE preview is live at a time (click a screen to watch it), the strip starts
 * collapsed, and collapsing UNMOUNTS the iframe, which closes its streams.
 *
 * The mirror iframe is safe here: its own URL carries ?mirror=1, so it never
 * publishes UI state, never forwards MIDI or plays the piano, and never
 * follows table input (OperatingSurface). And a mirror never draws this strip
 * itself, or it would nest previews of previews.
 */

const FRAME: Record<string, { w: number; h: number }> = {
  table: { w: 1920, h: 1200 }, // the projector's native size (room.config.json)
  'tv-1': { w: 1920, h: 1080 },
  'tv-2': { w: 1920, h: 1080 },
}
const PREVIEW_W = 300
const KEY = 'hubble.screens.open'

function initialOpen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function ScreensPreview({ compact = false }: { compact?: boolean }) {
  const sync = useUiSync()
  const [d] = useDisplays()
  const [open, setOpen] = useState(initialOpen)
  // No preview is live until one is clicked: each live page holds its own streams (see above).
  const [live, setLive] = useState<string | null>(null)
  if (sync.mirror || !d) return null
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(KEY, o ? '0' : '1')
      } catch {
        // not remembered
      }
      return !o
    })
  }
  const width = compact ? 200 : PREVIEW_W
  return (
    <section className={`screens${compact ? ' screens-compact' : ''}`} aria-label="screens">
      <button className="screens-toggle" onClick={toggle} aria-expanded={open}>
        {open ? '▾' : '▸'} Screens
      </button>
      {open && (
        <div className="screens-row">
          {Object.keys(DISPLAY_LABEL).map((id) => {
            const page = d.displays[id] ?? 'off'
            const path = d.paths?.[page] ?? null
            const f = FRAME[id]!
            const k = width / f.w
            return (
              <figure key={id} className="screens-item">
                <figcaption>
                  <b>{DISPLAY_LABEL[id]}</b> <span>{path ?? 'off'}</span>
                </figcaption>
                {path && live === id ? (
                  // An <a> over the frame: clicks inside an iframe never reach this
                  // page, so the overlay is what opens the full-size tab.
                  <a href={path} target="_blank" rel="noreferrer" className="screens-frame" style={{ width, height: f.h * k }} title={`open ${path} full size`}>
                    <iframe
                      key={path}
                      src={path}
                      title={`${DISPLAY_LABEL[id]} preview`}
                      loading="lazy"
                      tabIndex={-1}
                      style={{ width: f.w, height: f.h, transform: `scale(${k})` }}
                    />
                  </a>
                ) : path ? (
                  <button className="screens-frame screens-off" style={{ width, height: f.h * k }} onClick={() => setLive(id)} title="watch this screen here (one live preview at a time)">
                    ▶ watch {path}
                  </button>
                ) : (
                  <div className="screens-frame screens-off" style={{ width, height: f.h * k }}>
                    off
                  </div>
                )}
              </figure>
            )
          })}
        </div>
      )}
    </section>
  )
}
