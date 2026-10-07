// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { ProblemsMenu } from './ProblemsMenu.tsx'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The reviewer's repro (review of #93), kept as a test. Schema-derived: the
// status's worksheet shape, and response timing matching the 502 seen when
// two first ticks overlapped a cold start: an earlier send fails while a
// newer one is still pending. Oracle: the request bodies the menu sends.
it('an older failed tick never drops newer pending picks', async () => {
  const sheet = { on: true, url: null, ruler: false, shown: { taskId: 'linear', taskIds: ['linear'], numbers: [1], textMm: 8 }, maxPicks: 4, tasks: ['linear', 'limit', 'system', 'integral'].map((id) => ({ id, task: id })) }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const sent: string[][] = []
  const complete: ((v: { ok: boolean }) => void)[] = []
  const send = (ids: string[]) => {
    sent.push(ids)
    return new Promise<{ ok: boolean }>((r) => complete.push(r))
  }
  const click = (id: string) => act(async () => host.querySelector<HTMLInputElement>(`input[aria-label="${id}"]`)!.click())
  try {
    await act(async () => root.render(createElement(ProblemsMenu, { sheet, send })))
    await act(async () => host.querySelector('button')!.click())
    await click('limit')
    await click('system')
    await act(async () => complete[0]!({ ok: false }))
    await click('integral')
    // Catches: any completion clearing the local list (the bug sent
    // [linear, integral]).
    expect(sent[2]).toEqual(['linear', 'limit', 'system', 'integral'])
    // ...while the newest send failing does drop it, back to the server's.
    await act(async () => complete[2]!({ ok: false }))
    expect(host.querySelector<HTMLInputElement>('input[aria-label="integral"]')!.checked).toBe(false)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
