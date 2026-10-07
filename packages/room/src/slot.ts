import type { Room, WriteResult } from './room.ts'
import type { DisplayCommand, DisplayId, LightCommand, SlotInfo } from './spec.ts'

/**
 * Writes (displays, lights) are only allowed in our team's slot, and when a
 * slot ends the room resets displays to idle and lights to default. So the
 * *desired* output is kept here and reconciled whenever we may write: the
 * runtime only says what each display should show; this module makes it true
 * when, and as soon as, it is allowed.
 *
 * Review fixes (#11):
 * - authorisation expires locally at the slot's `until`, so a missed slot
 *   event can never leave us writing into another team's slot;
 * - reconciliation is serialised and re-checks authorisation before every
 *   send, so a 423 halfway through stops the rest and a stale flush can't
 *   overwrite a newer one;
 * - lights never go to the room directly: they go through the caller's
 *   rate-limited sender (the Hue-safe light player).
 */
export function inSlot(now: number, slots: SlotInfo[], team: string): boolean {
  return slots.some((s) => s.team === team && Date.parse(s.from) <= now && now < Date.parse(s.until))
}

export interface OutputState {
  displays: Partial<Record<DisplayId, DisplayCommand>>
  lights: Record<string, LightCommand>
}

export interface SlotWriterOptions {
  /** Our team. Without it (emulator default, legacy room) a 423 is the only signal. */
  team?: string
  now?: () => number
  /** Where light commands go: the Hue-safe player, never the room directly. */
  lights: { set(id: string, cmd: LightCommand): void }
  onChange?: (active: boolean, until: number | null) => void
  /**
   * The owner's arm switch, for the room as it is since 5 Oct: no slots or
   * tokens in code, so nothing on the wire stops a write from taking the
   * projector from another team. `false` starts closed, and only `arm(true)`
   * (the operator's "room output" switch) opens it. Omitted: the slot logic
   * below decides, as with the emulator.
   */
  armed?: boolean
}

export function createSlotWriter(room: Room, o: SlotWriterOptions) {
  const now = o.now ?? Date.now
  const desired: OutputState = { displays: {}, lights: {} }
  // Closed when arming is required and not given; else without a team,
  // assume allowed until told otherwise (the emulator's default).
  let until: number | null = o.armed === false || o.team ? 0 : Infinity
  let generation = 0
  let chain: Promise<unknown> = Promise.resolve()
  let expiry: ReturnType<typeof setTimeout> | null = null

  const active = () => until !== null && now() < until
  const setUntil = (u: number | null) => {
    until = u
    if (expiry) clearTimeout(expiry)
    if (u !== null && Number.isFinite(u) && u > now()) expiry = setTimeout(() => o.onChange?.(false, null), u - now())
    o.onChange?.(active(), u)
  }

  const send = async (gen: number, write: () => Promise<WriteResult>): Promise<boolean> => {
    if (gen !== generation || !active()) return false
    const r = await write()
    if (!r.ok && r.reason === 'locked') {
      setUntil(0)
      return false
    }
    return true
  }

  /** Re-applies everything desired; superseded by any newer reconcile. */
  const reconcile = () => {
    const gen = ++generation
    chain = chain.then(async () => {
      for (const [id, cmd] of Object.entries(desired.displays)) if (!(await send(gen, () => room.show(id as DisplayId, cmd!)))) return
      for (const [id, cmd] of Object.entries(desired.lights)) if (gen === generation && active()) o.lights.set(id, cmd)
    })
    return chain
  }

  return {
    desired,
    show(display: DisplayId, cmd: DisplayCommand) {
      desired.displays[display] = cmd
      return reconcile()
    },
    light(id: string, cmd: LightCommand) {
      desired.lights[id] = { ...desired.lights[id], ...cmd }
      if (active()) o.lights.set(id, desired.lights[id])
    },
    /** From the schedule (`GET /api/slots`) at start and after every reconnect. */
    syncSlots(slots: SlotInfo[]) {
      if (!o.team) return
      const t = now()
      const mine = slots.find((s) => s.team === o.team && Date.parse(s.from) <= t && t < Date.parse(s.until))
      const was = active()
      setUntil(mine ? Date.parse(mine.until) : 0)
      if (!was && active()) void reconcile()
    },
    /** From `/api/events` slot messages. */
    onSlotEvent(team: string, untilIso: string) {
      if (o.team && team !== o.team) {
        setUntil(0)
        return
      }
      setUntil(Date.parse(untilIso))
      // The room reset displays and lights when the previous slot ended:
      // put ours back.
      void reconcile()
    },
    isActive: active,
    /**
     * Open or close the gate by hand. Opening re-applies everything desired
     * (what the table should show, the mood lights), so arming puts Hubble on
     * the room at once; closing stops every later write but leaves the room
     * as it is (the owner decides what the room shows next, not us).
     */
    arm(on: boolean) {
      const was = active()
      setUntil(on ? Infinity : 0)
      if (on && !was) void reconcile()
    },
  }
}
