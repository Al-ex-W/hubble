import { describe, expect, it } from 'vitest'
import { listRecordings, loadRecording } from '../testing.ts'
import { compile, tryCompile } from './expr.ts'

/**
 * Oracle: the model's own `points` claims in the recorded Plots (label:
 * recording). It marks roots, extrema and intersections it computed while
 * solving; the evaluator must agree with those, independently of this code.
 */
const plots = listRecordings().flatMap((name) =>
  [...loadRecording(name).text.matchAll(/<Plot\b[^>]*>/g)].map((m) => {
    const attr = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(m[0])?.[1]
    return { name, fn: attr('fn')!, points: attr('points') }
  }),
)

describe('compile over recorded Plot functions', () => {
  it('finds the recorded plots', () => {
    expect(plots.length).toBe(17)
  })

  it.each(plots.map((p) => [p.name, p.fn] as const))('%s: "%s" compiles', (_n, fn) => {
    expect(tryCompile(fn)).not.toBeNull()
  })

  const claims = plots.flatMap((p) =>
    (p.points ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pt) => {
        const [x, y] = pt.split(',').map(Number)
        return [p.name, p.fn, x, y] as const
      }),
  )
  it.each(claims)('%s: %s at x=%d agrees with the recorded y=%d', (_n, fn, x, y) => {
    const f = compile(fn)
    // sin(3x)/x at 0 is a removable singularity: compare the limit.
    const v = Number.isFinite(f(x)) ? f(x) : f(x + 1e-6)
    // Models round to 2-3 significant digits when they mark points.
    expect(Math.abs(v - y)).toBeLessThan(Math.max(0.15, Math.abs(y) * 0.02))
  })
})

describe('compile refuses what is not math', () => {
  it.each(['alert(1)', 'x; fetch("/")', 'constructor', 'x[0]', '`x`', 'process.exit()'])('%s', (src) => {
    // Break caught: any path that evaluates model text as code.
    expect(tryCompile(src)).toBeNull()
  })

  // Mutation: the first recorded Plot's function name swapped for names every
  // JS object inherits. `FUNCS[name]` used to find them on Object.prototype,
  // so `constructor(x)` compiled and `hasOwnProperty(x)` compiled and then
  // threw on the first sample, taking the Plot down with it.
  const recorded = plots.find((p) => /\b(sin|cos|exp|sqrt|ln)\(/.test(p.fn))!
  it.each(['constructor', 'hasOwnProperty', 'toString', 'valueOf', 'isPrototypeOf'])(
    'refuses the inherited name %s in place of a recorded function',
    (name) => {
      const src = recorded.fn.replace(/\b(sin|cos|exp|sqrt|ln)\(/, `${name}(`)
      expect(src).not.toBe(recorded.fn)
      expect(tryCompile(src)).toBeNull()
    },
  )

  it('never throws while sampling, whatever compiled', () => {
    // Mutation: a recorded function multiplied by itself thousands of times.
    // The grammar accepts it (the product is parsed iteratively), but
    // evaluating it nests one closure call per factor and overflows the
    // stack. The Plot samples hundreds of x values inside render; one throw
    // there blanks the whole stage, so a sample that cannot be computed must
    // be a gap (NaN), not an exception.
    const src = Array(60000).fill(`(${recorded.fn})`).join('*')
    const f = tryCompile(src)
    expect(f).not.toBeNull()
    expect(() => f!(1)).not.toThrow()
    expect(f!(1)).toBeNaN()
  })

  it('reads implicit multiplication and unary minus the way math does', () => {
    expect(compile('2x')(3)).toBe(6)
    expect(compile('-x^2')(3)).toBe(-9)
    expect(compile('(x-1)(x+1)')(3)).toBe(8)
    expect(compile('2^3^2')(0)).toBe(512)
  })
})
