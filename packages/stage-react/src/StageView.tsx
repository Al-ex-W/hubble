import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { DEFAULT_SURFACE, clearances, typeScale, type Box, type Scene, type StageEvent } from '@hubble/stage'
import { createDirector, type Director, type DirectorState, type StageNode } from './director.ts'
import { MathInk } from './math/MathInk.tsx'
import { Plot } from './plot/Plot.tsx'
import { AssetView } from './AssetView.tsx'
import { SPATIAL_TAGS, edgePoint, findObject, objectRect, resolveEndpoint, resolvePanels, type Point } from '@hubble/stage'
import './styles.css'

/**
 * The table projection, in the projector's own pixels (the Scene's surface).
 *
 * It only ever receives finished pieces (StageEvents) and never sees model
 * text. Where things go is the model's choice (Panel x/y/near, Mark on an
 * object); `layout.ts` only enforces the physical rules. Sizes come from the
 * surface's real scale, so text is the same physical size on any projector.
 */
export interface StageViewProps {
  /** Every event of the current render so far, in arrival order. Append-only within one renderKey. */
  events: StageEvent[]
  /** Changing it resets the stage (a new answer replaces the old one). */
  renderKey: string
  /** The physical table. Positions in events are resolved against it. */
  scene?: Scene
  /** A projected Button was tapped (clicked in the preview). */
  onAction?: (action: string) => void
  /** Director time scale. 1 = normal pacing, 0.25 = slow motion for tuning. */
  speed?: number
  /** Draw object outlines (debugging layouts without a camera). */
  showObjects?: boolean
  /**
   * Raspberry Pi mode: no glow filters or soft shadows. Chromium on the Pi
   * repaints every blurred, drop-shadowed element on each animation frame,
   * which is what made the table stutter; the bench on a laptop can keep them.
   */
  lite?: boolean
  /**
   * How far the answer surface has been moved on the table (surface px). It
   * moves the panels and the arrows anchored to them, and nothing tied to a
   * physical object: a Mark circles a task on the real notebook page, so it
   * must stay on the page when the answer's panels are pushed aside. Layout is
   * still resolved where the brain verified it, then shifted as a whole, so a
   * moved answer keeps its own internal arrangement.
   */
  panelOffset?: { x: number; y: number }
  /**
   * Paint only the answer's own content, not the table-wide black. Needed
   * when the answer is one surface among others (SurfaceLayer): the frame
   * spans the whole table, and its opaque black covered every surface below
   * it, even an asset nowhere near the answer's panels (review #43). The
   * host keeps the projector's black behind the whole layer instead.
   */
  transparent?: boolean
}

const EMPTY_SCENE: Scene = { surface: DEFAULT_SURFACE, objects: [] }
const EMPTY_STATE: DirectorState = { nodes: new Map(), roots: [], settlesAt: 0 }

/**
 * A clock that ticks only when something new is due to appear.
 *
 * Every entrance is a CSS animation, so between two reveals nothing on the
 * table depends on JavaScript time. The old clock re-rendered the whole
 * surface every animation frame until the answer settled, which on the Pi
 * meant rebuilding every panel 60 times a second for ~10 s per answer (#17).
 */
function useRevealClock(state: DirectorState, version: number): number {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    let next = Infinity
    for (const n of state.nodes.values()) {
      if (n.revealAt > now && n.revealAt < next) next = n.revealAt
      for (const w of n.words) if (w.revealAt > now && w.revealAt < next) next = w.revealAt
    }
    if (next === Infinity) return
    const timer = setTimeout(() => setNow(performance.now()), Math.max(0, next - performance.now()))
    return () => clearTimeout(timer)
  }, [state, version, now])
  return now
}

interface Slot {
  key: string
  speed: number
  d: Director
  consumed: number
}

export function StageView({ events, renderKey, scene = EMPTY_SCENE, onAction, speed = 1, showObjects = false, lite = false, panelOffset, transparent = false }: StageViewProps) {
  // The director is fed in a layout effect, not during render: a render React
  // throws away (StrictMode, a concurrent restart) must not have scheduled
  // anything. The layout effect runs before paint, so the first frame still
  // shows the new events; `version` re-renders with what it scheduled.
  const slotRef = useRef<Slot | null>(null)
  const [version, setVersion] = useState(0)
  useLayoutEffect(() => {
    let slot = slotRef.current
    if (!slot || slot.key !== renderKey || slot.speed !== speed) {
      slot = { key: renderKey, speed, d: createDirector({ speed }), consumed: 0 }
      slotRef.current = slot
    }
    if (events.length > slot.consumed) {
      slot.d.push(events.slice(slot.consumed), performance.now())
      slot.consumed = events.length
      setVersion((v) => v + 1)
    }
  }, [events, renderKey, speed])
  const current = slotRef.current
  // Until the effect has swapped directors, the previous answer's state must
  // not be drawn under the new key (its ids would collide with the new ones).
  const state = current && current.key === renderKey && current.speed === speed ? current.d.state : EMPTY_STATE
  const now = useRevealClock(state, version)
  const { surface } = scene
  const type = typeScale(surface)

  // Fit the surface into whatever box the host gives us.
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const el = frameRef.current
    if (!el) return
    const fit = () => setScale(el.clientWidth / surface.widthPx)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [surface.widthPx])

  // Measured panel heights (surface px), scoped to the answer they were
  // measured in. Parser ids restart for every answer ("e3" again), so heights
  // kept across a renderKey change would size the next answer's panels with
  // the last answer's content (#17).
  const [measured, setMeasured] = useState<{ key: string; h: Record<string, number> }>({ key: renderKey, h: {} })
  const keyRef = useRef(renderKey)
  useLayoutEffect(() => {
    keyRef.current = renderKey
  }, [renderKey])
  const observer = useRef<ResizeObserver | null>(null)
  useEffect(() => {
    observer.current = new ResizeObserver((entries) => {
      setMeasured((prev) => {
        const key = keyRef.current
        let h = prev.key === key ? prev.h : {}
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.panel!
          const px = Math.round((e.target as HTMLElement).offsetHeight)
          if (px > 0 && h[id] !== px) h = { ...h, [id]: px }
        }
        return h === prev.h && prev.key === key ? prev : { key, h }
      })
    })
    return () => observer.current?.disconnect()
  }, [])
  const measure = (el: HTMLElement | null) => {
    if (el) observer.current?.observe(el)
  }
  const heights = measured.key === renderKey ? measured.h : undefined

  const node = (id: string) => state.nodes.get(id)
  const visible = (n: StageNode) => now >= n.revealAt

  // ---- layout: the same geometry the brain verified ----
  // resolvePanels is what layoutReport judged, so a verified answer is drawn
  // exactly where it was verified; measured heights only matter once a panel
  // outgrows its estimate. Pure, so nothing is remembered between renders.
  const ox = panelOffset?.x ?? 0
  const oy = panelOffset?.y ?? 0
  const geometry = useMemo(() => {
    const resolved = resolvePanels(events, scene, heights)
    if (!ox && !oy) return resolved
    // Shift after resolving, never before: the placement guard decided these
    // boxes against the objects at their true positions.
    return resolved.map((g) => ({ ...g, placed: { ...g.placed, x: g.placed.x + ox, y: g.placed.y + oy } }))
  }, [events, scene, heights, ox, oy])
  const byName = new Map<string, Box>()
  for (const g of geometry) if (g.name) byName.set(g.name, g.placed)
  const spatial: StageNode[] = []
  for (const rootId of state.roots) {
    const root = node(rootId)
    if (!root || root.tag !== 'Canvas') continue
    for (const id of root.children) {
      const k = node(id)
      // SPATIAL_TAGS is the report's own set, so a Canvas child is drawn on
      // the table here exactly when resolvePanels kept it out of the implicit
      // panel. Panels are drawn from `geometry` instead, hence the exclusion.
      if (k && SPATIAL_TAGS.has(k.tag) && k.tag !== 'Panel') spatial.push(k)
    }
  }

  // ---- flow content inside panels ----
  const enterStyle = (n: StageNode) => ({ '--fx-duration': `${n.duration}ms` }) as CSSProperties
  const renderFlow = (n: StageNode, index: number, siblings: StageNode[]): ReactNode => {
    if (!visible(n)) return null
    const kids = n.children.map(node).filter((k): k is StageNode => Boolean(k))
    const children = kids.map((k, i) => renderFlow(k, i, kids))
    switch (n.tag) {
      case 'Heading':
        return (
          <h2 key={n.id} className="st-heading fx-glitch" style={enterStyle(n)}>
            {n.body.trim()}
          </h2>
        )
      case 'Text':
      case 'Item':
      case 'Note':
      case 'Cell': {
        const words = n.words.filter((w) => now >= w.revealAt).map((w, i) => (
          <span key={i} className="st-word fx-word">
            {w.text}
          </span>
        ))
        if (n.tag === 'Item') return <li key={n.id} className="st-item">{words}</li>
        if (n.tag === 'Cell') return <td key={n.id}>{words}</td>
        if (n.tag === 'Note')
          return (
            <aside key={n.id} className={`st-note kind-${(n.attrs.kind as string) ?? 'tip'} fx-scan`} style={{ ['--fx-duration' as string]: '420ms' }}>
              <span className="st-note-icon">{{ tip: '✦', warning: '!', check: '✓' }[(n.attrs.kind as string) ?? 'tip'] ?? '✦'}</span>
              <span>{words}</span>
            </aside>
          )
        return (
          <p key={n.id} className={`st-text tone-${(n.attrs.tone as string) ?? 'normal'}`}>
            {words}
          </p>
        )
      }
      case 'Math':
        return (
          <div key={n.id} className={`st-math${n.attrs.highlight ? ' is-answer' : ''}`}>
            <MathInk tex={n.body.trim()} duration={n.duration} highlight={Boolean(n.attrs.highlight)} />
          </div>
        )
      case 'Equations':
        return (
          <div key={n.id} className={`st-math st-equations${n.attrs.highlight ? ' is-answer' : ''}`}>
            <MathInk tex={`\\begin{aligned}${n.body.trim()}\\end{aligned}`} duration={n.duration} highlight={Boolean(n.attrs.highlight)} />
          </div>
        )
      case 'Steps':
        return (
          <ol key={n.id} className="st-steps">
            {children}
          </ol>
        )
      case 'Step': {
        const num = siblings.slice(0, index + 1).filter((s) => s.tag === 'Step').length
        return (
          <li key={n.id} className={`st-step${n.attrs.highlight ? ' is-highlight' : ''}`}>
            <span className="st-step-n fx-pop" style={enterStyle(n)}>
              {num}
            </span>
            <div className="st-step-body">{children}</div>
          </li>
        )
      }
      case 'List':
        return (
          <ul key={n.id} className="st-list">
            {children}
          </ul>
        )
      case 'Table': {
        const [head, ...rows] = kids.filter((k) => visible(k))
        return (
          <table key={n.id} className="st-table">
            {head && <thead>{renderFlow(head, 0, kids)}</thead>}
            <tbody>{rows.map((r, i) => renderFlow(r, i + 1, kids))}</tbody>
          </table>
        )
      }
      case 'Row':
        return <tr key={n.id}>{children}</tr>
      case 'Columns':
        return (
          <div key={n.id} className="st-columns">
            {children}
          </div>
        )
      case 'Column':
        return (
          <div key={n.id} className="st-column">
            {children}
          </div>
        )
      case 'Asset': {
        // The parser only lets through ids the library has (catalogFor), and
        // the scene carries the library; a missing entry draws nothing rather
        // than a broken image.
        const a = scene.assets?.find((x) => x.id === n.attrs.id)
        return a ? <AssetView key={n.id} asset={a} /> : null
      }
      case 'Plot':
        return (
          <Plot
            key={n.id}
            fn={String(n.attrs.fn)}
            xmin={n.attrs.xmin as number | undefined}
            xmax={n.attrs.xmax as number | undefined}
            ymin={n.attrs.ymin as number | undefined}
            ymax={n.attrs.ymax as number | undefined}
            points={n.attrs.points as string | undefined}
            label={n.attrs.label as string | undefined}
            duration={n.duration}
          />
        )
      case 'Button':
        return (
          <button key={n.id} type="button" className="st-button fx-scan" style={enterStyle(n)} onClick={() => onAction?.(String(n.attrs.action))}>
            {n.body.trim() || String(n.attrs.action)}
          </button>
        )
      default:
        return null
    }
  }

  // ---- light on the table itself: marks, arrows, labels ----
  const center = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
  const overlay: ReactNode[] = []
  const labels: ReactNode[] = []
  for (const n of spatial) {
    if (!visible(n)) continue
    const draw = { animation: `st-draw ${n.duration}ms cubic-bezier(0.4, 0, 0.2, 1) both` }
    if (n.tag === 'Mark' || n.tag === 'Highlight') {
      const o = findObject(scene, String(n.attrs.target ?? 'notebook'))
      if (!o) continue
      const shape = n.tag === 'Highlight' ? 'glow' : String(n.attrs.shape ?? 'circle')
      const r =
        shape === 'glow'
          ? { x: o.box.x - 14, y: o.box.y - 14, w: o.box.w + 28, h: o.box.h + 28 }
          : objectRect(o, n.attrs.u as number, n.attrs.v as number, n.attrs.w as number, n.attrs.h as number)
      // pathLength=1 on each shape lets one keyframe draw any outline on.
      const sp = { pathLength: 1, style: draw }
      let el: ReactNode
      switch (shape) {
        case 'underline':
          el = <path {...sp} d={`M${r.x},${r.y + r.h} q${r.w / 2},${r.h * 0.25} ${r.w},0`} />
          break
        case 'box':
        case 'glow':
          el = <rect {...sp} x={r.x} y={r.y} width={r.w} height={r.h} rx={shape === 'glow' ? 18 : 8} />
          break
        case 'check':
          el = <path {...sp} d={`M${r.x},${r.y + r.h * 0.55} L${r.x + r.w * 0.38},${r.y + r.h} L${r.x + r.w},${r.y}`} />
          break
        case 'cross':
          el = <path {...sp} d={`M${r.x},${r.y} L${r.x + r.w},${r.y + r.h} M${r.x + r.w},${r.y} L${r.x},${r.y + r.h}`} />
          break
        default:
          el = <ellipse {...sp} cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={r.w / 2 + 10} ry={r.h / 2 + 8} />
      }
      overlay.push(
        <g key={n.id} className={`st-mark shape-${shape}`}>
          {el}
        </g>,
      )
      if (n.attrs.label)
        labels.push(
          <div key={`${n.id}-l`} className="st-label tone-answer fx-blur" style={{ left: r.x + r.w + 16, top: r.y + r.h / 2 - type.small * 0.7 }}>
            {String(n.attrs.label)}
          </div>,
        )
    } else if (n.tag === 'Arrow') {
      const a = resolveEndpoint(String(n.attrs.from), scene, byName)
      const b = resolveEndpoint(String(n.attrs.to), scene, byName)
      if (!a || !b) continue
      const ca = a.kind === 'point' ? a.point : center(a.box)
      const cb = b.kind === 'point' ? b.point : center(b.box)
      const p1 = a.kind === 'box' ? edgePoint(a.box, cb) : ca
      const p2 = b.kind === 'box' ? edgePoint(b.box, ca) : cb
      // A gentle curve reads as hand-drawn; a straight line reads as UI.
      const mx = (p1.x + p2.x) / 2 - (p2.y - p1.y) * 0.15
      const my = (p1.y + p2.y) / 2 + (p2.x - p1.x) * 0.15
      overlay.push(
        <path key={n.id} className="st-arrow" d={`M${p1.x},${p1.y} Q${mx},${my} ${p2.x},${p2.y}`} pathLength={1} markerEnd="url(#st-arrowhead)" style={draw} />,
      )
      if (n.attrs.label)
        labels.push(
          <div key={`${n.id}-l`} className="st-label tone-muted fx-blur" style={{ left: mx, top: my - type.small }}>
            {String(n.attrs.label)}
          </div>,
        )
    } else if (n.tag === 'Label') {
      const o = findObject(scene, n.attrs.target as string | undefined)
      const x = o ? o.box.x + Number(n.attrs.u ?? 0.5) * o.box.w : Number(n.attrs.x ?? 0)
      const y = o ? o.box.y + Number(n.attrs.v ?? -0.08) * o.box.h : Number(n.attrs.y ?? 0)
      labels.push(
        <div key={n.id} className={`st-label tone-${(n.attrs.tone as string) ?? 'accent'}`} style={{ left: x, top: y, transform: o ? 'translateX(-50%)' : undefined }}>
          {n.words
            .filter((w) => now >= w.revealAt)
            .map((w, i) => (
              <span key={i} className="st-word fx-word">
                {w.text}
              </span>
            ))}
        </div>,
      )
    }
  }

  const vars = {
    width: surface.widthPx,
    height: surface.heightPx,
    transform: `scale(${scale})`,
    '--st-body': `${type.body}px`,
    '--st-small': `${type.small}px`,
    '--st-heading': `${type.heading}px`,
    '--st-mathsize': `${type.math}px`,
  } as CSSProperties

  return (
    <div ref={frameRef} className={`st-frame${lite ? ' st-lite' : ''}`} style={{ aspectRatio: `${surface.widthPx} / ${surface.heightPx}`, ...(transparent ? { background: 'transparent' } : null) }}>
      <div className="st-surface" style={vars}>
        {showObjects &&
          scene.objects.map((o) => (
            <div key={o.id} className="st-object-outline" style={{ left: o.box.x, top: o.box.y, width: o.box.w, height: o.box.h }}>
              {o.id}
            </div>
          ))}
        {geometry.map((g) => {
          const owner = node(g.node)
          if (!owner || !visible(owner)) return null
          const kids = g.children.map((c) => node(c.id)).filter((k): k is StageNode => Boolean(k))
          return (
            <section
              key={g.node}
              ref={measure}
              data-panel={g.node}
              className="st-panel fx-scan"
              // Overflow policy: a panel never runs off the table. placePanel
              // caps the box at the table height and the rest is clipped; the
              // report flags such an answer (off-surface) before it gets here.
              style={{ left: g.placed.x, top: g.placed.y, width: g.placed.w, maxHeight: surface.heightPx - 2 * clearances(surface).edge, ['--fx-duration' as string]: '700ms' }}
            >
              <span className="st-corner tl" />
              <span className="st-corner tr" />
              <span className="st-corner bl" />
              <span className="st-corner br" />
              <div className="st-panel-body">{kids.map((k, i) => renderFlow(k, i, kids))}</div>
            </section>
          )
        })}
        <svg className="st-overlay" width={surface.widthPx} height={surface.heightPx} viewBox={`0 0 ${surface.widthPx} ${surface.heightPx}`}>
          <defs>
            <marker id="st-arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" />
            </marker>
          </defs>
          {overlay}
        </svg>
        {labels}
      </div>
    </div>
  )
}
