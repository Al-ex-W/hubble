import { describe, expect, it } from 'vitest'
import type { Room, WriteResult } from './room.ts'
import { createSlotWriter } from './slot.ts'

/**
 * Label: schema-derived (the spec's slot rules: writes only in our slot, 423
 * with next_slot outside it, reset at slot end). A fake room records writes.
 */
function fakeRoom(answer: () => WriteResult) {
  const shown: string[] = []
  const room = {
    kind: 'emulator',
    show: async (d: string, c: { type: string; url?: string }) => {
      const r = answer()
      if (r.ok) shown.push(`${d}:${c.url ?? c.type}`)
      return r
    },
  } as unknown as Room
  return { room, shown }
}

describe('createSlotWriter', () => {
  it('writes only inside our slot and stops when it expires, even if no event says so', async () => {
    let t = Date.parse('2026-10-07T10:00:00Z')
    const { room, shown } = fakeRoom(() => ({ ok: true }))
    const w = createSlotWriter(room, { team: 'hubble', now: () => t, lights: { set: () => {} } })
    await w.show('table', { type: 'url', url: 'a' })
    expect(shown).toEqual([]) // not our slot yet
    w.syncSlots([{ team: 'hubble', from: '2026-10-07T10:00:00Z', until: '2026-10-07T10:30:00Z' }])
    await new Promise((r) => setTimeout(r, 0))
    expect(shown).toEqual(['table:a']) // desired state applied when the slot starts
    t = Date.parse('2026-10-07T10:30:01Z')
    await w.show('table', { type: 'url', url: 'b' })
    // Break caught: writing into the next team's slot after a missed slot event.
    expect(shown).toEqual(['table:a'])
  })

  it('stops a reconcile at the first 423 instead of sending the rest', async () => {
    let calls = 0
    const { room } = fakeRoom(() => (++calls === 1 ? { ok: false, reason: 'locked', nextSlot: null } : { ok: true }))
    const w = createSlotWriter(room, { lights: { set: () => {} } }) // no team: 423 is the only signal
    w.desired.displays['tv-1'] = { type: 'url', url: 'tv' }
    await w.show('table', { type: 'url', url: 't' })
    expect(calls).toBe(1)
    expect(w.isActive()).toBe(false)
  })

  it('puts our displays back after the room resets them for a new slot of ours', async () => {
    const { room, shown } = fakeRoom(() => ({ ok: true }))
    const w = createSlotWriter(room, { team: 'hubble', lights: { set: () => {} } })
    await w.show('table', { type: 'url', url: 'answer' })
    w.onSlotEvent('hubble', new Date(Date.now() + 60_000).toISOString())
    await new Promise((r) => setTimeout(r, 0))
    expect(shown).toEqual(['table:answer'])
  })
})

describe('the arm switch (the room since 5 Oct: no slots in code)', () => {
  it('writes nothing until armed, everything desired on arming, nothing after disarming', async () => {
    // Catches: Hubble taking the shared projector from another team at boot
    // (owner's rule: no writes without the owner's go). Fake room records writes.
    const { room, shown } = fakeRoom(() => ({ ok: true }))
    const lit: string[] = []
    const w = createSlotWriter(room, { armed: false, lights: { set: (id) => lit.push(id) } })
    await w.show('table', { type: 'url', url: 'http://laptop/table' })
    w.light('spot-1', { on: true })
    expect(shown).toEqual([])
    expect(lit).toEqual([])

    w.arm(true)
    await w.show('tv-1', { type: 'idle' })
    expect(shown).toEqual(['table:http://laptop/table', 'tv-1:idle'])
    expect(lit).toEqual(['spot-1'])

    w.arm(false)
    await w.show('table', { type: 'blank' })
    w.light('spot-2', { on: true })
    expect(shown).toEqual(['table:http://laptop/table', 'tv-1:idle'])
    expect(lit).toEqual(['spot-1'])
  })
})
