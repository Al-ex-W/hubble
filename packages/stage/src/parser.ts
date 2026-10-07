import { CATALOG, ROOT_TAGS, validateAttrs, type Catalog, type ComponentSpec } from './catalog.ts'
import type { AttrValue, Attrs, DropReason, StageEvent } from './protocol.ts'

/**
 * Streaming parser for the restricted JSX the model writes.
 *
 * Feed it deltas exactly as they arrive; it returns only events for things
 * that are complete and valid. Recorded streams end a delta inside a tag in
 * roughly one delta out of four, and inside an unfinished Math body nearly as
 * often, so every rule below is about *withholding* until something is whole.
 *
 * This is the one place model text is interpreted. The renderer must never
 * parse model output itself (see the isolation table in the plan).
 */
export interface StageParser {
  push(delta: string): StageEvent[]
  /** Call once when the stream ends; closes what is open, discards what is unfinished. */
  end(): StageEvent[]
}

interface Frame {
  id: string
  tag: string
  spec: ComponentSpec
  /** For `words` frames: text received but not yet emitted as whole words. */
  pending: string
}

type Capture =
  /** Collecting the raw body of a `whole` element until its close tag. */
  | { kind: 'whole'; id: string; tag: string; attrs: Attrs; parent: string | null }
  /** Skipping a refused element and its whole subtree. */
  | { kind: 'skip'; tag: string; depth: number }

type ScannedTag =
  | { status: 'incomplete' }
  | { status: 'not-a-tag' }
  | { status: 'tag'; close: boolean; name: string; attrs: Attrs; expressions: string[]; selfClosing: boolean; end: number }

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" }
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m])
const snippet = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}...` : s)

/**
 * Reads one tag starting at `buf[i] === '<'`. Quote- and brace-aware, so a
 * `>` inside an attribute value cannot end the tag early.
 */
function scanTag(buf: string, i: number): ScannedTag {
  let j = i + 1
  if (j >= buf.length) return { status: 'incomplete' }
  const close = buf[j] === '/'
  if (close) j++
  if (j >= buf.length) return { status: 'incomplete' }
  // `x < 3` or `a <= b` in prose: a `<` not followed by a name is text.
  if (!/[A-Za-z]/.test(buf[j])) return { status: 'not-a-tag' }
  const nameStart = j
  while (j < buf.length && /[\w.:-]/.test(buf[j])) j++
  if (j >= buf.length) return { status: 'incomplete' }
  const name = buf.slice(nameStart, j)

  if (close) {
    const gt = buf.indexOf('>', j)
    if (gt < 0) return { status: 'incomplete' }
    return { status: 'tag', close: true, name, attrs: {}, expressions: [], selfClosing: false, end: gt + 1 }
  }

  const attrs: Attrs = {}
  const expressions: string[] = []
  for (;;) {
    while (j < buf.length && /\s/.test(buf[j])) j++
    if (j >= buf.length) return { status: 'incomplete' }
    if (buf[j] === '>') return { status: 'tag', close: false, name, attrs, expressions, selfClosing: false, end: j + 1 }
    if (buf[j] === '/') {
      if (j + 1 >= buf.length) return { status: 'incomplete' }
      if (buf[j + 1] === '>') return { status: 'tag', close: false, name, attrs, expressions, selfClosing: true, end: j + 2 }
      j++
      continue
    }
    const attrStart = j
    while (j < buf.length && !/[\s=/>]/.test(buf[j])) j++
    if (j >= buf.length) return { status: 'incomplete' }
    const attr = buf.slice(attrStart, j)
    while (j < buf.length && /\s/.test(buf[j])) j++
    if (j >= buf.length) return { status: 'incomplete' }
    if (buf[j] !== '=') {
      attrs[attr] = true // bare attribute, e.g. <Step highlight>
      continue
    }
    j++
    while (j < buf.length && /\s/.test(buf[j])) j++
    if (j >= buf.length) return { status: 'incomplete' }
    const q = buf[j]
    if (q === '"' || q === "'") {
      const endQ = buf.indexOf(q, j + 1)
      if (endQ < 0) return { status: 'incomplete' }
      attrs[attr] = decode(buf.slice(j + 1, endQ))
      j = endQ + 1
    } else if (q === '{') {
      // Find the matching brace, respecting nested braces and quotes.
      let depth = 0
      let k = j
      let quote: string | null = null
      for (; k < buf.length; k++) {
        const ch = buf[k]
        if (quote) {
          if (ch === quote) quote = null
        } else if (ch === '"' || ch === "'" || ch === '`') quote = ch
        else if (ch === '{') depth++
        else if (ch === '}' && --depth === 0) break
      }
      if (k >= buf.length) return { status: 'incomplete' }
      const inner = buf.slice(j + 1, k).trim()
      const literal = parseLiteral(inner)
      if (literal === undefined) expressions.push(`${attr}={${inner}}`)
      else attrs[attr] = literal
      j = k + 1
    } else {
      const valStart = j
      while (j < buf.length && !/[\s>]/.test(buf[j]) && !(buf[j] === '/' && buf[j + 1] === '>')) j++
      if (j >= buf.length) return { status: 'incomplete' }
      attrs[attr] = buf.slice(valStart, j)
    }
  }
}

/** Only literals are allowed inside `{}`: anything else is code and is refused. */
function parseLiteral(inner: string): AttrValue | undefined {
  if (/^-?\d+(\.\d+)?$/.test(inner)) return Number(inner)
  if (inner === 'true') return true
  if (inner === 'false') return false
  const m = /^(["'])(.*)\1$/s.exec(inner)
  return m ? m[2] : undefined
}

export function createStageParser(catalog: Catalog = CATALOG): StageParser {
  let buf = ''
  let stray = ''
  let capture: Capture | null = null
  const stack: Frame[] = []
  let counter = 0
  let out: StageEvent[] = []

  const nextId = () => `e${++counter}`
  const top = () => stack.at(-1)
  const drop = (reason: DropReason, detail: string) => out.push({ type: 'drop', reason, detail: snippet(detail) })

  // Words are emitted one per event, each with a single trailing space. Making
  // the unit the word (not "whatever arrived") keeps the event stream
  // identical however the network chunks the text, which is what lets replays
  // and the director be deterministic.
  const emitWords = (frame: Frame, final: boolean) => {
    const re = /\S+\s+/y
    let m: RegExpExecArray | null
    let consumed = 0
    // Leading whitespace is always dropped, not only before the first word.
    // Every emitted word already carries its one separating space, so any
    // whitespace still pending is redundant. Keeping it once a word had been
    // emitted (the old rule) broke the sticky match below whenever a delta
    // ended inside a whitespace run: "A " then " B C " left " B C " stalled,
    // released as one "B C" event on close, or lost if the stream died.
    const text = frame.pending.replace(/^\s+/, '')
    while ((m = re.exec(text))) {
      out.push({ type: 'text', id: frame.id, text: `${decode(m[0].trimEnd())} ` })
      consumed = re.lastIndex
    }
    let rest = text.slice(consumed)
    if (final && rest.trim()) {
      out.push({ type: 'text', id: frame.id, text: decode(rest.trim()) })
      rest = ''
    }
    frame.pending = rest
  }

  const flushStray = () => {
    if (stray.trim()) drop('stray-text', stray.trim())
    stray = ''
  }

  const closeTop = (complete: boolean) => {
    const frame = stack.pop()!
    // A words frame closed by its end tag is complete; one closed because the
    // stream died may end in a cut-off word, which is withheld.
    if (frame.spec.policy === 'words') emitWords(frame, complete)
    out.push({ type: 'close', id: frame.id })
  }

  const handleText = (text: string) => {
    const t = top()
    if (t && t.spec.policy === 'words') {
      t.pending += text
      emitWords(t, false)
    } else {
      stray += text
    }
  }

  const allowedHere = (name: string) => {
    const t = top()
    return t ? t.spec.children.includes(name) : ROOT_TAGS.includes(name)
  }

  const refuse = (reason: DropReason, detail: string, name: string, selfClosing: boolean) => {
    drop(reason, detail)
    if (!selfClosing) capture = { kind: 'skip', tag: name, depth: 1 }
  }

  /** Handles one complete tag. Returns false if the tag must be re-read (after an implicit close). */
  const handleTag = (tag: Extract<ScannedTag, { status: 'tag' }>, raw: string): boolean => {
    const t = top()
    const spec = catalog[tag.name]

    if (tag.close) {
      const idx = stack.map((f) => f.tag).lastIndexOf(tag.name)
      if (idx >= 0) {
        // Closing an ancestor also closes anything the model left open inside
        // it (a forgotten </Step> before </Steps>).
        flushStray()
        while (stack.length > idx) closeTop(true)
      } else if (t?.spec.policy === 'words' && !spec) {
        drop('unknown-tag', raw) // stray inline close like </b>: keep the prose
      } else {
        drop('malformed', raw)
      }
      return true
    }

    if (t?.spec.policy === 'words') {
      if (!spec) {
        // Inline HTML in prose (<b>, <em>): strip the tag, keep the words.
        drop('unknown-tag', raw)
        return true
      }
      // A catalog tag inside prose means the model forgot </Text>. Close the
      // prose and read the tag again in the parent, rather than letting
      // literal markup reach the table.
      closeTop(true)
      return false
    }

    flushStray()
    if (!spec) return refuse('unknown-tag', raw, tag.name, tag.selfClosing), true
    if (!allowedHere(tag.name)) return refuse('not-allowed-here', raw, tag.name, tag.selfClosing), true
    if (tag.expressions.length) return refuse('expression', tag.expressions.join(' '), tag.name, tag.selfClosing), true
    const checked = validateAttrs(spec, tag.attrs)
    if (!checked.ok) return refuse('bad-attribute', `${tag.name}: ${checked.problem}`, tag.name, tag.selfClosing), true

    const id = nextId()
    const parent = t?.id ?? null
    if (spec.policy === 'whole') {
      if (tag.selfClosing) out.push({ type: 'piece', id, tag: tag.name, attrs: checked.attrs, body: '', parent })
      else capture = { kind: 'whole', id, tag: tag.name, attrs: checked.attrs, parent }
      return true
    }
    out.push({ type: 'open', id, tag: tag.name, attrs: checked.attrs, parent })
    if (tag.selfClosing) out.push({ type: 'close', id })
    else stack.push({ id, tag: tag.name, spec, pending: '' })
    return true
  }

  const drain = () => {
    for (;;) {
      if (capture?.kind === 'whole') {
        // Raw body: only the exact close tag ends it. This is what keeps
        // `x < 11` and `\frac{a}{b}` intact inside Math.
        const endTag = `</${capture.tag}>`
        const idx = buf.indexOf(endTag)
        // Recovery: TeX never contains a closing tag of an enclosing element
        // or the opening tag of a catalog component. Seeing one first means
        // the model never closed this body (recorded: adv-limit writes
        // `\end{Equations>`). Drop just this piece and resume there, instead
        // of swallowing the rest of the answer into an unfinished body.
        const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const ancestors = stack.map((f) => escape(f.tag))
        const intruder = new RegExp(
          `</(?:${ancestors.length ? ancestors.join('|') : '(?!)'})\\s*>|<(?:${Object.keys(catalog).map(escape).join('|')})(?=[\\s/>])`,
        ).exec(buf)
        if (intruder && (idx < 0 || intruder.index < idx)) {
          drop('malformed', `${capture.tag} never closed: ${buf.slice(0, intruder.index)}`)
          buf = buf.slice(intruder.index)
          capture = null
          continue
        }
        if (idx < 0) return
        out.push({ type: 'piece', id: capture.id, tag: capture.tag, attrs: capture.attrs, body: buf.slice(0, idx), parent: capture.parent })
        buf = buf.slice(idx + endTag.length)
        capture = null
        continue
      }
      if (capture?.kind === 'skip') {
        // Tags inside the refused subtree are read with the same quote-aware
        // scanTag as everywhere else, only to count opens and closes of the
        // refused name. The old regex scan (`<Name[^>]*>`) did not know
        // quotes: a nested `<table title="a<b">` cut right after its quoted
        // `<` made it keep only the tail from that `<`, lose the nested open,
        // end the skip one close too early and let the hidden content
        // (recorded shape: a Math inside a <table>) onto the table. Whether a
        // subtree is hidden must not depend on where the network cut it.
        let i = 0
        for (;;) {
          const lt = buf.indexOf('<', i)
          if (lt < 0) {
            i = buf.length
            break
          }
          const scanned = scanTag(buf, lt)
          if (scanned.status === 'incomplete') {
            // Keep the whole unfinished tag, from its own `<`, for the next delta.
            i = lt
            break
          }
          if (scanned.status === 'not-a-tag') {
            i = lt + 1
            continue
          }
          i = scanned.end
          if (scanned.name !== capture.tag) continue
          if (scanned.close) capture.depth--
          else if (!scanned.selfClosing) capture.depth++
          if (capture.depth === 0) break
        }
        buf = buf.slice(i)
        if (capture.depth > 0) return
        capture = null
        continue
      }

      const lt = buf.indexOf('<')
      if (lt < 0) {
        handleText(buf)
        buf = ''
        return
      }
      const scanned = scanTag(buf, lt)
      if (scanned.status === 'incomplete') {
        handleText(buf.slice(0, lt))
        buf = buf.slice(lt)
        return
      }
      if (scanned.status === 'not-a-tag') {
        handleText(buf.slice(0, lt + 1))
        buf = buf.slice(lt + 1)
        continue
      }
      handleText(buf.slice(0, lt))
      const raw = buf.slice(lt, scanned.end)
      if (handleTag(scanned, raw)) buf = buf.slice(scanned.end)
      else buf = buf.slice(lt)
    }
  }

  const take = () => {
    const events = out
    out = []
    return events
  }

  return {
    push(delta) {
      buf += delta
      drain()
      return take()
    },
    end() {
      drain()
      let truncated = stack.length > 0 || buf.trim().length > 0
      if (capture?.kind === 'whole') {
        // The defining guarantee: an element whose close tag never came is
        // never shown, because its body may be cut mid-expression.
        drop('unfinished', `${capture.tag}: ${buf}`)
        truncated = true
      } else if (capture?.kind === 'skip') {
        truncated = true
      }
      capture = null
      buf = ''
      flushStray()
      while (stack.length) closeTop(false)
      out.push({ type: 'end', reason: truncated ? 'truncated' : 'complete' })
      return take()
    },
  }
}
