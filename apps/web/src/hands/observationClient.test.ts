import { expect, it, vi } from 'vitest'
import { createObservationClient } from './observationClient.ts'

it('replaces pending frames and never retries or posts after teardown', async () => {
  // Schema-derived transport sequence: a blocked upload must not queue a
  // second of hand motion and replay it when Wi-Fi recovers.
  let release!: (r: Response) => void
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r
        }),
    )
    .mockResolvedValue(new Response(null, { status: 202 }))
  const client = createObservationClient(fetcher)
  const frame = { session: 'one', seq: 1, capturedAt: 1, geometry: 'room:full-frame', width: 1920, height: 1080, hands: [] }
  client.post(frame)
  client.post({ ...frame, seq: 2 })
  client.post({ ...frame, seq: 3 })
  expect(fetcher).toHaveBeenCalledTimes(1)
  release(new Response(null, { status: 202 }))
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).seq).toBe(3)
  client.stop()
  client.post({ ...frame, seq: 4 })
  expect(fetcher).toHaveBeenCalledTimes(2)
})
