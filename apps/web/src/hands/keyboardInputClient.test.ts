import { expect, it, vi } from 'vitest'
import { createKeyboardInputClient } from './keyboardInputClient.ts'

it('releases a late grant after stop without adopting it or disabling a newer grant', async () => {
  // Schema-derived delayed HTTP reply. Aborting or ignoring a late reply leaves
  // the server in pinch mode; an unconditional teardown disables another tab.
  let resolve!: (response: Response) => void
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(() => new Promise(r => { resolve = r }))
    .mockResolvedValueOnce(Response.json({ token: 'new', revision: 4 }))
    .mockResolvedValue(Response.json({ mode: 'pointer' }))
  const c = createKeyboardInputClient(fetcher)
  const first = c.enable()
  c.disable()
  await c.enable()
  resolve(Response.json({ token: 'old', revision: 3 }))
  expect(await first).toBe(false)
  expect(c.current()).toEqual({ token: 'new', revision: 4 })
  expect(JSON.parse(fetcher.mock.calls[2]![1]!.body as string)).toEqual({ mode: 'pointer', token: 'old' })
  c.disable()
  expect(c.current()).toBeUndefined()
  expect(JSON.parse(fetcher.mock.calls[3]![1]!.body as string)).toEqual({ mode: 'pointer', token: 'new' })
})

it('does not grant input when the keyboard or room calibration is missing', async () => {
  const c = createKeyboardInputClient(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'open the keyboard first' }, { status: 409 })))
  await expect(c.enable()).rejects.toThrow('open the keyboard first')
  expect(c.current()).toBeUndefined()
})
