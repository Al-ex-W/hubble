import { readdirSync, readFileSync } from 'node:fs'
import { CATALOG } from '../src/catalog.ts'

/**
 * Stage 0 census over the recorded streams. Deliberately independent of the
 * parser (crude regexes, no shared code), so it can be checked against the
 * parser instead of agreeing with it by construction.
 *
 *   npm run census:stage            # summary
 *   npm run census:stage -- --text  # also print each assembled answer
 */

const DIR = new URL('../fixtures/stage-streams/', import.meta.url)
const known = new Set(Object.keys(CATALOG))
const showText = process.argv.includes('--text')

interface Row {
  file: string
  deltas: number
  ms: number
  firstContentMs: number | null
  chars: number
  unknownTags: string[]
  fence: boolean
  strayLeading: string
  strayTrailing: string
  expressions: string[]
  splitTag: number
  splitMath: number
  mathWithAngle: number
  mathBraceExpr: number
  roots: number
}

const rows: Row[] = []
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort()) {
  const lines = readFileSync(new URL(file, DIR), 'utf8').trim().split('\n').slice(1)
  let text = ''
  let firstContentMs: number | null = null
  let lastT = 0
  let splitTag = 0
  let splitMath = 0
  let deltas = 0
  for (const line of lines) {
    const { t, data } = JSON.parse(line) as { t: number; data: string }
    lastT = t
    if (data === '[DONE]') continue
    const delta = JSON.parse(data).choices?.[0]?.delta?.content as string | undefined
    if (!delta) continue
    deltas++
    firstContentMs ??= t
    text += delta
    // Does this delta end inside a tag, or inside an unfinished <Math> body?
    const lastOpen = text.lastIndexOf('<')
    if (lastOpen > text.lastIndexOf('>')) splitTag++
    if (text.lastIndexOf('<Math') > text.lastIndexOf('</Math>')) splitMath++
  }
  const tags = [...text.matchAll(/<\/?([A-Za-z][\w.-]*)/g)].map((m) => m[1])
  const mathBodies = [...text.matchAll(/<Math[^>]*>([\s\S]*?)<\/Math>/g)].map((m) => m[1])
  const outside = text.replace(/<Math[^>]*>[\s\S]*?<\/Math>/g, '')
  const trimmed = text.trim()
  rows.push({
    file: file.replace('.jsonl', ''),
    deltas,
    ms: lastT,
    firstContentMs,
    chars: text.length,
    unknownTags: [...new Set(tags.filter((t) => !known.has(t)))],
    fence: /```/.test(text),
    strayLeading: trimmed.startsWith('<') ? '' : trimmed.slice(0, 30),
    strayTrailing: trimmed.endsWith('>') ? '' : trimmed.slice(-30),
    expressions: [...outside.matchAll(/=\{([^}]*)\}/g)].map((m) => m[1]).filter((v) => !/^-?\d+(\.\d+)?$|^(true|false)$/.test(v)),
    splitTag,
    splitMath,
    mathWithAngle: mathBodies.filter((b) => /[<>]/.test(b)).length,
    mathBraceExpr: mathBodies.filter((b) => /^\s*\{/.test(b)).length,
    roots: (text.match(/<Canvas[\s>]/g) ?? []).length,
  })
  if (showText) console.log(`\n=== ${file}\n${text}`)
}

console.table(
  rows.map((r) => ({
    case: r.file,
    deltas: r.deltas,
    ms: r.ms,
    ttfc: r.firstContentMs,
    chars: r.chars,
    unknown: r.unknownTags.join(' '),
    fence: r.fence ? 'Y' : '',
    stray: r.strayLeading || r.strayTrailing ? 'Y' : '',
    expr: r.expressions.join(' '),
    splitTag: r.splitTag,
    splitMath: r.splitMath,
    'math<>': r.mathWithAngle,
    roots: r.roots,
  })),
)
const n = rows.length
const clean = rows.filter((r) => !r.unknownTags.length && !r.fence && !r.strayLeading && !r.strayTrailing && !r.expressions.length && r.roots === 1).length
console.log(`streams: ${n}; fully clean: ${clean}/${n}`)
console.log(`deltas ending inside a tag: ${rows.reduce((a, r) => a + r.splitTag, 0)} / ${rows.reduce((a, r) => a + r.deltas, 0)}`)
console.log(`deltas ending inside a Math body: ${rows.reduce((a, r) => a + r.splitMath, 0)}`)
console.log(`max total ms: ${Math.max(...rows.map((r) => r.ms))}; max ttfc: ${Math.max(...rows.map((r) => r.firstContentMs ?? 0))}`)
