import { useState, useSyncExternalStore } from 'react'
import type { RenderRequest } from '@hubble/stage'
import { createRenderClient, type RenderRun } from './renderClient.ts'

export type { RenderRun } from './renderClient.ts'

export interface UseRender {
  run(req: RenderRequest): void
  cancel(): void
  current: RenderRun | null
  runs: RenderRun[]
}

/**
 * The bench's renders. All stream handling lives in createRenderClient so it
 * can be tested without a browser; this hook only gives each mounted bench its
 * own client and re-renders when the run list changes.
 */
export function useRender(): UseRender {
  const [client] = useState(() => createRenderClient())
  const runs = useSyncExternalStore(client.subscribe, client.getRuns)
  const current = runs.length > 0 ? runs[runs.length - 1] : null
  return { run: client.run, cancel: client.cancel, current, runs }
}
