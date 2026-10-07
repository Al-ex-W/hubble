import type { AttrValue, Attrs, Policy } from './protocol.ts'

/**
 * The component catalog: the single source of truth for what the model may
 * write. The parser validates against it, the prompt documents it, and the
 * renderer implements exactly these names. Adding a component means adding it
 * here first; anything not here is dropped before it can reach the table.
 */

export type AttrSpec =
  | { kind: 'string'; doc: string; required?: boolean; maxLength?: number }
  | { kind: 'enum'; doc: string; values: readonly string[]; required?: boolean }
  | { kind: 'number'; doc: string; min: number; max: number; required?: boolean }
  | { kind: 'boolean'; doc: string }

export interface ComponentSpec {
  policy: Policy
  doc: string
  attrs: Record<string, AttrSpec>
  /** Tags allowed directly inside. Empty for leaves. */
  children: readonly string[]
  /**
   * The body is literal text closed only by the matching end tag: no child
   * tags, no expressions. Needed for TeX, where `{`, `<` and `\` are content.
   */
  raw?: boolean
  /** Written `<Tag ... />` with no body. */
  selfClosing?: boolean
}

const ANCHORS = [
  'center',
  'left',
  'right',
  'top',
  'bottom',
  'right-of:notebook',
  'left-of:notebook',
  'above:notebook',
  'below:notebook',
] as const

// Inside a Canvas, anything presentational may appear. Kept as one list so a
// new leaf only has to be added in one place to be usable at the top level.
const CANVAS_CHILDREN = [
  'Heading',
  'Text',
  'Math',
  'Equations',
  'Steps',
  'List',
  'Table',
  'Plot',
  'Columns',
  'Note',
  'Highlight',
  'Pause',
  'Button',
] as const
// What a Column may hold: everything except nested Columns, which would make
// panels too narrow to read on the table.
const COLUMN_CHILDREN = CANVAS_CHILDREN.filter((c) => c !== 'Columns')
// Spatial elements live directly on the canvas: they are positioned on the
// table itself, not in the flow of a panel.
//
// Not the same list as SPATIAL_TAGS (report.ts, which StageView also reads):
// that one adds Highlight, because the report and the renderer must agree
// that a Highlight on the Canvas is drawn on the table, not put in the
// implicit panel. Here Highlight is already allowed through CANVAS_CHILDREN,
// so adding it would only move it in Canvas's child list, and that list is
// printed into the system prompt, which the recorded corpus was made against.
// Unifying the two is the Highlight follow-up in
// docs/plans/2026-10-07-clean-codebase.md (a catalog change plus a re-record).
const SPATIAL = ['Panel', 'Label', 'Arrow', 'Mark'] as const

export const CATALOG = {
  Canvas: {
    policy: 'container',
    doc: 'One answer: the whole table surface. Always the outermost element. Put Panels, Labels, Arrows and Marks in it, positioned on the table. Content written directly inside it goes into one panel placed by anchor/size.',
    attrs: {
      anchor: { kind: 'enum', values: ANCHORS, doc: 'Only for content written directly in the Canvas: where its implicit panel goes.' },
      size: {
        kind: 'enum',
        values: ['small', 'medium', 'large', 'full'],
        doc: 'Only for content written directly in the Canvas: its implicit panel width.',
      },
    },
    children: [...SPATIAL, ...CANVAS_CHILDREN],
  },
  Panel: {
    policy: 'container',
    doc: 'A framed area of content placed on the table. Give either x/y or near.',
    attrs: {
      id: { kind: 'string', maxLength: 30, doc: 'Name it so an Arrow can start from it, e.g. "steps".' },
      x: { kind: 'number', min: 0, max: 4000, doc: 'Left edge in table pixels.' },
      y: { kind: 'number', min: 0, max: 4000, doc: 'Top edge in table pixels.' },
      w: { kind: 'number', min: 200, max: 4000, doc: 'Width in table pixels. 450-650 is comfortable.' },
      near: { kind: 'string', maxLength: 40, doc: 'Id of a table object to sit beside, instead of x/y.' },
      side: { kind: 'enum', values: ['right', 'left', 'above', 'below'], doc: 'Which side of `near`. Default right.' },
    },
    children: CANVAS_CHILDREN,
  },
  Label: {
    policy: 'words',
    doc: 'A few words written straight onto the table, without a panel: next to an object, or on it.',
    attrs: {
      x: { kind: 'number', min: 0, max: 4000, doc: 'Left edge in table pixels (or use target).' },
      y: { kind: 'number', min: 0, max: 4000, doc: 'Top edge in table pixels.' },
      target: { kind: 'string', maxLength: 40, doc: 'Object id; then u/v are positions inside that object (0-1).' },
      u: { kind: 'number', min: -1, max: 2, doc: 'Across the object, 0 = left edge, 1 = right edge.' },
      v: { kind: 'number', min: -1, max: 2, doc: 'Down the object, 0 = top edge, 1 = bottom edge.' },
      tone: { kind: 'enum', values: ['normal', 'muted', 'accent', 'answer'], doc: 'Color. Default accent.' },
    },
    children: [],
  },
  Arrow: {
    policy: 'whole',
    selfClosing: true,
    doc: 'A drawn arrow from one thing to another on the table.',
    attrs: {
      from: {
        kind: 'string',
        required: true,
        maxLength: 60,
        doc: 'A panel id ("#steps"), an object id ("notebook"), a point in an object ("notebook@0.5,0.3"), or table pixels ("900,400").',
      },
      to: { kind: 'string', required: true, maxLength: 60, doc: 'Same forms as from.' },
      label: { kind: 'string', maxLength: 40, doc: 'Optional words along the arrow.' },
    },
    children: [],
  },
  Mark: {
    policy: 'whole',
    selfClosing: true,
    doc: 'Light drawn onto a real object: circle a line in the notebook, underline a word, tick or cross something.',
    attrs: {
      target: { kind: 'string', required: true, maxLength: 40, doc: 'Object id.' },
      shape: { kind: 'enum', values: ['circle', 'box', 'underline', 'check', 'cross', 'glow'], doc: 'Default circle. glow lights the whole object.' },
      u: { kind: 'number', min: 0, max: 1, doc: 'Center across the object (0-1). Default 0.5.' },
      v: { kind: 'number', min: 0, max: 1, doc: 'Center down the object (0-1). Default 0.5.' },
      w: { kind: 'number', min: 0.02, max: 1.2, doc: 'Width as a fraction of the object. Default 0.5.' },
      h: { kind: 'number', min: 0.02, max: 1.2, doc: 'Height as a fraction of the object. Default 0.12.' },
      label: { kind: 'string', maxLength: 40, doc: 'Optional short words next to the mark.' },
    },
    children: [],
  },
  Heading: {
    policy: 'whole',
    doc: 'A short title, at most about six words.',
    attrs: {},
    children: [],
  },
  Text: {
    policy: 'words',
    doc: 'One or two short sentences of plain prose. No markdown.',
    attrs: { tone: { kind: 'enum', values: ['normal', 'muted', 'accent'], doc: 'Emphasis. Default normal.' } },
    children: [],
  },
  Math: {
    policy: 'whole',
    raw: true,
    doc: 'One line of LaTeX, without $ delimiters. It is drawn on like handwriting.',
    attrs: { highlight: { kind: 'boolean', doc: 'Mark this as the final answer.' } },
    children: [],
  },
  Equations: {
    policy: 'whole',
    raw: true,
    doc: 'A multi-line derivation in LaTeX: lines separated by \\\\, aligned at &, e.g. 2x + 3 &= 11 \\\\ 2x &= 8. Drawn line by line.',
    attrs: { highlight: { kind: 'boolean', doc: 'Mark the last line as the answer.' } },
    children: [],
  },
  Plot: {
    policy: 'whole',
    selfClosing: true,
    doc: 'A graph of y = f(x), drawn like a pen stroke.',
    attrs: {
      fn: {
        kind: 'string',
        required: true,
        maxLength: 120,
        doc: 'The function of x in plain math, e.g. "x^2 - 5*x + 6" or "sin(x)/x". Allowed: + - * / ^ ( ), sin cos tan exp ln log sqrt abs, pi, e.',
      },
      xmin: { kind: 'number', min: -1000, max: 1000, doc: 'Left end of the x axis. Default -5.' },
      xmax: { kind: 'number', min: -1000, max: 1000, doc: 'Right end of the x axis. Default 5.' },
      ymin: { kind: 'number', min: -100000, max: 100000, doc: 'Optional bottom of the y axis (otherwise fitted).' },
      ymax: { kind: 'number', min: -100000, max: 100000, doc: 'Optional top of the y axis (otherwise fitted).' },
      points: { kind: 'string', maxLength: 200, doc: 'Optional points to mark, "x,y; x,y", e.g. "2,0; 3,0" for roots.' },
      label: { kind: 'string', maxLength: 40, doc: 'Optional caption, e.g. "y = x^2 - 5x + 6".' },
    },
    children: [],
  },
  Table: {
    policy: 'container',
    doc: 'A data table. The first Row is the header.',
    attrs: {},
    children: ['Row'],
  },
  Row: {
    policy: 'container',
    doc: 'One table row of Cell elements.',
    attrs: {},
    children: ['Cell'],
  },
  Cell: {
    policy: 'words',
    doc: 'One short table cell.',
    attrs: {},
    children: [],
  },
  Columns: {
    policy: 'container',
    doc: 'Side-by-side panels, 2 or 3 Column elements (compare methods, before/after).',
    attrs: {},
    children: ['Column'],
  },
  Column: {
    policy: 'container',
    doc: 'One panel inside Columns. Can hold the same things as a Canvas except Columns.',
    attrs: {},
    children: COLUMN_CHILDREN,
  },
  Note: {
    policy: 'words',
    doc: 'A boxed callout of one short sentence.',
    attrs: { kind: { kind: 'enum', values: ['tip', 'warning', 'check'], doc: 'Callout style. Default tip.' } },
    children: [],
  },
  Steps: {
    policy: 'container',
    doc: 'An ordered sequence of Step elements. Numbered automatically.',
    attrs: {},
    children: ['Step', 'Pause'],
  },
  Step: {
    policy: 'container',
    doc: 'One step: usually a Text saying what happens, then a Math showing it.',
    attrs: { highlight: { kind: 'boolean', doc: 'Emphasise this step (e.g. the answer).' } },
    // Button: recorded (scene-study-tips) — the model reveals tips one step
    // at a time with a tap inside each step, which is a fair use.
    children: ['Text', 'Math', 'Equations', 'Plot', 'Note', 'Button', 'Pause'],
  },
  List: {
    policy: 'container',
    doc: 'An unordered list of Item elements (ingredients, options).',
    attrs: {},
    children: ['Item', 'Pause'],
  },
  Item: {
    policy: 'words',
    doc: 'One short list entry.',
    attrs: {},
    children: [],
  },
  Highlight: {
    policy: 'whole',
    selfClosing: true,
    doc: 'Older form of Mark shape="glow"; prefer Mark.',
    attrs: {
      target: { kind: 'enum', values: ['notebook', 'task'], required: true, doc: 'What to ring.' },
      label: { kind: 'string', maxLength: 40, doc: 'Optional short label next to the ring.' },
    },
    children: [],
  },
  Pause: {
    policy: 'whole',
    selfClosing: true,
    doc: 'Waits before showing what comes next, for dramatic timing.',
    attrs: { ms: { kind: 'number', min: 100, max: 3000, required: true, doc: 'Milliseconds.' } },
    children: [],
  },
  Button: {
    policy: 'whole',
    doc: 'A projected button the user can tap. Its body is the label.',
    attrs: { action: { kind: 'enum', values: ['next', 'repeat', 'dismiss'], required: true, doc: 'What tapping does.' } },
    children: [],
  },
} as const satisfies Record<string, ComponentSpec>

export type Catalog = Record<string, ComponentSpec>

/** The only element allowed at the top of an answer. */
export const ROOT_TAGS: readonly string[] = ['Canvas']

/**
 * Coerces and checks one attribute. Returns undefined for an invalid value, so
 * the caller decides whether that is fatal (required) or just ignored.
 */
export function coerceAttr(spec: AttrSpec, raw: AttrValue): AttrValue | undefined {
  switch (spec.kind) {
    case 'string': {
      const s = String(raw)
      return spec.maxLength !== undefined && s.length > spec.maxLength ? undefined : s
    }
    case 'enum':
      return spec.values.includes(String(raw)) ? String(raw) : undefined
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      return Number.isFinite(n) && n >= spec.min && n <= spec.max ? n : undefined
    }
    case 'boolean':
      return raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : undefined
  }
}

/**
 * Validates an element's attributes against its spec. Unknown attributes are
 * ignored (the model sometimes adds harmless extras like `id`), but a missing
 * or invalid *required* attribute rejects the element, because it would
 * render as something meaningless (a Pause of no length, a Plot with no function).
 */
export function validateAttrs(
  spec: ComponentSpec,
  raw: Attrs,
): { ok: true; attrs: Attrs } | { ok: false; problem: string } {
  const attrs: Attrs = {}
  for (const [name, attrSpec] of Object.entries(spec.attrs)) {
    if (!(name in raw)) {
      if ('required' in attrSpec && attrSpec.required) return { ok: false, problem: `missing ${name}` }
      continue
    }
    const value = coerceAttr(attrSpec, raw[name])
    if (value === undefined) {
      if ('required' in attrSpec && attrSpec.required) return { ok: false, problem: `invalid ${name}=${String(raw[name])}` }
      continue
    }
    attrs[name] = value
  }
  return { ok: true, attrs }
}
