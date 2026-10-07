import { useId, useMemo, type ReactNode } from 'react'
import katex from 'katex'

type Children = { children: ReactNode }
export function Card({ children, className = '' }: Children & { className?: string }) { return <section className={`liquid-card ${className}`}>{children}</section> }
export function Stack({ children, gap = 20 }: Children & { gap?: number }) { return <div className="liquid-stack" style={{ gap }}>{children}</div> }
export function Row({ children }: Children) { return <div className="liquid-row">{children}</div> }
export function Text({ children, muted, size = 'body' }: Children & { muted?: boolean; size?: 'small' | 'body' | 'large' }) { return <p className={`liquid-text liquid-text--${size}${muted ? ' liquid-muted' : ''}`}>{children}</p> }
export function Heading({ children }: Children) { return <h2 className="liquid-heading">{children}</h2> }
export function Badge({ children }: Children) { return <span className="liquid-badge">{children}</span> }
export function Button({ children, onClick, variant = 'primary', disabled }: Children & { onClick?: () => void; variant?: 'primary' | 'quiet'; disabled?: boolean }) { return <button type="button" className={`liquid-button liquid-button--${variant}`} onClick={onClick} disabled={disabled}>{children}</button> }
export function Slider({ label, value, onChange, min = 0, max = 100, step = 1, unit = '' }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; unit?: string }) {
  const id = useId()
  return <div className="liquid-field"><label htmlFor={id}>{label}<output>{Number(value.toFixed(2))}{unit && ` ${unit}`}</output></label><input id={id} type="range" value={value} min={min} max={max} step={step} onChange={e => onChange(Number(e.target.value))} /></div>
}
export function Input({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  const id = useId()
  return <div className="liquid-field"><label htmlFor={id}>{label}</label><input id={id} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} /></div>
}
export function Tabs({ options, value, onChange }: { options: string[]; value: string; onChange: (value: string) => void }) { return <div className="liquid-tabs" role="group" aria-label="Choose an option">{options.map(option => <button key={option} type="button" aria-pressed={value === option} onClick={() => onChange(option)}>{option}</button>)}</div> }
export function Stat({ label, value, unit }: { label: string; value: ReactNode; unit?: string }) { return <div className="liquid-stat"><div>{value}<small>{unit}</small></div><p>{label}</p></div> }
export function Progress({ value }: { value: number }) { return <div className="liquid-progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${globalThis.Math.max(0, globalThis.Math.min(100, value))}%` }} /></div> }
export function Math({ tex, label }: { tex: string; label?: string }) {
  // KaTeX supplies real mathematical glyphs; changing the surrounding UI font
  // alone would never change SVG paths in the existing MathJax renderer.
  const result = useMemo(() => {
    try { return { html: katex.renderToString(tex, { throwOnError: true, trust: false, strict: 'warn', maxExpand: 1000, maxSize: 20, output: 'htmlAndMathml' }) } }
    catch { return { error: 'This equation could not be typeset.' } }
  }, [tex])
  return <div className="liquid-math">{label && <span className="liquid-math-label">{label}</span>}{result.html ? <div dangerouslySetInnerHTML={{ __html: result.html }} /> : <p role="status">{result.error}</p>}</div>
}
