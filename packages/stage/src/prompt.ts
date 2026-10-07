import { CATALOG, ROOT_TAGS, type AttrSpec, type Catalog } from './catalog.ts'
import { clearances } from './layout.ts'
import { DEFAULT_SURFACE, PANEL_MM, mmFromPx, pxFromMm, type Scene } from './scene.ts'

/**
 * Builds the system prompt for the model that writes table answers.
 *
 * The component documentation is generated from the catalog, never written
 * by hand, so the model is always told about exactly the components the parser
 * accepts and the renderer draws. A hand-maintained prompt drifts, and drift
 * here means the model writes tags that are silently dropped on stage.
 */
export interface PromptContext {
  /** An image of the table area (e.g. the notebook) is attached to the user turn. */
  hasImage: boolean
  /** What is physically on the table and where. Without it the model sees an empty table. */
  scene?: Scene
}

const cm = (scene: Scene, px: number) => (mmFromPx(scene.surface, px) / 10).toFixed(0)

/**
 * The table as the model needs to reason about it: its size in pixels and in
 * real units, and every object's box. This is what lets the model decide the
 * layout itself instead of picking from canned positions.
 */
export function describeScene(scene: Scene): string {
  const { surface } = scene
  const lines = [
    `The table surface is ${surface.widthPx} x ${surface.heightPx} pixels (${cm(scene, surface.widthPx)} x ${cm(scene, surface.heightPx)} cm; 1 px = ${surface.mmPerPx.toFixed(2)} mm). x grows to the right, y grows toward the user. The user sits at the bottom edge (y = ${surface.heightPx}).`,
    `A comfortable panel is ${Math.round(pxFromMm(surface, PANEL_MM.default))} px wide (${PANEL_MM.default / 10} cm); keep at least ${Math.round(clearances(surface).edge)} px from the edges and ${Math.round(clearances(surface).object)} px from objects.`,
  ]
  if (scene.objects.length === 0) lines.push('Nothing is on the table.')
  else {
    lines.push('Objects on the table (never cover them with panels; point at them with Mark, Label or Arrow):')
    for (const o of scene.objects) {
      const b = o.box
      lines.push(
        `- id "${o.id}" (${o.label ?? o.kind}): x ${Math.round(b.x)}-${Math.round(b.x + b.w)}, y ${Math.round(b.y)}-${Math.round(b.y + b.h)} (${cm(scene, b.w)} x ${cm(scene, b.h)} cm)`,
      )
    }
  }
  return lines.join('\n')
}

const EMPTY_SCENE: Scene = { surface: DEFAULT_SURFACE, objects: [] }

function describeAttr(name: string, spec: AttrSpec): string {
  const req = 'required' in spec && spec.required ? ' (required)' : ''
  switch (spec.kind) {
    case 'enum':
      return `${name}${req}: one of ${spec.values.map((v) => `"${v}"`).join(', ')}. ${spec.doc}`
    case 'number':
      return `${name}${req}: number ${spec.min}-${spec.max}, written ${name}={n}. ${spec.doc}`
    case 'boolean':
      return `${name}: boolean, written as a bare ${name}. ${spec.doc}`
    case 'string':
      return `${name}${req}: string in double quotes. ${spec.doc}`
  }
}

export function describeCatalog(catalog: Catalog = CATALOG): string {
  return Object.entries(catalog)
    .map(([tag, spec]) => {
      const shape = spec.selfClosing ? `<${tag} ... />` : `<${tag}>...</${tag}>`
      const lines = [`${shape}: ${spec.doc}`]
      for (const [name, a] of Object.entries(spec.attrs)) lines.push(`  - ${describeAttr(name, a)}`)
      if (spec.children.length) lines.push(`  - may contain: ${spec.children.join(', ')}`)
      return lines.join('\n')
    })
    .join('\n')
}

// Examples span domains on purpose: with only math examples the model forced
// explanations and recipes into a worked-solution shape. They teach the spatial
// vocabulary (panel beside an object, marks on the object, arrows between
// them) against an example scene, not a template to copy.
const EXAMPLES = `Example. Scene: notebook at x 200-470, y 330-710. Request: "solve the task in my notebook" (the photo shows 2x + 6 = 14 on the third line).
<Canvas>
<Mark target="notebook" shape="underline" u={0.5} v={0.3} w={0.7}/>
<Panel id="steps" near="notebook" side="right" w={560}>
<Heading>Solve for x</Heading>
<Steps>
<Step><Text>Subtract 6 from both sides.</Text><Math>2x = 8</Math></Step>
<Step highlight><Text>Divide both sides by 2.</Text><Math>x = 4</Math></Step>
</Steps>
</Panel>
<Arrow from="#steps" to="notebook@0.85,0.3"/>
</Canvas>

Example. Scene: empty table. Request: "how does photosynthesis work".
<Canvas>
<Panel x={560} y={160} w={640}>
<Heading>Photosynthesis</Heading>
<Text>Plants turn light, water and carbon dioxide into sugar and oxygen.</Text>
<Math>6\\,CO_2 + 6\\,H_2O \\rightarrow C_6H_{12}O_6 + 6\\,O_2</Math>
<List><Item>Light is caught by chlorophyll in the leaves.</Item><Item>Water comes up from the roots.</Item><Item>Oxygen leaves through small pores.</Item></List>
<Note kind="tip">That is why leaves are green: chlorophyll reflects green light.</Note>
</Panel>
</Canvas>

Example. Scene: empty table. Request: "find the minimum of x^2 - 4x + 7".
<Canvas>
<Panel x={380} y={180} w={560}>
<Heading>Minimum of a parabola</Heading>
<Steps>
<Step><Text>Differentiate.</Text><Math>f'(x) = 2x - 4</Math></Step>
<Step><Text>Set it to zero.</Text><Equations>2x - 4 &= 0 \\\\ x &= 2</Equations></Step>
<Step highlight><Text>Evaluate f there.</Text><Math>f(2) = 3</Math></Step>
</Steps>
</Panel>
<Panel x={1000} y={180} w={560}>
<Plot fn="x^2 - 4*x + 7" xmin={-1} xmax={5} points="2,3" label="minimum at (2, 3)"/>
<Note kind="check">f''(x) = 2 > 0, so it is a minimum.</Note>
</Panel>
</Canvas>`

export function buildSystemPrompt(context: PromptContext, catalog: Catalog = CATALOG): string {
  const scene = context.scene ?? EMPTY_SCENE
  return [
    'You are the display brain of Hubble, a smart lamp that projects light onto a real table in front of the user.',
    'You do not talk. You decide what appears on the table and exactly where, using the components below.',
    '',
    'The table right now:',
    describeScene(scene),
    '',
    'Output rules:',
    `- Output exactly one ${ROOT_TAGS.join(' or ')} element and nothing else: no prose before or after, no markdown, no code fences.`,
    '- Use only the components listed. No HTML tags, no other components, no {expressions}, no JavaScript.',
    '- Attribute values are "strings", {numbers}, or a bare name for true.',
    '- You own the layout: place Panels with x/y/w or near an object, in free space. Use several Panels when it helps (work beside a graph, steps beside the notebook). Light on objects only through Mark, Label or Arrow.',
    '- Order matters: the table shows elements in the order you write them. Put things in the order the user should read them; a Mark on the object first draws the eye there.',
    '- Math contains raw LaTeX for one line, without $ signs. Equations holds multi-line LaTeX. Close them with </Math> and </Equations>, never with \\\\end.',
    '- Size it to the problem. Simple questions: one panel and a few short steps. Hard problems: several panels, Equations, Plot, Table, Columns, Note.',
    '- Text stays short: a few words per step, never paragraphs. It is read standing over a table.',
    context.hasImage
      ? '- A camera image of the relevant object is attached. Read it carefully (tasks, lines, words) and refer to positions in it with Mark u/v.'
      : '- There is no camera image; answer from the request and the scene.',
    '',
    'Components:',
    describeCatalog(catalog),
    '',
    EXAMPLES,
  ].join('\n')
}
