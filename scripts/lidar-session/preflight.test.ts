import { expect, it } from 'vitest'
import { preflight } from './preflight.ts'

/**
 * The guided take's window preflight (Codex P1 on PR #90). Oracle: the owner's
 * rule written out as literal instants, independent of window.ts. On 7 Oct 2026
 * Stockholm is CEST (UTC+2), so 12:MM local is 10:MM Z. The window is
 * n:10–n:30 (AGENTS.md).
 */
const at = (mm: string) => Date.parse(`2026-10-07T10:${mm}:00Z`)
const lidar = 'http://192.168.42.24:8080' // never contacted: preflight only parses it
const short = { takeMs: 60_000, url: lidar, takeId: 'R4' }

// Break caught: the old inline check (laptop clock, `getMinutes() >= 20`)
// allowed :05/:09, when another team owns the room.
it('refuses before the window opens (:09)', () => {
  const v = preflight({ ...short, nowMs: at('09') })
  expect(v.ok).toBe(false)
  expect(!v.ok && v.reason).toMatch(/n:10–n:30.*closed.*opens at 12:10/)
})

// Break caught: an off-by-one at the opening edge.
it('allows a take at the opening minute (:10)', () => {
  expect(preflight({ ...short, nowMs: at('10') })).toEqual({ ok: true })
})

// Break caught: the old check refused :25 (it still believed the window ended at :20).
it('allows a short take at :25', () => {
  expect(preflight({ ...short, nowMs: at('25') })).toEqual({ ok: true })
})

// Break caught: a take that would run past :30 must not start (never start at :28 hoping).
it('refuses at :29 a take that would end after :30', () => {
  const v = preflight({ ...short, nowMs: at('29') })
  expect(v.ok).toBe(false)
  expect(!v.ok && v.reason).toMatch(/closes at 12:30/)
})

// Break caught: the closing edge itself is outside the window.
it('refuses at :30', () => {
  expect(preflight({ ...short, nowMs: at('30') }).ok).toBe(false)
})

// Break caught: gating loopback would block the emulator/replay, allowed any time.
it('always allows loopback', () => {
  expect(preflight({ ...short, url: 'http://127.0.0.1:8790', nowMs: at('09') })).toEqual({ ok: true })
})
