/**
 * Jev (TypeSafe's decision model) as an optional placement judge.
 *
 * Measured on 2026-10-05: it separates "panel beside the referenced object"
 * well (0.76 vs 0.20) but cannot check math (caught 1 of 4 broken solutions),
 * so it only ever answers placement questions here, and only when a key is set.
 */
export interface JevConfig {
  apiKey: string
  fetchImpl?: typeof fetch
}

export async function jevNoul(cfg: JevConfig, state: unknown, instructions: string, signal?: AbortSignal): Promise<number | null> {
  const res = await (cfg.fetchImpl ?? fetch)('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state, questions: { q: { type: 'noul', instructions } } }),
    // Its own 2.5 s budget, and the render's signal too: a cancelled render
    // must not keep a paid request open.
    signal: signal ? AbortSignal.any([AbortSignal.timeout(2500), signal]) : AbortSignal.timeout(2500),
  }).catch(() => null)
  if (!res?.ok) return null
  const body = (await res.json().catch(() => null)) as { answers?: { q?: { noul?: number } } } | null
  const v = body?.answers?.q?.noul
  return typeof v === 'number' ? v : null
}
