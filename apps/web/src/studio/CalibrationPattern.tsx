import { DEFAULT_SURFACE, patternGeometry, type Surface } from './calibrationGeometry.ts'

/**
 * The calibration pattern the projector shows in `calibrate` mode.
 *
 * Why an SVG in the surface's own pixel space: the viewBox is exactly
 * widthPx x heightPx, so on a 1920 x 1200 kiosk one SVG unit is one projector
 * pixel and the 2 px border is two real pixels. In any other window it scales
 * uniformly (letterboxed, never stretched: the pattern's job is to expose a
 * wrong aspect, not to cause one).
 *
 * Why black with only white/periwinkle lines: black is no light on a
 * projector, so the table stays dark except for the marks; coloured fills
 * would also wash out the tape marks the person is aligning to.
 *
 * Every size is mm converted through the Surface (calibrationGeometry.ts); the
 * only pixel constants are the border and corner markers, which are about the
 * frame's pixels on purpose.
 */
const WHITE = '#ffffff'
const PERIWINKLE = '#aab4ff'
const FONT_MM = 14 // legible at ~17 px, still a physical size on the table

export function CalibrationPattern({ surface = DEFAULT_SURFACE, since = '' }: { surface?: Surface; since?: string }) {
  const g = patternGeometry(surface)
  const { widthPx: W, heightPx: H, mmPerPx } = g
  const font = g.px(FONT_MM)
  const text = (extra: object = {}) => ({ fill: WHITE, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: font, ...extra })
  const markArm = g.px(30)
  const markRadius = g.px(20)
  const arm = 60 // corner arms, px: about the frame, not the table
  const fmt = (n: number) => (Math.round(n * 10) / 10).toString()

  return (
    <div className="calibration-pattern" data-calibration-pattern style={{ position: 'fixed', inset: 0, zIndex: 100000, background: '#000', display: 'grid', placeItems: 'center' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100vw', height: '100vh', display: 'block' }}
        preserveAspectRatio="xMidYMid meet"
        shapeRendering="crispEdges"
        role="img"
        aria-label="Projector calibration pattern"
      >
        <rect x={0} y={0} width={W} height={H} fill="#000" />

        {/* 100 mm grid (thin) and 500 mm lines (thick, labelled in mm from the top-left). */}
        <g data-role="grid">
          {g.vertical.map((l) => (
            <g key={`v${l.mm}`}>
              <line data-role={l.major ? 'major-v' : 'minor-v'} data-mm={l.mm} x1={l.px} y1={0} x2={l.px} y2={H} stroke={PERIWINKLE} strokeOpacity={l.major ? 0.9 : 0.3} strokeWidth={l.major ? 2 : 1} />
              {l.major && l.mm > 0 && <text {...text({ fill: PERIWINKLE })} x={l.px + 6} y={font + 8} data-role="grid-label">{l.mm} mm</text>}
            </g>
          ))}
          {g.horizontal.map((l) => (
            <g key={`h${l.mm}`}>
              <line data-role={l.major ? 'major-h' : 'minor-h'} data-mm={l.mm} x1={0} y1={l.px} x2={W} y2={l.px} stroke={PERIWINKLE} strokeOpacity={l.major ? 0.9 : 0.3} strokeWidth={l.major ? 2 : 1} />
              {l.major && l.mm > 0 && <text {...text({ fill: PERIWINKLE })} x={8} y={l.px - 6} data-role="grid-label">{l.mm} mm</text>}
            </g>
          ))}
        </g>

        {/* Border exactly at the frame edge: a 2 px stroke centred 1 px in covers pixels 0-1 and W-2..W-1. */}
        <rect data-role="border" x={1} y={1} width={W - 2} height={H - 2} fill="none" stroke={WHITE} strokeWidth={2} />

        {g.corners.map((c) => {
          // Stroke 6 px centred 3 px in, so the L covers the 6 outermost pixels and sits on the border.
          const cx = c.edgeX + c.sx * 3
          const cy = c.edgeY + c.sy * 3
          const anchorEnd = c.sx < 0
          return (
            <g key={c.label} data-role="corner" data-label={c.label} data-px-x={c.x} data-px-y={c.y}>
              <path d={`M ${cx + c.sx * arm} ${cy} L ${cx} ${cy} L ${cx} ${cy + c.sy * arm}`} fill="none" stroke={WHITE} strokeWidth={6} />
              <text {...text()} x={c.edgeX + c.sx * (arm + 14)} y={c.edgeY + c.sy * 40} textAnchor={anchorEnd ? 'end' : 'start'}>{c.label}</text>
            </g>
          )
        })}

        <g data-role="centre" data-px-x={g.centre.x} data-px-y={g.centre.y}>
          <line x1={g.centre.x - 40} y1={g.centre.y + 0.5} x2={g.centre.x + 40} y2={g.centre.y + 0.5} stroke={WHITE} strokeWidth={2} />
          <line x1={g.centre.x + 0.5} y1={g.centre.y - 40} x2={g.centre.x + 0.5} y2={g.centre.y + 40} stroke={WHITE} strokeWidth={2} />
          <text {...text()} x={g.centre.x + 50} y={g.centre.y - 8}>({g.centre.x},{g.centre.y})</text>
        </g>

        {g.rulers.map((r) => {
          const horizontal = r.orientation === 'h'
          const x2 = horizontal ? r.x + r.lengthPx : r.x
          const y2 = horizontal ? r.y : r.y + r.lengthPx
          return (
            <g key={r.orientation} data-role="ruler" data-orientation={r.orientation} data-mm={r.mm} data-length-px={r.lengthPx}>
              <line x1={r.x} y1={r.y} x2={x2} y2={y2} stroke={WHITE} strokeWidth={4} />
              {/* End ticks make the measured length unambiguous. */}
              {horizontal ? (
                <>
                  <line x1={r.x} y1={r.y - 12} x2={r.x} y2={r.y + 12} stroke={WHITE} strokeWidth={2} />
                  <line x1={x2} y1={r.y - 12} x2={x2} y2={r.y + 12} stroke={WHITE} strokeWidth={2} />
                </>
              ) : (
                <>
                  <line x1={r.x - 12} y1={r.y} x2={r.x + 12} y2={r.y} stroke={WHITE} strokeWidth={2} />
                  <line x1={r.x - 12} y1={y2} x2={r.x + 12} y2={y2} stroke={WHITE} strokeWidth={2} />
                </>
              )}
              <text {...text()} x={horizontal ? r.x : r.x + 18} y={horizontal ? r.y + 34 : r.y + 18} data-role="ruler-label">{r.mm} mm</text>
              <text {...text({ fill: PERIWINKLE, fontSize: font * 0.85 })} x={horizontal ? r.x : r.x + 18} y={horizontal ? r.y + 34 + font * 1.2 : r.y + 18 + font * 1.2}>should measure {r.mm} mm on the table</text>
              <text {...text({ fill: PERIWINKLE, fontSize: font * 0.85 })} x={horizontal ? r.x : r.x + 18} y={horizontal ? r.y + 34 + font * 2.3 : r.y + 18 + font * 2.3}>if not, mm/px is wrong ({mmPerPx.toFixed(4)} mm/px)</text>
            </g>
          )
        })}

        {g.marks.map((m) => (
          <g key={m.n} data-role="mark" data-mark={m.n} data-mm-x={fmt(m.mmX)} data-mm-y={fmt(m.mmY)} data-px-x={m.px} data-px-y={m.py}>
            <circle cx={m.px} cy={m.py} r={markRadius} fill="none" stroke={WHITE} strokeWidth={2} />
            <line x1={m.px - markArm} y1={m.py} x2={m.px + markArm} y2={m.py} stroke={WHITE} strokeWidth={2} />
            <line x1={m.px} y1={m.py - markArm} x2={m.px} y2={m.py + markArm} stroke={WHITE} strokeWidth={2} />
            <text {...text({ fontWeight: 700, fontSize: font * 1.6 })} x={m.px + markRadius + 8} y={m.py - markRadius}>{m.n}</text>
            <text {...text({ fontSize: font * 0.85 })} x={m.px + markRadius + 8} y={m.py + markRadius + font * 0.3}>{fmt(m.mmX)}, {fmt(m.mmY)} mm</text>
          </g>
        ))}

        <g data-role="legend">
          <text {...text({ fill: PERIWINKLE })} x={g.px(420)} y={g.px(905)}>{`surface ${fmt(g.widthMm)} x ${fmt(g.heightMm)} mm  |  ${W} x ${H} px  |  ${mmPerPx.toFixed(4)} mm/px`}</text>
          <text {...text({ fill: PERIWINKLE })} x={g.px(420)} y={g.px(905) + font * 1.4}>{`calibrate mode since ${since || 'forced by ?calibrate=1'}`}</text>
        </g>
      </svg>
    </div>
  )
}
