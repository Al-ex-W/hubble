import { useEffect, useState } from 'react'

/**
 * Setup's "which page is on which display" (projector, TV 1, TV 2). The
 * choices and the URLs are the server's (apps/server/displays.ts); this only
 * names a page. The write goes through the runtime's slot-gated writer, so
 * while room output is "safe" a choice is remembered and applied on arm, and
 * the hardware window still holds every device write.
 */
export type Displays = {
  displays: Record<string, string>
  pages: string[]
  /** Each page's path on this origin (the server's PAGE_PATH), so the previews never keep a second copy of the map. */
  paths?: Record<string, string>
  output?: { active: boolean; requiresArm: boolean }
}

export const DISPLAY_LABEL: Record<string, string> = { table: 'Projector', 'tv-1': 'TV 1', 'tv-2': 'TV 2' }

/**
 * One shared copy of the server's display map for this page: Setup's selects
 * and the Screens previews (ScreensPreview.tsx) both read it, so a re-point
 * here relabels and reloads the matching preview at once, with one fetch.
 */
let current: Displays | null = null
let loading: Promise<void> | null = null
const listeners = new Set<(d: Displays | null) => void>()
const publish = (d: Displays) => {
  current = d
  listeners.forEach((l) => l(d))
}
const load = () =>
  (loading ??= fetch('/api/operator/displays')
    .then((r) => (r.ok ? r.json() : null))
    .then((j: Displays | null) => {
      if (j) publish(j)
    })
    .catch(() => undefined)
    .finally(() => {
      loading = null
    }))

export function useDisplays(): [Displays | null, (id: string, page: string) => Promise<string | null>] {
  const [d, setD] = useState<Displays | null>(current)
  useEffect(() => {
    listeners.add(setD)
    void load()
    return () => void listeners.delete(setD)
  }, [])
  const choose = async (id: string, page: string) => {
    const r = await fetch('/api/operator/displays', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, page }) }).catch(() => null)
    const j = (await r?.json().catch(() => null)) as (Displays & { error?: string }) | null
    if (!r?.ok || !j) return j?.error ?? 'display change failed'
    publish(j)
    return null
  }
  // Also null for a server without the route (a test's fetch stub, an older server).
  return [d?.displays && Array.isArray(d.pages) ? d : null, choose]
}

export function DisplaysControl() {
  const [d, chooseDisplay] = useDisplays()
  const [error, setError] = useState<string | null>(null)
  if (!d) return null
  const choose = async (id: string, page: string) => {
    setError(null)
    setError(await chooseDisplay(id, page))
  }
  return (
    <div className="projector-mode" aria-label="displays">
      {Object.keys(DISPLAY_LABEL).map((id) => (
        <label key={id}>
          <span>{DISPLAY_LABEL[id]}</span>{' '}
          <select value={d.displays[id] ?? 'off'} onChange={(e) => void choose(id, e.target.value)}>
            {d.pages.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      ))}
      {d.output?.requiresArm && !d.output.active && <small>safe: applied when armed</small>}
      {error && <span className="projector-mode-error" role="alert">{error}</span>}
    </div>
  )
}
