// Types for ipad.js, which stays plain JS so the server can serve it with no
// build step; only the tests import it from TypeScript.
export const PX_PER_MM: number
export function mm(v: number): string
export const FIT_FLOOR_MM: number
export function render(root: HTMLElement, view: { textMm: number; task: { id: string; lines: string[] }; tasks?: { id: string; lines: string[] }[]; numbers?: number[] }): void
export function fit(root: HTMLElement, list: HTMLElement, textMm: number): number
