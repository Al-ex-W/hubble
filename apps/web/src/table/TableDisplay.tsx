import { usePuppetInstance } from '../puppetInstance.ts'
import { subscribeStage } from './stageStream.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RenderStreamLine } from '@hubble/stage'
import { KeyboardSurface, StageView, SurfaceLayer } from '@hubble/stage-react'
import { assetRenderer } from './assetRenderer.tsx'
import { drawingRenderer } from './drawingRenderer.tsx'
import { DEFAULT_SURFACE } from '@hubble/stage'
import { applyTableLine, IDLE } from './tableState.ts'
import { OverlayLayer, useOverlays } from '../lesson/OverlayLayer.tsx'
import { TouchRipples } from './TouchRipples.tsx'
import { answerSurfaceFor, useSurfaces } from './surfaces.ts'
import { webRenderer } from './webRenderer.tsx'
import { launcherRenderer } from './launcherRenderer.tsx'

/**
 * The real projector view: full-screen, no chrome, no cursor. It subscribes to
 * the SSE rebroadcast at /api/stage/events and mirrors whatever render is
 * currently live, whether it came from the chat bench or a voice turn.
 *
 * The server decides which render is live and sends it whole to a display
 * that (re)connects, so this view keeps no history of its own: whatever the
 * stream says is the truth, and a reload or slot reset recovers by itself.
 */
export function TableDisplay() {
  const [table, setTable] = useState(IDLE)
  const overlays = useOverlays()
  const surfaces = useSurfaces()
  const seq = useRef(0)
  usePuppetInstance()

  // The display has no conversation or keyboard of its own: a tapped button
  // goes to the server, which renders the follow-up and sends it back over
  // the same SSE stream to every display. Fire-and-forget on purpose; the
  // answer arriving on the table is the only feedback that matters.
  const onAction = useCallback((action: string) => {
    void fetch('/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }).catch(() => {
      /* the server is unreachable; EventSource will show it when it returns */
    })
  }, [])

  useEffect(() => {
    const previousCursor = document.body.style.cursor
    document.body.style.cursor = 'none'
    return () => {
      document.body.style.cursor = previousCursor
    }
  }, [])

  useEffect(() => {
    // The page's one shared connection (stageStream.ts): /table also mounts
    // the surfaces and overlay hooks, and one EventSource each used up
    // Chrome's per-host connection limit.
    return subscribeStage({
      line: (line) => {
        const n = seq.current++
        setTable((prev) => applyTableLine(prev, line as unknown as RenderStreamLine, n))
      },
    })
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        cursor: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ width: '100%', position: 'relative' }}>
        {/* This page is what the table's Raspberry Pi shows: lite drops the
            glow filters and soft shadows its Chromium can't repaint smoothly. */}
        {(() => {
          // Everything on the table comes from the surface set (#26); the
          // answer is one kind among them, drawn exactly as before.
          const { set, offset } = answerSurfaceFor(surfaces, table.renderId, table.events.length > 0)
          return (
            <SurfaceLayer
              surfaces={set}
              surface={table.scene?.surface ?? DEFAULT_SURFACE}
              renderers={{
                web: (x) => webRenderer(x, table.scene?.surface ?? DEFAULT_SURFACE),
                launcher: (x) => launcherRenderer(x, table.scene?.surface ?? DEFAULT_SURFACE),
                asset: (x) => assetRenderer(x, table.scene?.surface ?? DEFAULT_SURFACE),
                drawing: (x) => drawingRenderer(x, table.scene?.surface ?? DEFAULT_SURFACE),
                answer: () => <StageView events={table.events} renderKey={table.key} scene={table.scene} speed={1} onAction={onAction} lite panelOffset={offset} transparent />,
                // The swipe keyboard (#29): its text and candidates are the
                // runtime's; this page only draws them.
                keyboard: (s) => <KeyboardSurface s={s} surface={table.scene?.surface ?? DEFAULT_SURFACE} />,
              }}
            />
          )
        })()}
        {/* The runtime's own light (the lesson's keys), drawn on top of the answer. */}
        <OverlayLayer lines={overlays} surface={table.scene?.surface ?? DEFAULT_SURFACE} />
        {/* Light where a finger touched the table (lidar, #89), above everything else. */}
        <TouchRipples surface={table.scene?.surface ?? DEFAULT_SURFACE} />
      </div>
    </div>
  )
}
