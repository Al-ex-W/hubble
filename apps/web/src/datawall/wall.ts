import { windowAt } from '../../../../packages/room/src/window.ts'

/**
 * The data wall on TV 2 (/datawall). Scope correction (owner, via H46, 7 Oct):
 * "a very stylized data dump of all the code stuff on the 2nd tv, so just data
 * that we have to impress people in a cool way".
 *
 * Why plain DOM and one canvas, not React state: the spatial stream alone
 * sends a frame per lidar rotation (~10 Hz) and the firehose takes every line
 * from five channels; re-rendering React for each would cost a Pi kiosk its
 * frame rate. So React mounts the skeleton once (DataWall.tsx) and this
 * controller writes text nodes, and the radar repaints on requestAnimationFrame
 * from whatever frame arrived last. Everything here only READS our own
 * server's streams: no device is touched, so it is fine outside the hardware
 * window, and an idle stream leaves the last values with a "waiting" label,
 * never a blank panel.
 *
 * One EventSource per stream, opened here only. NOT /api/puppet/input/events:
 * that channel hands the conversation to the newest subscriber (puppetInput.ts,
 * "one page only"), so listening there would steal it from the operator.
 *
 * The window's numbers come straight from packages/room/src/window.ts (its one
 * owner, AGENTS.md); imported by path because the web app has no
 * @hubble/room dependency and the module is pure.
 */

export interface WallEls {
  radar: HTMLCanvasElement
  radarStats: HTMLElement
  table: HTMLCanvasElement
  matrix: HTMLElement
  calStats: HTMLElement
  model: HTMLElement
  pipeline: HTMLElement
  modelStats: HTMLElement
  feed: HTMLElement
  nums: Record<NumKey, HTMLElement>
}

export type NumKey = 'tps' | 'answers' | 'pps' | 'fps' | 'rms' | 'keys' | 'uptime' | 'window'

type Point = { angle: number; distance: number; quality: number }
type Touch = { id: number; phase: string; table: { x: number; y: number } }

const FEED_MAX = 60
const CHANNEL_COLOR: Record<string, string> = {
  stage: '#becaff',
  spatial: '#98d2b7',
  input: '#d4a16b',
  puppet: '#e3a8ff',
  operator: '#ffb9b6',
}

const ms = (t: number) => {
  const d = new Date(t)
  return `${d.toLocaleTimeString('sv-SE', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
}
const short = (v: unknown, n = 120) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > n ? `${s.slice(0, n)}…` : s
}

export function startWall(el: WallEls): () => void {
  const opened = Date.now()
  const sources: EventSource[] = []
  const timers: ReturnType<typeof setInterval>[] = []
  let raf = 0

  // ---- firehose: a fixed pool of rows, newest on top, no layout growth ----
  const rows: HTMLDivElement[] = []
  for (let i = 0; i < FEED_MAX; i++) {
    const r = document.createElement('div')
    r.className = 'dw-row'
    el.feed.appendChild(r)
    rows.push(r)
  }
  const feedBuf: { t: number; ch: string; text: string }[] = []
  let feedDirty = false
  const feed = (ch: string, text: string) => {
    feedBuf.unshift({ t: Date.now(), ch, text })
    if (feedBuf.length > FEED_MAX) feedBuf.length = FEED_MAX
    feedDirty = true
  }
  const paintFeed = () => {
    if (!feedDirty) return
    feedDirty = false
    rows.forEach((r, i) => {
      const e = feedBuf[i]
      if (!e) return
      r.textContent = `${ms(e.t)}  ${e.ch.padEnd(8)} ${e.text}`
      r.style.color = CHANNEL_COLOR[e.ch] ?? '#edf0ff'
    })
  }

  // ---- lidar ----
  let points: Point[] = []
  let touches: Touch[] = []
  let lastSeq = -1
  let lidarFrames = 0
  let lidarPoints = 0
  let lidarHz = 0
  let lidarPps = 0
  let lidarAt = 0
  let cameraFps: number | null = null
  let surface: { widthPx: number; heightPx: number; mmPerPx: number } | null = null
  let matrix: number[] | null = null
  // Two different errors, kept apart (owner, 7 Oct: the tile read "not
  // registered" while the camera calibration existed at 4.6 px): the
  // camera → projector fit (GET /api/calibration, the runtime's) and the
  // lidar registration (on the spatial frame), which may not exist yet.
  let rms: number | null = null
  let cameraRms: number | null = null
  let spatialAt = 0
  let lastSpatialFeed = 0

  const onSpatial = (m: MessageEvent) => {
    let f: any
    try {
      f = JSON.parse(String(m.data))
    } catch {
      return
    }
    spatialAt = Date.now()
    const lf = f?.lidar?.frame
    if (lf && lf.seq !== lastSeq) {
      lastSeq = lf.seq
      points = Array.isArray(lf.points) ? lf.points : []
      lidarFrames++
      lidarPoints += points.length
      lidarAt = Date.now()
    }
    touches = Array.isArray(f?.lidar?.touches) ? f.lidar.touches : []
    const fps = (f?.camera?.sources ?? []).map((s: { fps: number | null }) => s.fps ?? 0)
    cameraFps = fps.length ? Math.max(...fps) : cameraFps
    if (f?.surface) surface = f.surface
    const h = f?.calibration?.camera?.h
    if (Array.isArray(h) && h.length === 9) matrix = h
    const r = f?.calibration?.registration?.rmsProjectorPx
    if (typeof r === 'number') rms = r
    // The spatial stream is ~10 Hz; one firehose line a second is readable.
    if (Date.now() - lastSpatialFeed > 1000) {
      lastSpatialFeed = Date.now()
      feed('spatial', `seq ${f?.seq} lidar ${f?.lidar?.health?.state ?? '—'} pts ${points.length} touches ${touches.length} cam ${f?.camera?.state ?? '—'}`)
    }
  }

  // ---- model stream ----
  let draft = ''
  let shown = 0
  let tps: number | null = null
  let answers = 0
  let renderAt = 0
  const steps: string[] = []
  const paintPipeline = () => {
    el.pipeline.textContent = steps.length ? steps.join('  →  ') : 'waiting for a question…'
  }
  const onStage = (m: MessageEvent) => {
    let l: any
    try {
      l = JSON.parse(String(m.data))
    } catch {
      return
    }
    renderAt = Date.now()
    if (l.kind === 'start') {
      draft = ''
      shown = 0
      el.model.textContent = ''
      steps.length = 0
      steps.push(`start · ${l.model ?? 'model'}`)
      paintPipeline()
      feed('stage', `start ${l.renderId} "${short(l.intent, 60)}"`)
    } else if (l.kind === 'raw') {
      // The draft arrives whole (~1 s per answer at ~350 tok/s); the wall types
      // it out itself, the way the director paces pieces on the table.
      draft = String(l.text ?? '')
      shown = 0
    } else if (l.kind === 'trace') {
      const d = l.data ?? {}
      if (l.step === 'draft') {
        steps.push('draft')
        if (typeof d.ms === 'number' && d.ms > 0 && typeof d.text === 'string') tps = d.text.length / 4 / (d.ms / 1000)
      } else if (l.step === 'verify') steps.push(d.ok ? 'verified' : `verify → ${String(l.detail).replace(' found', '')}`)
      else steps.push(`edit_answer${typeof l.detail === 'string' ? ` (${l.detail})` : ''}`)
      paintPipeline()
      feed('stage', `trace ${l.step}: ${short(l.detail)}`)
    } else if (l.kind === 'event') {
      const e = l.event ?? {}
      feed('stage', `event ${e.type}${e.tag ? ` <${e.tag}>` : ''}${e.reason ? ` ${e.reason}` : ''}`)
    } else if (l.kind === 'done') {
      answers++
      steps.push(`done · ${l.t} ms`)
      paintPipeline()
      feed('stage', `done ${l.renderId} in ${l.t} ms`)
    } else if (l.kind === 'error') {
      steps.push('error')
      paintPipeline()
      feed('stage', `error ${short(l.message)}`)
    } else if (l.kind === 'touch') {
      feed('input', `touch ${short(l, 90)}`)
    } else if (l.kind === 'overlay') {
      feed('stage', `overlay ${l.layer} · ${l.shapes?.length ?? 0} shapes`)
    } else if (l.kind === 'surfaces') {
      feed('stage', `surfaces rev ${l.revision ?? '—'} · ${l.surfaces?.length ?? l.set?.surfaces?.length ?? '?'}`)
    }
  }

  const open = (url: string, on: (m: MessageEvent) => void, event?: string) => {
    if (typeof EventSource === 'undefined') return
    const s = new EventSource(url)
    if (event) s.addEventListener(event, on as EventListener)
    else s.onmessage = on
    sources.push(s)
  }
  open('/api/spatial/events', onSpatial, 'spatial')
  open('/api/stage/events', onStage)
  open('/api/input/events', (m) => feed('input', short(String(m.data))))
  let lastLevel = 0
  open('/api/puppet/speech/events', (m) => {
    let l: any
    try {
      l = JSON.parse(String(m.data))
    } catch {
      return
    }
    // Voice levels come at audio rate; one line a second keeps the column readable.
    if (l.type === 'level') {
      if (Date.now() - lastLevel < 1000) return
      lastLevel = Date.now()
    }
    if (l.type === 'words') return
    feed('puppet', `${l.type}${l.text ? ` "${short(l.text, 90)}"` : l.phase ? ` ${l.phase}` : l.level !== undefined ? ` ${Number(l.level).toFixed(2)}` : ''}`)
  })
  open('/api/operator/ui/events', (m) => {
    try {
      const u = JSON.parse(String(m.data))
      feed('operator', `ui mode=${u.mode} step=${u.step ?? '—'} ${u.stepPhase ?? ''} more=${u.more}`)
    } catch {
      // ignore
    }
  })

  // ---- the slow numbers: the operator status poll (keys, camera) ----
  let keys: number | null = null
  const poll = () =>
    void fetch('/api/operator/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (s && typeof s.keys === 'number') keys = s.keys
      })
      .catch(() => undefined)
  const pollCalibration = () =>
    void fetch('/api/calibration')
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (c && typeof c.rms === 'number' && Number.isFinite(c.rms)) cameraRms = c.rms
      })
      .catch(() => undefined)
  poll()
  pollCalibration()
  timers.push(setInterval(poll, 3000))
  timers.push(setInterval(pollCalibration, 10_000))

  // Rates over the last second.
  timers.push(
    setInterval(() => {
      lidarHz = lidarFrames
      lidarPps = lidarPoints
      lidarFrames = 0
      lidarPoints = 0
    }, 1000),
  )

  // ---- numbers + text panels at 4 Hz ----
  const set = (k: NumKey, v: string, live: boolean) => {
    const n = el.nums[k]
    if (n.textContent !== v) n.textContent = v
    n.parentElement?.classList.toggle('dw-idle', !live)
  }
  const tick = () => {
    const now = Date.now()
    const lidarLive = now - lidarAt < 2000
    set('tps', tps === null ? 'waiting…' : tps.toFixed(0), now - renderAt < 30_000)
    set('answers', String(answers), answers > 0)
    set('pps', lidarLive ? String(lidarPps) : lidarPps ? `${lidarPps} (last)` : 'waiting…', lidarLive)
    set('fps', cameraFps === null ? 'waiting…' : cameraFps.toFixed(1), now - spatialAt < 2000 && (cameraFps ?? 0) > 0)
    const rmsParts = [cameraRms !== null ? `camera ${cameraRms.toFixed(1)}` : null, rms !== null ? `lidar ${rms.toFixed(1)}` : null].filter(Boolean)
    set('rms', rmsParts.length ? rmsParts.join(' · ') : 'not calibrated', rmsParts.length > 0)
    set('keys', keys === null ? 'waiting…' : `${keys}/25`, keys === 25)
    const up = Math.floor((now - opened) / 1000)
    set('uptime', `${String(Math.floor(up / 3600)).padStart(2, '0')}:${String(Math.floor(up / 60) % 60).padStart(2, '0')}:${String(up % 60).padStart(2, '0')}`, true)
    const w = windowAt(now)
    const left = Math.max(0, Math.round(((w.open ? w.closesAt : w.opensAt) - now) / 1000))
    set('window', `${w.open ? 'OPEN' : 'opens in'} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}${w.open ? ' left' : ''}`, w.open)
    el.radarStats.textContent = lidarLive ? `${points.length} pts · ${lidarHz} Hz · ${touches.length} touch` : `waiting for the lidar… (last: ${points.length} pts)`
    el.modelStats.textContent = draft ? `${draft.length} chars · ${(draft.length / 4).toFixed(0)} tok` : 'waiting for the model…'
    if (matrix) {
      const txt = [0, 1, 2].map((r) => matrix!.slice(r * 3, r * 3 + 3).map((v) => v.toExponential(3).padStart(11)).join(' ')).join('\n')
      if (el.matrix.textContent !== txt) el.matrix.textContent = txt
    } else el.matrix.textContent = '  waiting for a camera\n  calibration…\n'
    el.calStats.textContent = surface ? `table ${Math.round(surface.widthPx * surface.mmPerPx)} × ${Math.round(surface.heightPx * surface.mmPerPx)} mm · ${touches.length} touches` : 'waiting for the table surface…'
  }
  tick()
  timers.push(setInterval(tick, 250))

  // ---- canvases, every animation frame ----
  const rctx = el.radar.getContext('2d')
  const tctx = el.table.getContext('2d')
  const R_MAX = 1500 // mm: the RPLIDAR C1 over a table is well inside this; farther returns pin to the rim
  const draw = (t: number) => {
    raf = requestAnimationFrame(draw)
    // Typewriter: ~1500 chars/s, so a typical answer types out in a second or two.
    if (shown < draft.length) {
      shown = Math.min(draft.length, shown + 25)
      el.model.textContent = draft.slice(Math.max(0, shown - 2400), shown)
      el.model.scrollTop = el.model.scrollHeight
    }
    paintFeed()
    if (rctx) {
      const { width: W, height: H } = el.radar
      const cx = W / 2
      const cy = H / 2
      const rad = Math.min(W, H) / 2 - 12
      rctx.fillStyle = 'rgba(8,13,34,0.35)' // fade, so old points trail like phosphor
      rctx.fillRect(0, 0, W, H)
      rctx.strokeStyle = 'rgba(190,202,255,0.18)'
      rctx.lineWidth = 1
      for (let i = 1; i <= 4; i++) {
        rctx.beginPath()
        rctx.arc(cx, cy, (rad * i) / 4, 0, Math.PI * 2)
        rctx.stroke()
      }
      // Sweep: one turn a second when live; a slow breath when idle.
      const live = Date.now() - lidarAt < 2000
      const a = ((t / (live ? 1000 : 6000)) % 1) * Math.PI * 2
      const g = rctx.createLinearGradient(cx, cy, cx + Math.cos(a) * rad, cy + Math.sin(a) * rad)
      g.addColorStop(0, 'rgba(152,210,183,0)')
      g.addColorStop(1, live ? 'rgba(152,210,183,0.9)' : 'rgba(152,210,183,0.3)')
      rctx.strokeStyle = g
      rctx.lineWidth = 2
      rctx.beginPath()
      rctx.moveTo(cx, cy)
      rctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad)
      rctx.stroke()
      rctx.fillStyle = live ? '#98d2b7' : 'rgba(152,210,183,0.35)'
      for (const p of points) {
        if (!(p.distance > 0)) continue
        const rr = (Math.min(p.distance, R_MAX) / R_MAX) * rad
        const th = ((p.angle - 90) * Math.PI) / 180
        rctx.fillRect(cx + Math.cos(th) * rr - 1.5, cy + Math.sin(th) * rr - 1.5, 3, 3)
      }
    }
    if (tctx) {
      const { width: W, height: H } = el.table
      tctx.clearRect(0, 0, W, H)
      if (surface) {
        const sw = surface.widthPx * surface.mmPerPx
        const sh = surface.heightPx * surface.mmPerPx
        const k = Math.min((W - 20) / sw, (H - 20) / sh)
        const ox = (W - sw * k) / 2
        const oy = (H - sh * k) / 2
        tctx.strokeStyle = 'rgba(190,202,255,0.6)'
        tctx.setLineDash([6, 4])
        tctx.strokeRect(ox, oy, sw * k, sh * k)
        tctx.setLineDash([])
        // Touches in table mm, glowing.
        for (const tc of touches) {
          const x = ox + tc.table.x * k
          const y = oy + tc.table.y * k
          const glow = tctx.createRadialGradient(x, y, 0, x, y, 22)
          glow.addColorStop(0, tc.phase === 'down' ? 'rgba(255,185,182,1)' : 'rgba(212,161,107,0.9)')
          glow.addColorStop(1, 'rgba(255,185,182,0)')
          tctx.fillStyle = glow
          tctx.beginPath()
          tctx.arc(x, y, 22, 0, Math.PI * 2)
          tctx.fill()
        }
      }
    }
  }
  raf = requestAnimationFrame(draw)
  feed('operator', 'data wall online')

  return () => {
    cancelAnimationFrame(raf)
    timers.forEach(clearInterval)
    sources.forEach((s) => s.close())
  }
}
