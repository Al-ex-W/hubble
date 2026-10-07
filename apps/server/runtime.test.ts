import { displaysFromConfig } from './displays.ts'
import { describe, expect, it } from 'vitest'
import type { OverlayLine } from '@hubble/stage'
import { createLiveRoom, keyQuads } from '@hubble/room'
import { startEmulator } from '../room-emulator/index.ts'
import { createRuntime, lanAddress, webOrigin } from './runtime.ts'

/**
 * The lesson's light, end to end through the runtime (label: schema-derived:
 * MIDI note numbers in, overlay shapes out), and the runtime driving the
 * spec emulator's displays (label: schema-derived, over real HTTP).
 */
const keybed = { corners: [{ x: 600, y: 1000 }, { x: 1200, y: 1000 }, { x: 1200, y: 880 }, { x: 600, y: 880 }] as never, lowestNote: 48 }
const center = (pts: { x: number; y: number }[]) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length })
const keyAt = (note: number) => center(keyQuads(keybed).find((k) => k.note === note)!.corners)

describe('runtime lesson light', () => {
  it('lights the next key green, flashes a wrong key red, and moves on only when right', () => {
    let t = 0
    const lines: OverlayLine[] = []
    const rt = createRuntime({ overlay: (l) => lines.push(l), now: () => t })
    rt.setKeybed(keybed)
    rt.startLesson('ode-to-joy') // E4 E4 F4 …
    // The next-key ring (#120, #becaff) is drawn too; these checks are about the
    // current key and the red flash, so they read the lit-key shapes only.
    const last = () => { const l = lines.at(-1)!; return { ...l, shapes: l.shapes.filter((x: { color: string }) => x.color !== '#becaff') } }
    expect(last().shapes).toHaveLength(1)
    expect(last().shapes[0].color).toBe('#36ff7a')
    expect(center(last().shapes[0].points)).toEqual(keyAt(64))

    rt.midi({ type: 'note-on', note: 62, velocity: 90 }) // wrong: D4
    expect(last().shapes.map((s) => s.color).sort()).toEqual(['#36ff7a', '#ff3b3b'])
    // Break caught: the lesson advancing on a wrong key.
    expect(center(last().shapes.find((s) => s.color === '#36ff7a')!.points)).toEqual(keyAt(64))

    t += 1000 // the red flash has ended
    rt.midi({ type: 'note-on', note: 64, velocity: 90 })
    t += 300 // a real repeated E is a separate press, well over 150 ms later
    rt.midi({ type: 'note-on', note: 64, velocity: 90 })
    expect(last().shapes).toHaveLength(1)
    expect(center(last().shapes[0].points)).toEqual(keyAt(65)) // F4 next
  })

  // Break caught (recorded on site, 2026-10-07): one press arriving twice
  // advanced the lesson and then flashed the pressed key red, judged against
  // the next note. A copy within 150 ms is dropped; a real repeat is not.
  it('drops a duplicate of the same press, but counts a real repeated note', () => {
    let t = 0
    const lines: OverlayLine[] = []
    const rt = createRuntime({ overlay: (l) => lines.push(l), now: () => t })
    rt.setKeybed(keybed)
    rt.startLesson('twinkle') // C4 C4 G4 …
    // The next-key ring (#120, #becaff) is drawn too; these checks are about the
    // current key and the red flash, so they read the lit-key shapes only.
    const last = () => { const l = lines.at(-1)!; return { ...l, shapes: l.shapes.filter((x: { color: string }) => x.color !== '#becaff') } }
    rt.midi({ type: 'note-on', note: 60, velocity: 90 })
    t += 5 // the duplicate: same note, a few ms later
    expect(rt.midi({ type: 'note-on', note: 60, velocity: 90 })).toBeNull()
    expect(last().shapes.map((s) => s.color)).toEqual(['#36ff7a']) // no red
    expect(center(last().shapes[0].points)).toEqual(keyAt(60)) // second C still expected
    t += 300
    expect(rt.midi({ type: 'note-on', note: 60, velocity: 90 })).toMatchObject({ kind: 'correct' })
    expect(center(last().shapes[0].points)).toEqual(keyAt(67)) // G4 next
    expect(rt.health().duplicateNotes).toBe(1)
  })

  it('ignores note-off and zero-velocity note-on (MIDI running-status release)', () => {
    const lines: OverlayLine[] = []
    const rt = createRuntime({ overlay: (l) => lines.push(l) })
    rt.setKeybed(keybed)
    rt.startLesson('twinkle')
    expect(rt.midi({ type: 'note-on', note: 60, velocity: 0 })).toBeNull()
    expect(rt.midi({ type: 'note-off', note: 60, velocity: 0 })).toBeNull()
    expect(rt.state().lesson?.index).toBe(0)
  })
})

describe('runtime ↔ room (emulator)', () => {
  it('points every display at its mapped page on start, and re-points one through the same writer', async () => {
    // Breaks caught: a display left off the start (TV 1's mirror or TV 2's
    // data wall never shown when armed), a page URL built without the laptop's
    // base, and a Setup re-point that bypasses the writer (the emulator would
    // still show the old page).
    const emu = await startEmulator(0)
    const room = createLiveRoom({ base: emu.url, token: emu.token, kind: 'emulator' })
    const rt = createRuntime({ overlay: () => {}, room, team: emu.team, publicBase: 'http://laptop.test:5173', autoTick: false })
    await rt.start()
    // Read what the emulator now believes each display shows.
    const read = async () => {
      const res = await fetch(`${emu.url}/emulator/state`)
      const reader = res.body!.getReader()
      const { value } = await reader.read()
      reader.cancel()
      return JSON.parse(new TextDecoder().decode(value).replace(/^data: /, '').trim())
    }
    let state = await read()
    expect(state.displays.table).toEqual({ type: 'url', url: 'http://laptop.test:5173/table' })
    expect(state.displays['tv-1']).toEqual({ type: 'url', url: 'http://laptop.test:5173/datawall' })
    // TV 2 is `manual` (a teammate runs it by hand): start must never write to it.
    expect(JSON.stringify(state.displays['tv-2'] ?? null)).not.toContain('laptop.test')
    expect(await rt.setDisplay('tv-2', 'off')).toMatchObject({ 'tv-2': 'off' })
    state = await read()
    expect(state.displays['tv-2']).toEqual({ type: 'blank' })
    rt.stop()
    room.close()
    emu.close()
  })
})

describe('displaysFromConfig: room.config.json overrides the mapping', () => {
  it('lays valid entries over the defaults and ignores bad ones', () => {
    // Breaks caught: a typo in room.config.json crashing boot, or an unknown
    // page name reaching a shared TV as a URL.
    expect(displaysFromConfig(null)).toEqual({ table: 'table', 'tv-1': 'datawall', 'tv-2': 'manual' })
    expect(displaysFromConfig({ displays: { 'tv-2': 'tv', 'tv-1': 'nope', 'tv-9': 'off' } })).toEqual({ table: 'table', 'tv-1': 'datawall', 'tv-2': 'tv' })
  })
})

describe('webOrigin: where the room reaches our pages', () => {
  it('is the web app port on this laptop, or PUBLIC_BASE, never the server port', () => {
    // Breaks caught: the iPad or the projector sent to a port other than the
    // web app's (the owner, 7 Oct: "we only have a 5173"), e.g. the
    // worksheet's own :8793, which now listens on loopback and would be
    // unreachable; and a PUBLIC_BASE with a trailing slash making
    // "//worksheet/" and "//table". Oracle: plain string expectations.
    expect(webOrigin('http://hubble.local:5173/')).toBe('http://hubble.local:5173')
    const lan = lanAddress()
    expect(webOrigin()).toBe(lan ? `http://${lan}:5173` : null)
  })
})
