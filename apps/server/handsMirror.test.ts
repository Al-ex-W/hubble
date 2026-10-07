import type { AddressInfo } from 'node:net'
import express from 'express'
import { describe, expect, it } from 'vitest'
import { mountHandsMirror } from './handsMirror.ts'

/*
 * The tracker → operator mirror over real HTTP. Fixture: schema-derived (a
 * 21-point hand in MediaPipe order, the shape apps/web/src/hands/types.ts
 * gives); no recording needed, the contract is the shape and the age.
 */
async function withMirror<T>(fn: (base: string, tick: (ms: number) => void) => Promise<T>) {
  let t = 1000
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  mountHandsMirror(app, () => t)
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, (ms) => (t += ms))
  } finally {
    server.close()
  }
}
const hand = { lm: Array.from({ length: 21 }, (_, i) => [100 + i, 200 + i]) }
const post = (base: string, body: unknown) => fetch(`${base}/api/input/hands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('the hands mirror', () => {
  it('serves the latest snapshot with its age, so a stopped tracker reads as stale', async () => {
    await withMirror(async (base, tick) => {
      expect(await (await fetch(`${base}/api/input/hands`)).json()).toEqual({ ageMs: null })
      expect((await post(base, { source: 'room', width: 1920, height: 1080, pinch: true, hands: [hand] })).status).toBe(204)
      tick(1500)
      const got = await (await fetch(`${base}/api/input/hands`)).json()
      // Break caught: a frozen hand drawn forever after the tracker stopped
      // (the view needs the age to tell live from stale).
      expect(got).toMatchObject({ ageMs: 1500, source: 'room', pinch: true })
      expect(got.hands[0].lm[8]).toEqual([108, 208])
    })
  })

  it('refuses a malformed snapshot and keeps the last good one', async () => {
    await withMirror(async (base) => {
      await post(base, { source: 'room', width: 1920, height: 1080, pinch: false, hands: [hand] })
      // Break caught: a short hand (20 points) indexing past its end in the
      // operator's bone drawing, or a third hand from a buggy client.
      expect((await post(base, { source: 'room', width: 1920, height: 1080, pinch: false, hands: [{ lm: hand.lm.slice(1) }] })).status).toBe(400)
      expect((await post(base, { source: 'room', width: 1920, height: 1080, pinch: false, hands: [hand, hand, hand] })).status).toBe(400)
      expect((await (await fetch(`${base}/api/input/hands`)).json()).hands).toHaveLength(1)
    })
  })
})
