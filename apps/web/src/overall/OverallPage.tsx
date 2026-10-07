import { useCallback, useEffect, useRef, useState } from 'react'
import { clientToPx, createPointerClient, pathFor, PROJECTOR, SCREEN, type Px } from './overallMath.ts'
import './overall.css'

/**
 * /overall: all three screens on one page, with touch simulation on the
 * projector (docs/plans/2026-10-07-overall-view.md).
 *
 * Owner, 7 Oct: "make an 'overall view' with iframes showing exactly what they
 * are currently displaying ... this should work even when not connected to the
 * real deal, with a simple switch to make it also render on the real thing."
 *
 * - Each frame is the real page the room's display loads (the server's
 *   PAGE_PATH), at its native size, scaled to fit: what you see here is what
 *   the kiosk shows by construction, not a re-drawing.
 * - EMULATED (default): nothing here touches the room; the frames are the
 *   screens. LIVE: the same choices are pushed to the real displays through
 *   the server's existing re-point path, which refuses outside the hardware
 *   window and keeps the owner's arm switch (the page only reports it).
 * - The projector frame carries a transparent overlay: an iframe swallows
 *   pointer events, so the mouse is read on the overlay and sent as a
 *   SIMULATED LIDAR finger (apps/server/spatial/lidarSim.ts), which the same
 *   spatial service the real lidar feeds turns into touches. The registration
 *   wizard therefore works by clicking and holding the dots it projects.
 */

type SimState = { available: boolean; reason?: string; running?: boolean; attached?: boolean; pointer?: { px: Px } | null }
type Overall = {
  live: boolean
  layout: Record<string, string>
  roomMap: Record<string, string>
  paths: Record<string, string>
  pages: string[]
  output?: { room: string | null; requiresArm: boolean; active: boolean }
  gate: { ok: boolean; reason?: string }
  devices: Record<string, { reachable: boolean; width?: number; height?: number }> | null
}
type Spatial = {
  touchEnabled?: boolean
  reason?: string
  lidar?: { baseline?: { state: string }; touches?: { id: number }[] }
  calibration?: { registration: { rmsTableMm: number } | null }
}
type Wizard = { on: boolean; phase: string; index: number; total: number; error: string | null; result: { rmsTableMm: number } | null }

const IDS = ['tv-1', 'tv-2', 'table'] as const
const j = async <T,>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T | null }> => {
  try {
    const r = await fetch(url, init)
    return { ok: r.ok, status: r.status, body: (await r.json().catch(() => null)) as T | null }
  } catch {
    return { ok: false, status: 0, body: null }
  }
}
const post = (url: string, body: unknown) => j<Record<string, unknown>>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/** An iframe at native size, scaled to its box. ResizeObserver, because the box follows the window. */
function Scaled({ w, h, src, title, children, frameRef }: { w: number; h: number; src: string | null; title: string; children?: React.ReactNode; frameRef?: (el: HTMLIFrameElement | null) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [k, setK] = useState(0.3)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => el.clientWidth > 0 && setK(el.clientWidth / w)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [w])
  return (
    <div ref={box} className="overall-frame" style={{ aspectRatio: `${w} / ${h}` }}>
      {src ? (
        <iframe ref={frameRef} key={src} src={src} title={title} tabIndex={-1} style={{ width: w, height: h, transform: `scale(${k})` }} />
      ) : (
        <div className="overall-off">off (black)</div>
      )}
      {children}
    </div>
  )
}

export function OverallPage() {
  const [o, setO] = useState<Overall | null>(null)
  const [layout, setLayout] = useState<Record<string, string> | null>(null)
  const [sim, setSim] = useState<SimState | null>(null)
  const [sp, setSp] = useState<Spatial | null>(null)
  const [wiz, setWiz] = useState<Wizard | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [cross, setCross] = useState<Px | null>(null)
  const [inst, setInst] = useState<{ instanceId: string; listeners: { speech: number; input: number }; table: boolean } | null>(null)
  const [seen, setSeen] = useState<Record<string, { id: string | null; origin: string | null }>>({})
  const [said, setSaid] = useState<{ text: string; delivered: boolean } | null>(null)
  const frames = useRef<Record<string, HTMLIFrameElement | null>>({})
  const overlay = useRef<HTMLDivElement>(null)
  const client = useRef(createPointerClient(async (b) => ({ ok: (await post('/api/spatial/sim/pointer', b)).ok })))

  const refresh = useCallback(async () => {
    const r = await j<Overall>('/api/overall')
    if (r.body) {
      setO(r.body)
      setLayout((l) => l ?? r.body!.layout)
    }
  }, [])

  // The sim lidar starts with the page and is kept alive by a heartbeat (the
  // server pauses it when the page goes quiet), so closing the tab can't leave
  // a lidar rotating forever.
  useEffect(() => {
    let alive = true
    void refresh()
    void post('/api/spatial/sim', { action: 'start' }).then((r) => alive && setSim(r.body as SimState))
    const beat = setInterval(() => void post('/api/spatial/sim', { action: 'heartbeat' }).then((r) => alive && r.body && setSim(r.body as SimState)), 8000)
    const poll = setInterval(async () => {
      const [a, s, w, pi] = await Promise.all([j<Overall>('/api/overall'), j<Spatial>('/api/spatial'), j<Wizard>('/api/spatial/registration/wizard'), j<NonNullable<typeof inst>>('/api/puppet/instance')])
      if (!alive) return
      if (pi.body) setInst(pi.body)
      // What each framed page stamped on itself (puppetInstance.ts). Same-origin
      // frames are readable; a frame that throws is on another origin: reported.
      const next: typeof seen = {}
      for (const [id, el] of Object.entries(frames.current)) {
        try {
          const root = el?.contentDocument?.documentElement
          next[id] = { id: root?.dataset.puppetInstance ?? null, origin: root?.dataset.puppetOrigin ?? null }
        } catch {
          next[id] = { id: null, origin: 'cross-origin' }
        }
      }
      setSeen(next)
      if (a.body) setO(a.body)
      if (s.body) setSp(s.body)
      if (w.body) setWiz(w.body)
    }, 1000)
    return () => {
      alive = false
      clearInterval(beat)
      clearInterval(poll)
    }
  }, [refresh])

  const chosen = layout ?? o?.layout ?? null
  const push = async (on: boolean, pages: Record<string, string> | null = chosen) => {
    setNote(null)
    const r = await post('/api/overall/live', { on, pages })
    if (!r.ok) setNote(((r.body as { error?: string } | null)?.error) ?? 'could not change the live switch')
    await refresh()
  }
  const choose = (id: string, page: string) => {
    const next = { ...(chosen ?? {}), [id]: page }
    setLayout(next)
    // Live follows the choice; emulated just changes the frame (no call at all).
    if (o?.live) void push(true, next)
  }

  const pointerPx = (e: React.PointerEvent) => overlay.current && clientToPx({ x: e.clientX, y: e.clientY }, overlay.current.getBoundingClientRect())
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || client.current.isDown()) return
    const px = pointerPx(e)
    if (!px) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    client.current.down(px)
    setCross(px)
  }
  const onMove = (e: React.PointerEvent) => {
    if (!client.current.isDown()) return
    const px = pointerPx(e)
    if (!px) return
    client.current.move(px)
    setCross(px)
  }
  const onUp = () => {
    client.current.up()
    setCross(null)
  }

  const register = async () => {
    setNote(null)
    client.current.up()
    // One click: make sure the sim is rotating, take the empty-table baseline
    // if there isn't one (the wizard needs it), then run the wizard. The owner
    // then clicks and holds the dots in the projector frame.
    const s = await post('/api/spatial/sim', { action: 'start' })
    setSim(s.body as SimState)
    if (!s.ok) return setNote(((s.body as SimState | null)?.reason) ?? 'the simulated lidar is not available')
    if (sp?.lidar?.baseline?.state !== 'ready') {
      setNote('learning the empty table (3 s): keep the mouse still…')
      const b = await post('/api/spatial/baseline', { ms: 3000 })
      if (!b.ok) return setNote(((b.body as { reason?: string } | null)?.reason) ?? 'could not take the baseline')
    }
    setNote(null)
    const r = await post('/api/spatial/registration/wizard', {})
    const w = r.body as unknown as Wizard | null
    if (w) setWiz(w)
    if (!r.ok) setNote(w?.error ?? 'the registration did not finish')
  }
  const resetSim = async () => {
    client.current.up()
    setCross(null)
    await post('/api/spatial/registration/wizard', {}).catch(() => undefined)
    await j('/api/spatial/registration/wizard', { method: 'DELETE' })
    const r = await post('/api/spatial/sim', { action: 'reset' })
    setSim(r.body as SimState)
    await post('/api/spatial/sim', { action: 'start' }).then((x) => setSim(x.body as SimState))
  }

  // The one-instance guard: TV 1 and the projector must both report the
  // server's instance, from this origin. Anything else is shouted, not hidden.
  const origin = typeof location === 'undefined' ? '' : location.origin
  const checked = ['tv-1', 'table'].filter((id) => chosen?.[id] === 'tv' || id === 'table' || chosen?.[id] === 'table')
  const stamps = checked.map((screen) => ({ screen, id: seen[screen]?.id ?? null, origin: seen[screen]?.origin ?? null }))
  const mismatch = inst ? stamps.filter((s) => s.id !== null && s.id !== inst.instanceId) : []
  const foreign = stamps.filter((s) => s.origin !== null && s.origin !== origin)
  const waiting = stamps.filter((s) => s.id === null && s.origin === null)
  const instanceBad = mismatch.length > 0 || foreign.length > 0
  const say = async () => {
    const text = `Overall view test line ${new Date().toLocaleTimeString()}`
    const r = await post('/api/puppet/input', { text, from: 'operator' })
    setSaid({ text, delivered: Boolean((r.body as { delivered?: boolean } | null)?.delivered) })
  }
  const tvLine = (() => {
    try {
      return frames.current['tv-1']?.contentDocument?.querySelector('.tv-bubble-on')?.textContent ?? null
    } catch {
      return null
    }
  })()
  const live = Boolean(o?.live)
  const registered = Boolean(sp?.calibration?.registration)
  const wizardOn = Boolean(wiz?.on)
  return (
    <main className="overall">
      <header className="overall-bar">
        <h1 className="liquid-heading">Overall view</h1>
        <div className="overall-switch" role="group" aria-label="render target">
          <span className={live ? '' : 'on'}>Emulated</span>
          <button className="liquid-button liquid-button--quiet" role="switch" aria-checked={live} onClick={() => void push(!live)} title={o?.gate.ok === false ? o.gate.reason : 'Push these three pages to the real displays'}>
            {live ? 'Live: on' : 'Live: off'}
          </button>
          <span className={live ? 'on' : ''}>Live</span>
        </div>
        <div className="overall-sim">
          <span className={`overall-chip ${sim?.available && sim.running ? 'ok' : 'bad'}`}>{sim?.available === false ? `sim lidar: ${sim.reason ?? 'unavailable'}` : sim?.running ? 'sim lidar: rotating' : 'sim lidar: off'}</span>
          <span className={`overall-chip ${sp?.touchEnabled ? 'ok' : 'warn'}`} title={sp?.reason}>{sp?.touchEnabled ? 'touch on' : 'touch off'}</span>
          <span className={`overall-chip ${registered ? 'ok' : 'warn'}`}>{registered ? 'registered' : 'not registered'}</span>
          <button className="liquid-button liquid-button--primary" disabled={!sim?.available || wizardOn} onClick={() => void register()}>
            {wizardOn ? `Hold the dot ${wiz?.index}/${wiz?.total}` : 'Register lidar (sim)'}
          </button>
          <span className={`overall-chip ${!inst ? 'warn' : instanceBad ? 'bad' : 'ok'}`} title="the one puppet master behind /tv, /table and this page">
            {!inst ? 'puppet master: unknown' : instanceBad ? 'PUPPET MASTER MISMATCH' : `puppet master ${inst.instanceId.slice(0, 8)}${waiting.length ? ' (frames loading)' : ' · same on TV 1 + projector'}`}
          </span>
          <button className="liquid-button liquid-button--quiet" onClick={() => void say()} title="Sends a typed line to the conversation home (/ must be open); it should appear in the TV 1 frame">
            Say a test line
          </button>
          <button className="liquid-button liquid-button--quiet" disabled={!sim?.available} onClick={() => void resetSim()}>
            Reset sim
          </button>
        </div>
      </header>
      {(note || o?.gate.ok === false || wiz?.error || wiz?.phase === 'done') && (
        <p className="overall-note" role="status">
          {note ?? (wiz?.phase === 'done' ? `Registered: held-out error ${wiz.result?.rmsTableMm.toFixed(1)} mm. Touch is on: click the projector.` : wiz?.error) ?? (live ? null : `Live is unavailable: ${o?.gate.reason}`)}
        </p>
      )}
      {instanceBad && (
        <p className="overall-note bad" role="alert">
          Different puppet master or origin! {mismatch.map((m) => `${SCREEN[m.screen]!.label} reports ${String(m.id).slice(0, 8)}`).join('; ')}
          {foreign.map((f) => `; ${SCREEN[f.screen]!.label} is served from ${f.origin}, not ${origin}`).join('')}. Server instance: {inst?.instanceId.slice(0, 8)}.
        </p>
      )}
      {said && (
        <p className="overall-note" role="status">
          Sent “{said.text}”. {said.delivered ? (tvLine ? `TV 1 now says: “${tvLine}”` : 'Delivered to the conversation home; waiting for its answer on TV 1…') : 'Nothing is listening: open / (the conversation home) in a tab, then try again.'}
        </p>
      )}
      {live && o?.output?.requiresArm && !o.output.active && <p className="overall-note warn">Live is on, but room output is disarmed: nothing reaches the displays until it is armed in Setup.</p>}
      <div className="overall-grid">
        {IDS.map((id) => {
          const sc = SCREEN[id]!
          const page = chosen?.[id] ?? 'off'
          const path = o ? pathFor(page, o.paths) : null
          const dev = o?.devices?.[id]
          const room = o?.roomMap[id]
          return (
            <section key={id} className={`overall-screen overall-${id}`} aria-label={sc.label}>
              <div className="overall-cap">
                <b>{sc.label}</b>
                <select value={page} onChange={(e) => choose(id, e.target.value)} aria-label={`${sc.label} page`}>
                  {(o?.pages ?? [page]).map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <span className={`overall-chip ${live ? (dev?.reachable ? 'ok' : 'bad') : ''}`}>{live ? (dev ? (dev.reachable ? `live · ${dev.width}×${dev.height}` : 'live · unreachable') : 'live · no status') : 'emulated'}</span>
                {room && room !== page && <span className="overall-chip" title="what the room is pointed at right now">room map: {room}</span>}
              </div>
              <Scaled w={sc.w} h={sc.h} src={path} title={`${sc.label} screen`} frameRef={(el) => void (frames.current[id] = el)}>
                {id === 'table' && (
                  <div ref={overlay} className="overall-touch" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} role="application" aria-label="projector touch surface: click, hold or drag">
                    {cross && <i className="overall-cross" style={{ left: `${(cross.x / PROJECTOR.w) * 100}%`, top: `${(cross.y / PROJECTOR.h) * 100}%` }} />}
                  </div>
                )}
              </Scaled>
            </section>
          )
        })}
      </div>
    </main>
  )
}
