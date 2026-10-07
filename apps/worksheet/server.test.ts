import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createWorksheetApp } from './server.ts'

let server: Server | undefined
afterEach(() => server?.close())

async function start() {
  const app = createWorksheetApp()
  server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server!.once('listening', r))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

/** Reads SSE data lines from a real HTTP stream until `n` have arrived. */
async function events(url: string, n: number, during: () => Promise<unknown>) {
  const ac = new AbortController()
  const res = await fetch(url, { signal: ac.signal })
  const reader = res.body!.getReader()
  const out: { taskId: string; taskIds: string[]; tasks: { lines: string[] }[]; textMm: number }[] = []
  let buf = ''
  const pending = during()
  while (out.length < n) {
    const { value, done } = await reader.read()
    if (done) break
    buf += new TextDecoder().decode(value)
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const chunk = buf.slice(0, i)
      buf = buf.slice(i + 2)
      if (chunk.startsWith('data: ')) out.push(JSON.parse(chunk.slice(6)))
    }
  }
  await pending
  ac.abort()
  return out
}

describe('worksheet server', () => {
  it('pushes a task switch to an open iPad page', async () => {
    // Catches: the iPad not following the operator (the whole point of the
    // stream). Real HTTP, real SSE.
    const base = await start()
    const got = await events(`${base}/api/events`, 2, () =>
      fetch(`${base}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: 'integral' }) }),
    )
    expect(got.map((v) => v.taskId)).toEqual(['linear', 'integral'])
  })

  it('pushes a few problems at once to an open iPad page (#88)', async () => {
    // Catches: the stream carrying only the first pick (the pre-#88 fields),
    // so the iPad shows one problem while the brain is told three.
    const base = await start()
    const got = await events(`${base}/api/events`, 2, () =>
      fetch(`${base}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskIds: ['system', 'limit', 'linear'] }) }),
    )
    // linear was problem 1 on the default sheet and keeps it; the new two follow in the order sent.
    expect(got[1]!.taskIds).toEqual(['linear', 'system', 'limit'])
    expect(got[1]!.tasks).toHaveLength(3)
    expect(got[1]!.tasks[1]!.lines).toHaveLength(3)
  })

  it('answers a bad patch with 400 and keeps the iPad as it was', async () => {
    const base = await start()
    const r = await fetch(`${base}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: 'nope' }) })
    expect(r.status).toBe(400)
    expect(((await (await fetch(`${base}/api/state`)).json()) as { taskId: string }).taskId).toBe('linear')
  })

  it('serves the iPad page and its script', async () => {
    const base = await start()
    expect(await (await fetch(`${base}/`)).text()).toContain("import { drawRuler, follow } from './ipad.js'")
    expect((await fetch(`${base}/ipad.js`)).headers.get('content-type')).toMatch(/javascript/)
  })
})
