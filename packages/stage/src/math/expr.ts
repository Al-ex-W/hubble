/**
 * A tiny, safe evaluator for the `fn` the model writes in <Plot>.
 *
 * Model text is never handed to eval/Function: this parses a fixed grammar
 * (numbers, x, pi, e, + - * / ^, parentheses, a short list of functions,
 * implicit multiplication like 2x or 3(x+1)) into a closure. Anything else is a
 * parse error, and the plot shows nothing rather than running code.
 */

type Fn = (x: number) => number

const FUNCS: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  sqrt: Math.sqrt,
  abs: Math.abs,
}

type Token = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string }

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  const s = src.replace(/\*\*/g, '^').replace(/[·×]/g, '*').replace(/−/g, '-')
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) {
      i++
    } else if (/[\d.]/.test(c)) {
      const m = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(s.slice(i))
      if (!m) throw new Error(`bad number at ${i}`)
      out.push({ t: 'num', v: Number(m[0]) })
      i += m[0].length
    } else if (/[a-zA-Zπ]/.test(c)) {
      const m = /^(?:π|[a-zA-Z]+)/.exec(s.slice(i))!
      out.push({ t: 'id', v: m[0] === 'π' ? 'pi' : m[0] })
      i += m[0].length
    } else if ('+-*/^()'.includes(c)) {
      out.push({ t: 'op', v: c })
      i++
    } else {
      throw new Error(`unexpected "${c}"`)
    }
  }
  return out
}

export function compile(src: string): Fn {
  const tokens = tokenize(src)
  let pos = 0
  const peek = () => tokens[pos]
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v

  // expr := term (('+'|'-') term)*
  const expr = (): Fn => {
    let left = term()
    while (isOp('+') || isOp('-')) {
      const op = (tokens[pos++] as { v: string }).v
      const a = left
      const b = term()
      left = op === '+' ? (x) => a(x) + b(x) : (x) => a(x) - b(x)
    }
    return left
  }
  // term := unary (('*'|'/'|implicit) unary)*
  const startsFactor = () => {
    const t = peek()
    return !!t && (t.t === 'num' || t.t === 'id' || (t.t === 'op' && t.v === '('))
  }
  const term = (): Fn => {
    let left = unary()
    for (;;) {
      if (isOp('*') || isOp('/')) {
        const op = (tokens[pos++] as { v: string }).v
        const a = left
        const b = unary()
        left = op === '*' ? (x) => a(x) * b(x) : (x) => a(x) / b(x)
      } else if (startsFactor()) {
        // Implicit multiplication: 2x, 3(x+1), (x-1)(x+1), 2sin(x).
        const a = left
        const b = unary()
        left = (x) => a(x) * b(x)
      } else return left
    }
  }
  // unary := '-' unary | power ; so -x^2 is -(x^2), as in math
  const unary = (): Fn => {
    if (isOp('-')) {
      pos++
      const a = unary()
      return (x) => -a(x)
    }
    if (isOp('+')) {
      pos++
      return unary()
    }
    return power()
  }
  // power := primary ('^' unary)?  (right-associative)
  const power = (): Fn => {
    const base = primary()
    if (isOp('^')) {
      pos++
      const exp = unary()
      return (x) => Math.pow(base(x), exp(x))
    }
    return base
  }
  const primary = (): Fn => {
    const t = tokens[pos++]
    if (!t) throw new Error('unexpected end')
    if (t.t === 'num') return () => t.v
    if (t.t === 'op' && t.v === '(') {
      const inner = expr()
      if (!isOp(')')) throw new Error('missing )')
      pos++
      return inner
    }
    if (t.t === 'id') {
      if (t.v === 'x') return (x) => x
      if (t.v === 'pi') return () => Math.PI
      if (t.v === 'e') return () => Math.E
      // Own properties only. A plain `FUNCS[name]` lookup also finds what
      // every object inherits (constructor, hasOwnProperty, toString...), so
      // `constructor(x)` compiled and `hasOwnProperty(x)` compiled and threw
      // when sampled. No code ran either way, but the grammar's promise is
      // "this list of functions and nothing else", and the list is the
      // object's own keys.
      const f = Object.hasOwn(FUNCS, t.v) ? FUNCS[t.v] : undefined
      if (f) {
        // Both sin(x) and sin x are written by models.
        const arg = isOp('(') ? primary() : unary()
        return (x) => f(arg(x))
      }
      throw new Error(`unknown name "${t.v}"`)
    }
    throw new Error(`unexpected "${t.v}"`)
  }

  const fn = expr()
  if (pos !== tokens.length) throw new Error('trailing input')
  return fn
}

/**
 * The entry the renderer uses: null when `src` is not in the grammar, and a
 * function that never throws when it is. Plot samples it hundreds of times
 * during render, where one exception blanks the whole stage; a sample that
 * cannot be computed (today: a pathologically deep expression overflowing the
 * stack) becomes NaN, which the plot already draws as a gap.
 */
export function tryCompile(src: string): Fn | null {
  let f: Fn
  try {
    f = compile(src)
  } catch {
    return null
  }
  return (x) => {
    try {
      return f(x)
    } catch {
      return NaN
    }
  }
}
