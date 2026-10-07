export interface InputGrant { token: string; revision: number }

/** A grant belongs to this start/stop cycle, not to a mounted component forever.
 * Keep a late enable reply alive long enough to release its grant: aborting the
 * request cannot undo a mode change the server has already accepted. A newer
 * grant is protected by the server's compare-token teardown.
 */
export function createKeyboardInputClient(fetcher: typeof fetch = fetch) {
  let generation = 0
  let grant: InputGrant | null = null
  const release = (value: InputGrant) => fetcher('/api/keyboard/input', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'pointer', token: value.token }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => undefined)
  return {
    current: () => grant ? { ...grant } : undefined,
    async enable() {
      const run = ++generation
      const res = await fetcher('/api/keyboard/input', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'room-pinch' }), signal: AbortSignal.timeout(3000),
      })
      const body = await res.json() as InputGrant & { error?: string }
      if (!res.ok) throw new Error(body.error ?? 'Cannot enable pinch typing')
      if (run !== generation) { await release(body); return false }
      grant = { token: body.token, revision: body.revision }
      return true
    },
    disable() {
      generation++
      const old = grant
      grant = null
      if (old) void release(old)
    },
  }
}
