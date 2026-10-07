/** One design contract is shared by the generator, examples and frame runtime.
 * Keeping the model's API here prevents a prompt drifting from the actual kit. */
export const UI_CONTRACT = `
Write one complete React component as TSX: export default function Component().
React is available, including React.useState, React.useEffect and React.useMemo.
UI is available with these components:
UI.Card({children, className?}), UI.Stack({children, gap?}),
UI.Row({children}), UI.Text({children, muted?, size?: "small"|"body"|"large"}),
UI.Heading({children}), UI.Badge({children}),
UI.Button({children, onClick, variant?: "primary"|"quiet", disabled?}),
UI.Slider({label, value, onChange(number), min?, max?, step?, unit?}),
UI.Tabs({options: string[], value: string, onChange(string)}),
UI.Stat({label, value, unit?}), UI.Progress({value: number from 0 to 100}),
UI.Math({tex: string, label?}), UI.Input({label, value, onChange(string), placeholder?}).
Use UI components for all panels, text and controls. Native SVG/canvas are allowed
for custom diagrams; use currentColor and CSS variables --liquid-accent,
--liquid-ink, --liquid-muted, --liquid-line. Use a compact responsive layout.
Do not import packages, use require, access the parent window, make network requests,
load external assets, write global CSS, or use dangerouslySetInnerHTML.
Make the component genuinely interactive, with its own hooks and JavaScript.
Clean up intervals, listeners and subscriptions in effect cleanup functions.
Use UI.Math for LaTeX, with escaped backslashes in JavaScript strings.
Return only source code, without markdown fences or explanation.
`

export interface ComponentDocument {
  id: string
  revision: number
  title: string
  prompt: string
  source: string
  javascript: string
}
export interface StudioSnapshot { documents: ComponentDocument[] }
export const MAX_COMPONENT_SOURCE = 50_000
export const MAX_COMPONENT_JAVASCRIPT = 150_000
