import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createPuppetInputChannel } from './puppetInput.ts'
import { mountPuppetMaster } from './puppetMaster.ts'
import { createStudioStore } from './studio.ts'

// Provenance: synthetic. Real HTTP over a real socket; the oracle is the SSE wire text
// read back by the test, not the channel's own state.
const config = { llm: { baseUrl: 'http://x', apiKey: 'k', model: 'm' } } as any
const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of closers.splice(0)) await c() })

async function serve(opts: { now?: () => number } = {}) {
  const app = express(); app.use(express.json())
  const input = createPuppetInputChannel(opts)
  mountPuppetMaster(app, config, createStudioStore(), { input })
  const server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  closers.push(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) })
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, input }
}
const post = (base: string, body: unknown) => fetch(`${base}/api/puppet/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
/** Read `data:` events until n arrived (breaks on done). */
async function events(base: string, n: number) {
  const res = await fetch(`${base}/api/puppet/input/events`); const reader = res.body!.getReader()
  let buf = ''; const out: any[] = []
  while (out.length < n) {
    const r = await reader.read(); if (r.done) break
    buf += new TextDecoder().decode(r.value)
    const parts = buf.split('\n\n'); buf = parts.pop()!
    for (const p of parts) if (p.startsWith('data: ')) out.push(JSON.parse(p.slice(6)))
  }
  await reader.cancel(); return out
}

describe('puppet input stream', () => {
  it('publishes a posted input to a listening page', async () => {
    // Break caught: SEND / pinch text being accepted by the server and never reaching the landing page.
    const { base } = await serve()
    const listening = events(base, 1)
    await new Promise(r => setTimeout(r, 50))
    expect((await post(base, { text: '  explain step 2 ', from: 'pinch' })).status).toBe(202)
    expect(await listening).toEqual([expect.objectContaining({ type: 'input', text: 'explain step 2', from: 'pinch', id: expect.any(String) })])
  })

  it('validates the body: blank, over 2000, unknown from, wrong types are 400 and nothing is published', async () => {
    // Break caught: an unbounded or non-string body becoming a model prompt.
    const { base, input } = await serve()
    for (const body of [{ text: '   ' }, { text: 'x'.repeat(2001) }, { text: 'hi', from: 'root' }, { text: 5 }, {}]) expect((await post(base, body)).status).toBe(400)
    expect((await post(base, { text: 'x'.repeat(2000) })).status).toBe(202)
    expect(input.publishChecked({ text: 'ok' })).toMatchObject({ ok: true, delivered: false })
  })

  it('holds an input nobody heard for 10 s and gives it to the next page once', async () => {
    // Break caught: (a) a SEND during the landing page's reconnect being lost, (c) a reload
    // replaying an input that already became a turn (asked, and spoken, twice).
    let now = 1_000
    const { base } = await serve({ now: () => now })
    await post(base, { text: 'fresh', from: 'keyboard' })
    now += 2_000
    expect((await events(base, 1)).map(e => e.text)).toEqual(['fresh'])
    const second = await Promise.race([events(base, 1), new Promise<'none'>(r => setTimeout(() => r('none'), 150))])
    expect(second).toBe('none')
  })

  it('does not hold an input a page already received', async () => {
    // Break caught: (b) a stale sentence answered out of the blue minutes later; and delivered
    // inputs being kept "just in case" and replayed to the next page.
    let now = 1_000
    const { base } = await serve({ now: () => now })
    const listening = events(base, 1)
    await new Promise(r => setTimeout(r, 50))
    await post(base, { text: 'delivered', from: 'keyboard' })
    await listening
    await new Promise(r => setTimeout(r, 50))
    expect(await Promise.race([events(base, 1), new Promise<'none'>(r => setTimeout(() => r('none'), 150))])).toBe('none')
  })

  it('drops an unheard input once it is older than 10 s', async () => {
    // Break caught: a sentence typed a minute ago answered out of the blue when a page opens.
    let now = 1_000
    const { base } = await serve({ now: () => now })
    await post(base, { text: 'old', from: 'keyboard' })
    now += 11_000
    expect(await Promise.race([events(base, 1), new Promise<'none'>(r => setTimeout(() => r('none'), 150))])).toBe('none')
  })

  it('delivers an input to ONLY the newest page and tells the older one it was superseded', async () => {
    // Break caught: every page running its own turn for one input (two `/` tabs
    // gave two different answers spoken on the real TVs, 7 Oct). Also: the older
    // page is not kept in the fan-out, and is told so it can stop following.
    const { base } = await serve()
    // Collect everything the older page receives for 400 ms: it must be exactly [superseded].
    const older = (async () => {
      const res = await fetch(`${base}/api/puppet/input/events`); const reader = res.body!.getReader()
      let buf = ''; const out: any[] = []; const stop = Date.now() + 400
      while (Date.now() < stop) {
        const r = await Promise.race([reader.read(), new Promise<null>(x => setTimeout(() => x(null), 100))])
        if (r === null) continue; if (r.done) break
        buf += new TextDecoder().decode(r.value)
        for (const p of buf.split('\n\n')) if (p.startsWith('data: ')) out.push(JSON.parse(p.slice(6)))
        buf = buf.slice(buf.lastIndexOf('\n\n') + 2)
      }
      await reader.cancel(); return out
    })()
    await new Promise(r => setTimeout(r, 50))
    const newer = events(base, 1)
    await new Promise(r => setTimeout(r, 50))
    await post(base, { text: 'only once', from: 'keyboard' })
    expect((await newer).map(e => e.text)).toEqual(['only once'])
    expect(await older).toEqual([expect.objectContaining({ type: 'superseded' })])
  })
})
