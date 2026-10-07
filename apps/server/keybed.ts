/**
 * Asks the keybed sidecar (apps/keybed/service.py) where the MiniLab's keys
 * are in a camera frame.
 *
 * The sidecar is the proven Python detector + tracker (#36); this client is
 * the only way the server reaches it. Its one promise is that the camera loop
 * can't be hurt by it: every failure (no sidecar, a timeout, a 500, a body
 * that isn't what we expect) is `null`, never a throw and never a wait past
 * the deadline, and the runtime then falls back to perceive.ts.
 */
export type P = { x: number; y: number }

export interface KeybedKey {
  note: number
  black: boolean
  /** Camera px of the posted frame: near-left, near-right, far-right, far-left (near = the player's edge). */
  corners: [P, P, P, P]
}

export interface KeybedTrack {
  /** The tracker's view: locked / tracked / refined / moved / occluded / lost / searching (or detected / none for /detect). */
  status: string
  /** All 25 keys, or null when it has never found the keyboard. */
  keys: KeybedKey[] | null
  keybed: [P, P, P, P] | null
  visibleBlack: number | null
}

// A look happens every 2 s and the sidecar answers in ~100-300 ms; 1.5 s is a
// stuck sidecar, and waiting longer would stack looks up behind it.
const DEFAULT_DEADLINE_MS = 1500

function parseQuad(raw: unknown): [P, P, P, P] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null
  const pts = raw.map((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v)) ? { x: p[0] as number, y: p[1] as number } : null)
  return pts.some((p) => p === null) ? null : pts as [P, P, P, P]
}

function parseKeys(raw: unknown): KeybedKey[] | null {
  if (!Array.isArray(raw) || raw.length !== 25) return null
  const out: KeybedKey[] = []
  for (const k of raw as { note?: unknown; black?: unknown; corners?: unknown }[]) {
    const corners = parseQuad(k?.corners)
    if (typeof k?.note !== 'number' || !Number.isInteger(k.note) || typeof k.black !== 'boolean' || !corners) return null
    out.push({ note: k.note, black: k.black, corners })
  }
  return out
}

export function createKeybedClient(opts: { url: string; deadlineMs?: number; fetchImpl?: typeof fetch }) {
  const deadline = opts.deadlineMs ?? DEFAULT_DEADLINE_MS
  const f = opts.fetchImpl ?? fetch
  const call = async (path: string, jpeg: Uint8Array): Promise<KeybedTrack | null> => {
    // `new Uint8Array` copies into a plain ArrayBuffer, which fetch's BodyInit
    // type requires (a camera frame may arrive as a view on a shared buffer);
    // a frame is at most a few MB every 2 s.
    try {
      const res = await f(`${opts.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array(jpeg), signal: AbortSignal.timeout(deadline) })
      if (!res.ok) return null
      const b = (await res.json()) as { status?: unknown; keys?: unknown; visibleBlack?: unknown; keybed?: unknown }
      if (typeof b?.status !== 'string') return null
      // A keys field that is present but malformed is a broken answer, not
      // "no keyboard": refusing it keeps half-parsed corners off the table.
      const keys = b.keys === null || b.keys === undefined ? null : parseKeys(b.keys)
      if (b.keys && !keys) return null
      const keybed = b.keybed == null ? null : parseQuad(b.keybed)
      if (b.keybed != null && !keybed) return null
      return { status: b.status, keys, keybed, visibleBlack: typeof b.visibleBlack === 'number' ? b.visibleBlack : null }
    } catch {
      return null
    }
  }
  return {
    /** The tracker: holds the keyboard between frames (hands, projected light). */
    track: (jpeg: Uint8Array) => call('/track', jpeg),
    /** One stateless detection. */
    detect: (jpeg: Uint8Array) => call('/detect', jpeg),
  }
}

export type KeybedClient = ReturnType<typeof createKeybedClient>
