import { useMemo } from 'react'
import { tryCompile } from '@hubble/stage'

/**
 * y = f(x), drawn on like a pen stroke. The function comes from the model as
 * text and is compiled by our own evaluator (never eval), so a bad `fn` just
 * renders an empty frame.
 */

const VW = 600
const VH = 380
const PAD = { l: 46, r: 16, t: 14, b: 34 }

function niceStep(range: number, target = 5): number {
  const raw = range / target
  const mag = 10 ** Math.floor(Math.log10(raw))
  const n = raw / mag
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag
}

/**
 * Tick values for one axis, at most MAX_TICKS + 1 of them whatever the range.
 *
 * Ticks are counted by integer index (first..last multiple of the step), never
 * by `v += step` up to `hi + 1e-9`. That old loop hung Chromium on a tiny
 * range: xmin=0, xmax=1e-20 gives a step near 1e-21, and the absolute 1e-9
 * slack alone is ~5×10¹¹ iterations (#17). The model chooses the range, so
 * the loop count must not depend on it. The slack is relative to the step, so
 * an end that is a multiple of the step up to float noise still gets its tick.
 */
const MAX_TICKS = 20

export function axisTicks(lo: number, hi: number): number[] {
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return []
  let step = niceStep(hi - lo)
  if (!(step > 0) || !Number.isFinite(step)) return []
  let first = Math.ceil(lo / step - 1e-9)
  let last = Math.floor(hi / step + 1e-9)
  // niceStep aims for ~5 ticks, so this only triggers on degenerate input
  // (a range so small that lo/step loses precision); thin out rather than draw thousands.
  while (last - first > MAX_TICKS) {
    step *= 2
    first = Math.ceil(lo / step - 1e-9)
    last = Math.floor(hi / step + 1e-9)
  }
  const out: number[] = []
  for (let i = first; i <= last; i++) out.push(i * step)
  return out
}

function quantile(sorted: number[], q: number) {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo)
}

export interface PlotProps {
  fn: string
  xmin?: number
  xmax?: number
  ymin?: number
  ymax?: number
  points?: string
  label?: string
  duration: number
}

export function Plot({ fn, xmin = -5, xmax = 5, ymin, ymax, points, label, duration }: PlotProps) {
  const model = useMemo(() => {
    const f = tryCompile(fn)
    if (!f || !(xmax > xmin)) return null
    const N = 480
    const xs = Array.from({ length: N + 1 }, (_, i) => xmin + ((xmax - xmin) * i) / N)
    const ys = xs.map((x) => {
      const y = f(x)
      return Number.isFinite(y) ? y : NaN
    })
    const marks = (points ?? '')
      .split(';')
      .map((p) => p.split(',').map((v) => Number(v.trim())))
      .filter((p) => p.length === 2 && p.every(Number.isFinite)) as [number, number][]

    // Fit y robustly: percentiles ignore the spike next to an asymptote,
    // which would otherwise squash the rest of the curve flat.
    let lo = ymin
    let hi = ymax
    if (lo === undefined || hi === undefined) {
      const finite = ys.filter((y) => !Number.isNaN(y)).sort((a, b) => a - b)
      const q0 = finite.length ? quantile(finite, 0.03) : -1
      const q1 = finite.length ? quantile(finite, 0.97) : 1
      const extra = marks.map((m) => m[1])
      const a = Math.min(q0, ...extra)
      const b = Math.max(q1, ...extra)
      const pad = (b - a || 2) * 0.12
      lo ??= a - pad
      hi ??= b + pad
    }
    if (!(hi > lo)) hi = lo + 1

    const sx = (x: number) => PAD.l + ((x - xmin) / (xmax - xmin)) * (VW - PAD.l - PAD.r)
    const sy = (y: number) => VH - PAD.b - ((y - lo!) / (hi! - lo!)) * (VH - PAD.t - PAD.b)
    const span = hi - lo
    let d = ''
    let pen = false
    for (let i = 0; i < xs.length; i++) {
      const y = ys[i]
      // Break the line at gaps and at asymptote jumps instead of drawing a
      // vertical wall across the plot.
      const jump = i > 0 && !Number.isNaN(ys[i - 1]) && Math.abs(y - ys[i - 1]) > span * 1.5
      if (Number.isNaN(y) || y < lo - span * 2 || y > hi + span * 2 || jump) {
        pen = false
        continue
      }
      d += `${pen ? 'L' : 'M'}${sx(xs[i]).toFixed(1)},${sy(y).toFixed(1)}`
      pen = true
    }
    const xTicks = axisTicks(xmin, xmax)
    const yTicks = axisTicks(lo, hi)
    return { d, sx, sy, xTicks, yTicks, lo, hi, marks }
  }, [fn, xmin, xmax, ymin, ymax, points])

  if (!model) return <div className="st-plot is-empty" />
  const { d, sx, sy, xTicks, yTicks, lo, hi, marks } = model
  const axisX = lo <= 0 && hi >= 0 ? sy(0) : VH - PAD.b
  const axisY = xmin <= 0 && xmax >= 0 ? sx(0) : PAD.l
  const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toExponential(0) : String(+v.toFixed(2)))

  return (
    <figure className="st-plot">
      <svg viewBox={`0 0 ${VW} ${VH}`} width="100%">
        <g className="st-plot-grid fx-fade" style={{ ['--fx-duration' as string]: `${duration * 0.3}ms` }}>
          {xTicks.map((v, i) => (
            <line key={`gx${i}`} x1={sx(v)} x2={sx(v)} y1={PAD.t} y2={VH - PAD.b} />
          ))}
          {yTicks.map((v, i) => (
            <line key={`gy${i}`} x1={PAD.l} x2={VW - PAD.r} y1={sy(v)} y2={sy(v)} />
          ))}
        </g>
        <g className="st-plot-axes fx-fade" style={{ ['--fx-duration' as string]: `${duration * 0.3}ms` }}>
          <line x1={PAD.l} x2={VW - PAD.r} y1={axisX} y2={axisX} />
          <line x1={axisY} x2={axisY} y1={PAD.t} y2={VH - PAD.b} />
          {xTicks.map((v, i) => (
            <text key={`tx${i}`} x={sx(v)} y={VH - PAD.b + 22} textAnchor="middle">
              {fmt(v)}
            </text>
          ))}
          {yTicks.map((v, i) => (
            <text key={`ty${i}`} x={PAD.l - 8} y={sy(v) + 5} textAnchor="end">
              {fmt(v)}
            </text>
          ))}
        </g>
        <path
          className="st-plot-curve"
          d={d}
          pathLength={1}
          style={{ animation: `st-draw ${duration * 0.8}ms cubic-bezier(0.4, 0, 0.2, 1) ${duration * 0.15}ms both` }}
        />
        {marks.map(([x, y], i) => (
          <g key={i} className="st-plot-point" style={{ animation: `st-pop 320ms ease-out ${duration * 0.9 + i * 120}ms both` }}>
            <circle cx={sx(x)} cy={sy(y)} r={7} />
            <text x={sx(x) + 12} y={sy(y) - 12}>
              ({fmt(x)}, {fmt(y)})
            </text>
          </g>
        ))}
      </svg>
      {label && <figcaption>{label}</figcaption>}
    </figure>
  )
}
