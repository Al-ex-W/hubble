/**
 * Token-level repair: exact find/replace edits on the answer text, so a fix
 * touches only what was wrong (a position, a missing id, a close tag) and the
 * rest of the answer the user is about to read stays exactly as written.
 */
export interface Edit {
  find: string
  replace: string
}

/**
 * A catalog tag as written in the answer: `<Panel x={610} id="steps">`,
 * `</Panel>`, `<Arrow … />`. Catalog names are capitalised, which is what
 * keeps TeX out of this match: recordings put a literal `<` inside Math
 * (`x < 3`), always followed by a space or a lowercase letter or digit.
 * Quoted and braced attribute values are skipped whole, so a `>` inside one
 * does not end the tag early (the parser makes the same rule).
 */
const TAG = /<\/?[A-Z][A-Za-z0-9]*(?:"[^"]*"|'[^']*'|\{[^{}]*\}|[^<>"'{}])*>/g

/**
 * What the user reads: everything that is not a tag, with whitespace
 * collapsed (re-indenting or moving a line break is not a content change).
 */
export function visibleContent(text: string): string {
  return text.replace(TAG, ' ').replace(/\s+/g, ' ').trim()
}

/** Occurrences counted overlapping: `"aaa"` holds `"aa"` twice, and an edit there is ambiguous. */
function occurrences(text: string, find: string): number {
  let n = 0
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + 1)) n++
  return n
}

export function applyEdits(text: string, edits: Edit[]): { ok: true; text: string } | { ok: false; error: string } {
  let out = text
  for (const e of edits) {
    if (!e.find) return { ok: false, error: 'an edit has an empty find' }
    const n = occurrences(out, e.find)
    // Ambiguous edits are refused rather than guessed: replacing the wrong
    // occurrence would silently move the wrong panel. Counted overlapping,
    // because `split` (the first version) saw one "aa" in "aaa" and then
    // replaced whichever came first.
    if (n !== 1) return { ok: false, error: `"${e.find.slice(0, 60)}" appears ${n} times; make it unique (include more surrounding text)` }
    out = out.replace(e.find, () => e.replace)
  }
  // The repair prompt asks the model not to touch the math or the words, but
  // a prompt is a request, not a guarantee: the user has already been told
  // what the answer says (the voice reads the same draft), and a "layout fix"
  // that quietly rewrites a step would put a different answer on the table.
  // So the rule is enforced here, on the whole batch: edits may change tags
  // and attributes only. Recorded repairs (fixtures/repairs) all pass this.
  if (visibleContent(out) !== visibleContent(text))
    return { ok: false, error: 'edits may only change tags and attributes (position, size, id, references, closing tags), never the text or math' }
  return { ok: true, text: out }
}
