import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { OBJECT_SIZE_MM, pxFromMm, type ObjectKind, type Scene, type SceneObject, type StageEvent, type TableSurface } from '@hubble/stage'
import { KeyboardSurface, StageView, SurfaceLayer } from '@hubble/stage-react'
import { assetRenderer } from '../table/assetRenderer.tsx'
import { drawingRenderer } from '../table/drawingRenderer.tsx'
import type { OverlayLine } from '@hubble/stage'
import { OverlayLayer } from '../lesson/OverlayLayer.tsx'
import { TouchRipples } from '../table/TouchRipples.tsx'
import { postWebInput, webRenderer } from '../table/webRenderer.tsx'
import { launcherRenderer } from '../table/launcherRenderer.tsx'
import { answerSurfaceFor, useSurfaces } from '../table/surfaces.ts'

/**
 * The room's table, to scale, with the projection on it.
 *
 * Everything here is in real units, from the room spec: a 1.5 x 1.5 m table
 * under black cloth, and a 16:9 image that covers its width (1.5 m x ~0.84 m,
 * centred, so strips at the front and back stay unlit). Objects are drawn at
 * their real size and can be dragged anywhere on the table, including the
 * unlit strips. The projection is composited as light: screen blending adds it
 * on top of whatever is underneath, the way a projector does, and the cloth
 * never goes perfectly black under a projector.
 */

export const TABLE_MM = 1500

export interface SimObjectVisual {
  /** For a notebook: the page photo shown on it (also what the model "sees"). */
  photo?: string
}

interface TableSimProps {
  scene: Scene
  setScene: (s: Scene) => void
  visuals: Record<string, SimObjectVisual>
  events: StageEvent[]
  renderKey: string
  /** The render being shown, so a move made on the table is applied only to that answer. */
  renderId?: string
  speed: number
  onAction: (action: string) => void
  showOutlines: boolean
  /** The runtime's own light (the lesson's keys), drawn exactly as /table draws it. */
  overlays?: OverlayLine[]
  /** More projected light, composited like the answer. */
  projected?: ReactNode
  /**
   * How to draw the keyboard surface (#29). The bench passes its input layer
   * (the same face plus a pointer); without it, the face alone, as /table.
   */
  keyboard?: (s: TableSurface) => ReactNode
}

export function makeObject(kind: ObjectKind, scene: Scene, at: { xMm: number; yMm: number }): SceneObject {
  const size = OBJECT_SIZE_MM[kind]
  return {
    id: kind,
    kind,
    box: {
      x: pxFromMm(scene.surface, at.xMm),
      y: pxFromMm(scene.surface, at.yMm),
      w: pxFromMm(scene.surface, size.w),
      h: pxFromMm(scene.surface, size.h),
    },
  }
}

export function TableSim({ scene, setScene, visuals, events, renderKey, renderId, speed, onAction, showOutlines, overlays = [], projected, keyboard }: TableSimProps) {
  const { surface } = scene
  const projW = surface.widthPx * surface.mmPerPx
  const projH = surface.heightPx * surface.mmPerPx
  const projTop = (TABLE_MM - projH) / 2

  // Screen pixels per millimetre of table, from the box the pane gives us.
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [k, setK] = useState(0.4)
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const fit = () => setK(Math.min(el.clientWidth, el.clientHeight) / TABLE_MM)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Surface px → screen px on the table drawing.
  const sx = (px: number) => px * surface.mmPerPx * k
  const sy = (px: number) => (projTop + px * surface.mmPerPx) * k

  const drag = useRef<{ id: string; startX: number; startY: number; box: SceneObject['box'] } | null>(null)
  const onDown = (o: SceneObject) => (e: ReactPointerEvent<HTMLDivElement>) => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { id: o.id, startX: e.clientX, startY: e.clientY, box: o.box }
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const toPx = 1 / (surface.mmPerPx * k)
    const x = d.box.x + (e.clientX - d.startX) * toPx
    const y = d.box.y + (e.clientY - d.startY) * toPx
    setScene({ ...scene, objects: scene.objects.map((o) => (o.id === d.id ? { ...o, box: { ...o.box, x, y } } : o)) })
  }
  const onUp = () => {
    drag.current = null
  }

  const surfaces = useSurfaces()
  const answer = answerSurfaceFor(surfaces, renderId, events.length > 0)

  const side = TABLE_MM * k
  const tenCm = 100 * k

  return (
    <div ref={wrapRef} className="sim-wrap">
      <div className="sim-table" style={{ width: side, height: side }}>
        {/* Objects lie on the cloth, under the light. */}
        {scene.objects.map((o) => (
          <div
            key={o.id}
            className={`sim-object kind-${o.kind}`}
            style={{ left: sx(o.box.x), top: sy(o.box.y), width: sx(o.box.w), height: o.box.h * surface.mmPerPx * k }}
            onPointerDown={onDown(o)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            title={`${o.id}: drag to move`}
          >
            <ObjectVisual o={o} visual={visuals[o.id]} />
          </div>
        ))}

        {/* The projection: light added on top of the table and the objects. */}
        <div className="sim-projection" style={{ left: 0, top: projTop * k, width: projW * k, height: projH * k }}>
          <div className="sim-black-level" />
          {/* The same surface layer /table runs, with the bench's own render
              as the answer; "outlines" also shows kinds that have no
              renderer yet. */}
          <SurfaceLayer
            surfaces={answer.set}
            surface={surface}
            debug={showOutlines}
            renderers={{
              web: (x) => webRenderer(x, surface, postWebInput),
              launcher: (x) => launcherRenderer(x, surface),
              asset: (x) => assetRenderer(x, surface),
              drawing: (x) => drawingRenderer(x, surface),
              answer: () => <StageView events={events} renderKey={renderKey} scene={scene} speed={speed} onAction={onAction} showObjects={showOutlines} panelOffset={answer.offset} transparent />,
              // The runtime's keyboard (#29), drawn exactly as /table draws it.
              keyboard: keyboard ?? ((s) => <KeyboardSurface s={s} surface={surface} />),
            }}
          />
          <OverlayLayer lines={overlays} surface={surface} />
          {/* The same ripple /table draws, so lidar touch can be seen without the projector. */}
          <TouchRipples surface={surface} />
          {projected}
        </div>
        {showOutlines && <div className="sim-projection-edge" style={{ top: projTop * k, width: projW * k, height: projH * k }} />}

        <div className="sim-scale" style={{ width: tenCm }}>
          10 cm
        </div>
        <div className="sim-user">you sit here · 150 × 150 cm table · lit area {Math.round(projW / 10)} × {Math.round(projH / 10)} cm</div>
      </div>
    </div>
  )
}

function ObjectVisual({ o, visual }: { o: SceneObject; visual?: SimObjectVisual }) {
  switch (o.kind) {
    case 'notebook':
    case 'paper':
    case 'book':
      return visual?.photo ? <img src={visual.photo} alt="" draggable={false} /> : <div className="sim-paper" />
    case 'cup':
      return <div className="sim-cup" />
    case 'keyboard':
      return <MiniLabVisual />
    default:
      return <div className="sim-paper" />
  }
}

/**
 * A top-down Arturia MiniLab 3 at real proportions: white body, pad row, and
 * 25 keys (15 white) on the near part, where packages/room's MINILAB_BODY says
 * the keybed is, so the lesson's light lands on the drawn keys exactly as it
 * will on the real ones.
 */
function MiniLabVisual() {
  const W = 355
  const H = 220
  const kb = { x0: 0.02 * W, x1: 0.98 * W, y0: 0.5 * H, y1: 0.96 * H }
  const ww = (kb.x1 - kb.x0) / 15
  const blackAfter = [0, 1, 3, 4, 5, 7, 8, 10, 11, 12] // white-key index after which a black key sits
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none">
      <rect x="0" y="0" width={W} height={H} rx="10" fill="#e8e6e1" />
      {Array.from({ length: 8 }, (_, i) => (
        <rect key={`p${i}`} x={60 + i * 34} y={0.3 * H} width="26" height="26" rx="4" fill="#1a1a1d" stroke={['#ff4d4d', '#ff8a3d', '#ffb13d', '#ffd23d', '#f2f23d', '#d6ff3d', '#a8ff3d', '#7dff3d'][i]} strokeWidth="2" />
      ))}
      {Array.from({ length: 8 }, (_, i) => (
        <circle key={`k${i}`} cx={130 + (i % 4) * 34} cy={i < 4 ? 22 : 50} r="10" fill="#f4f3ef" stroke="#c8c6c0" />
      ))}
      <text x="22" y={0.46 * H} fontSize="10" fill="#333" fontFamily="sans-serif">MINILAB 3</text>
      {Array.from({ length: 15 }, (_, i) => (
        <rect key={`w${i}`} x={kb.x0 + i * ww + 0.6} y={kb.y0} width={ww - 1.2} height={kb.y1 - kb.y0} rx="1.5" fill="#f7f6f2" stroke="#b9b7b1" strokeWidth="0.8" />
      ))}
      {blackAfter.map((i) => (
        <rect key={`b${i}`} x={kb.x0 + (i + 1) * ww - ww * 0.29} y={kb.y0} width={ww * 0.58} height={(kb.y1 - kb.y0) * 0.62} rx="1" fill="#141416" />
      ))}
    </svg>
  )
}
