import type { ReactNode } from 'react'
import type { Surface, TableSurface } from '@hubble/stage'
import { buildLayout, SLOT_ORDER, SWIPE_KEYBOARD_MM, WIDGET, type Key, type KeyboardSurfaceState, type Pt } from '@hubble/stage/swipe'
import { BoxFrame } from './SurfaceLayer.tsx'
import './keyboard.css'

/**
 * The swipe keyboard's face: text line, three candidates, the keys, drawn as
 * projected light from a state. No input, no rules.
 *
 * Why it is separate from the bench's interactive SwipeKeyboard: on the table
 * the keyboard is a surface whose state the runtime owns (#29); every display
 * (/table on the Pi, the bench's table simulator) only draws what the server
 * says. Input reaches the runtime from wherever the pen is, never from this
 * drawing. The bench's SwipeKeyboard draws with this same face, so there is
 * one look, not two drifting copies.
 *
 * Everything is in mm: the SVG's viewBox is the widget in millimetres
 * (SWIPE_KEYBOARD_MM), so the keys stay 44 mm whatever box it is drawn in.
 */
const layout = buildLayout()
const W = SWIPE_KEYBOARD_MM.w
const H = SWIPE_KEYBOARD_MM.h
const KB_Y = WIDGET.keysY
const TEXT_H = WIDGET.textLine.h
const CAND_Y = WIDGET.candidates.y + KB_Y
const CAND_H = WIDGET.candidates.h
// Keys are drawn inset from their cell, so neighbouring outlines never touch
// (on a projection two touching hairlines read as one thick line). Shared
// with the hand tracker's calibration, which taps the caps' corners.
const GAP = WIDGET.capGap
// About what fits in the text line at its font size.
const MAX_LINE = 44
const TRAIL_POINTS = 70

export interface KeyboardFaceProps {
  state: Pick<KeyboardSurfaceState, 'text' | 'candidates' | 'sent'>
  /** Keys crossed by the stroke being drawn (local to whoever holds the pen). */
  lit?: ReadonlySet<string>
  /** The key under the pen right now. */
  hot?: string | null
  /** The stroke being drawn, in keyboard mm; fades when `swiping` ends. */
  trail?: readonly Pt[]
  swiping?: boolean
  /** Drawn last, inside the SVG's mm frame: the bench's pointer hit area. */
  overlay?: ReactNode
  className?: string
  style?: React.CSSProperties
}

export function KeyboardFace({ state, lit, hot = null, trail = [], swiping = false, overlay, className = 'swk', style }: KeyboardFaceProps) {
  const { text, candidates, sent } = state
  // The best candidate sits in the middle, where the eye already is after
  // reading the text line (keyboard.ts SLOT_ORDER, shared with the hit-test).
  const slots = SLOT_ORDER.map((i) => candidates[i])
  const tail = trail.slice(-TRAIL_POINTS)
  return (
    <svg className={className} viewBox={`0 0 ${W} ${H}`} style={style} data-keyboard-face>
      <defs>
        <filter id="swk-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>

      {/* The text line: what will be sent. */}
      <g className="swk-line">
        {text ? (
          <text x={10} y={TEXT_H - 12} className="swk-text">
            {/* The line is one keyboard wide; a long message shows its end,
                which is where the next word goes. */}
            {text.length > MAX_LINE ? `…${text.slice(-(MAX_LINE - 1))}` : text}
            <tspan className="swk-caret">▍</tspan>
          </text>
        ) : (
          <text x={10} y={TEXT_H - 12} className="swk-placeholder">
            swipe to talk to hubble
          </text>
        )}
        {/* Keyed by the send count, so the lift-off plays once per send and
            not again when a reconnecting display gets the same set. */}
        {sent && (
          <text key={sent.n} x={10} y={TEXT_H - 12} className="swk-text swk-sent">
            {sent.text}
          </text>
        )}
        <line x1={0} x2={W} y1={TEXT_H} y2={TEXT_H} className="swk-rule" />
        <Brackets x={0} y={0} w={W} h={TEXT_H} />
      </g>

      {/* Candidates: best in the middle. */}
      <g className="swk-cands">
        {slots.map((word, i) => {
          const w = W / 3
          return (
            <g key={i} className={`swk-cand${i === 1 ? ' best' : ''}${word ? '' : ' empty'}`}>
              <rect x={i * w} y={CAND_Y} width={w} height={CAND_H} className="swk-cand-hit" />
              {word && (
                <text x={i * w + w / 2} y={CAND_Y + CAND_H / 2 + 4} textAnchor="middle">
                  {word}
                </text>
              )}
              {i > 0 && <line x1={i * w} x2={i * w} y1={CAND_Y + 8} y2={CAND_Y + CAND_H - 8} className="swk-divider" />}
            </g>
          )
        })}
      </g>

      {/* Keys, and the trail of the stroke being drawn. */}
      <g transform={`translate(0 ${KB_Y})`}>
        {layout.keys.map((k) => (
          <KeyCap key={k.id} k={k} lit={lit?.has(k.id) ?? false} hot={hot === k.id} />
        ))}
        {tail.length > 1 && (
          <g className={`swk-trail${swiping ? '' : ' gone'}`}>
            <polyline points={tail.map((p) => `${p.x},${p.y}`).join(' ')} className="swk-trail-halo" filter="url(#swk-glow)" />
            {tail.slice(1).map((p, i) => (
              <line key={i} x1={tail[i]!.x} y1={tail[i]!.y} x2={p.x} y2={p.y} className="swk-trail-line" style={{ opacity: (i + 1) / tail.length }} />
            ))}
            <circle cx={tail[tail.length - 1]!.x} cy={tail[tail.length - 1]!.y} r={3.2} className="swk-tip" />
          </g>
        )}
      </g>
      {overlay}
    </svg>
  )
}

/**
 * The `keyboard` surface's renderer for SurfaceLayer: the face drawn in the
 * surface's box. The box's px size was made from the widget's mm by the
 * runtime, so filling it keeps the keys 44 mm on the table.
 */
export function KeyboardSurface({ s, surface }: { s: TableSurface; surface: Surface }) {
  const st = s.state as Partial<KeyboardSurfaceState>
  // A state that doesn't look like a keyboard's (an older server, a half
  // update) draws an empty board rather than throwing on the table.
  const state = { text: typeof st.text === 'string' ? st.text : '', candidates: Array.isArray(st.candidates) ? st.candidates.filter((c): c is string => typeof c === 'string') : [], sent: validSent(st.sent) }
  return (
    <BoxFrame box={s.box} surface={surface}>
      <KeyboardFace state={state} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }} />
    </BoxFrame>
  )
}

/** A send marker drawn only if it is one: a malformed one must not throw on the table (review #47). */
function validSent(v: unknown): KeyboardSurfaceState['sent'] {
  const x = v as { n?: unknown; text?: unknown } | null | undefined
  return x && typeof x.n === 'number' && typeof x.text === 'string' ? { n: x.n, text: x.text } : null
}

function KeyCap({ k, lit, hot }: { k: Key; lit: boolean; hot: boolean }) {
  const x = k.x + GAP
  const y = k.y + GAP
  const w = k.w - 2 * GAP
  const h = k.h - 2 * GAP
  const cx = x + w / 2
  const cy = y + h / 2
  return (
    <g className={`swk-key kind-${k.kind}${lit ? ' lit' : ''}${hot ? ' hot' : ''}`} data-key={k.id}>
      <rect x={x} y={y} width={w} height={h} rx={6} />
      {k.kind === 'letter' && (
        <text x={cx} y={cy + 5} textAnchor="middle">
          {k.label.toUpperCase()}
        </text>
      )}
      {k.kind === 'space' && <path d={`M ${cx - 22} ${cy - 3} v 6 h 44 v -6`} className="swk-glyph" />}
      {k.kind === 'delete' && (
        <path d={`M ${cx - 16} ${cy} l 8 -8 h 22 v 16 h -22 z M ${cx - 1} ${cy - 4} l 8 8 M ${cx + 7} ${cy - 4} l -8 8`} className="swk-glyph" />
      )}
      {k.kind === 'send' && (
        <>
          <text x={cx - 6} y={cy + 4.5} textAnchor="middle" className="swk-send-label">
            SEND
          </text>
          <path d={`M ${cx + 18} ${cy - 5} l 6 5 l -6 5 M ${cx + 12} ${cy} h 12`} className="swk-glyph" />
        </>
      )}
    </g>
  )
}

/** The stage's HUD corners, so the keyboard reads as part of the same interface as the panels. */
function Brackets({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const s = 7
  return (
    <path
      className="swk-bracket"
      d={`M ${x} ${y + s} V ${y} H ${x + s} M ${x + w - s} ${y} H ${x + w} V ${y + s} M ${x + w} ${y + h - s} V ${y + h} H ${x + w - s} M ${x + s} ${y + h} H ${x} V ${y + h - s}`}
    />
  )
}
