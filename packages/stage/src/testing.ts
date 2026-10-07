import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Scene } from './scene.ts'

/**
 * Access to the recorded model streams for tests in any package. The
 * recordings live with the engine because they are its contract with
 * reality: the parser, the director, the server and the typesetter are all
 * tested against the same files. Test-only (uses node:fs).
 */
// Built from strings, never `new URL(...)`: DOM test environments (happy-dom)
// replace the global URL with one node:url and node:fs refuse.
export const STREAMS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/stage-streams/')

export interface RecordedStream {
  name: string
  /** Raw SSE `data:` payloads in order, including the final `[DONE]`. */
  payloads: string[]
  /** Arrival time (ms since request) of each payload. */
  times: number[]
  /** The content deltas only, in order. */
  deltas: string[]
  /** All content joined. */
  text: string
  /** The table the model was shown, for scene-aware recordings. */
  scene: Scene | null
}

export function listRecordings(): string[] {
  return readdirSync(STREAMS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace('.jsonl', ''))
    .sort()
}

export function loadRecording(name: string): RecordedStream {
  const all = readFileSync(`${STREAMS_DIR}${name}.jsonl`, 'utf8').trim().split('\n')
  const meta = (JSON.parse(all[0]) as { meta?: { scene?: Scene | null } }).meta
  const lines = all.slice(1)
  const payloads: string[] = []
  const times: number[] = []
  const deltas: string[] = []
  for (const line of lines) {
    const { t, data } = JSON.parse(line) as { t: number; data: string }
    payloads.push(data)
    times.push(t)
    if (data === '[DONE]') continue
    const content = (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content
    if (content) deltas.push(content)
  }
  return { name, payloads, times, deltas, text: deltas.join(''), scene: meta?.scene ?? null }
}
