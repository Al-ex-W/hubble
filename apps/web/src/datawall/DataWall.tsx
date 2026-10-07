import { useEffect, useMemo, useRef, useState } from 'react'
import { Orb } from '../hubble/orb/Orb.tsx'
import { createSyntheticVoiceTap } from '../hubble/orb/preview.ts'
import { BUBBLE_HOLD_MS } from '../tv/TvPage.tsx'
import { startWall, type NumKey } from './wall.ts'
import './datawall.css'

/**
 * TV 2's page (/datawall): see wall.ts for why. React only lays out the
 * skeleton, once; wall.ts fills it from the live streams without re-rendering.
 * No input and no click to start: a kiosk TV can't be clicked.
 */
const NUMS: { key: NumKey; label: string }[] = [
  { key: 'tps', label: 'tokens / s' },
  { key: 'answers', label: 'answers rendered' },
  { key: 'pps', label: 'lidar points / s' },
  { key: 'fps', label: 'camera fps' },
  { key: 'rms', label: 'calibration rms px' },
  { key: 'keys', label: 'keys tracked' },
  { key: 'uptime', label: 'uptime' },
  { key: 'window', label: 'hardware window' },
]

/** The orb and the line Hubble is saying: the same speech channel as /tv (TvPage.tsx). */
function HubbleVoice() {
  const [line, setLine] = useState<{ id: string; text: string } | null>(null)
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    let hide: ReturnType<typeof setTimeout> | undefined
    const source = new EventSource('/api/puppet/speech/events')
    source.onmessage = (message: MessageEvent) => {
      let data: { type?: string; id?: unknown; text?: unknown }
      try { data = JSON.parse(String(message.data)) } catch { return }
      if (data.type !== 'speech' || typeof data.id !== 'string' || typeof data.text !== 'string') return
      setLine({ id: data.id, text: data.text })
      clearTimeout(hide)
      hide = setTimeout(() => setLine(null), BUBBLE_HOLD_MS)
    }
    return () => { clearTimeout(hide); source.close() }
  }, [])
  const tap = useMemo(() => createSyntheticVoiceTap(), [])
  return (
    <div className="dw-voice">
      <div className="dw-orb"><Orb state={line ? 'speaking' : 'idle'} tap={tap} /></div>
      <div className={`dw-bubble${line ? ' dw-bubble-on' : ''}`} aria-live="polite">{line?.text ?? 'ask me anything'}</div>
    </div>
  )
}

export function DataWall() {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const r = root.current
    if (!r) return
    const q = <T extends Element>(s: string) => r.querySelector(s) as T
    const nums = Object.fromEntries(NUMS.map((n) => [n.key, q<HTMLElement>(`[data-num="${n.key}"]`)])) as Record<NumKey, HTMLElement>
    return startWall({
      radar: q('.dw-radar canvas'),
      radarStats: q('.dw-radar .dw-sub'),
      table: q('.dw-cal canvas'),
      matrix: q('.dw-matrix'),
      calStats: q('.dw-cal .dw-sub'),
      model: q('.dw-code'),
      pipeline: q('.dw-pipeline'),
      modelStats: q('.dw-model .dw-sub'),
      feed: q('.dw-feed'),
      nums,
    })
  }, [])
  return (
    <div className="dw" ref={root}>
      <header className="dw-head">
        <b>HUBBLE</b> <span>// live systems</span>
        <i className="dw-pulse" />
      </header>
      <section className="dw-panel dw-radar">
        {/* Hubble's voice in the radar's place (owner, 7 Oct 14:40: "go with
            the data and then have the hubble bubble somewhere on that
            screen"). The lidar is unconnected for the demo, so its radar
            would only ever say "waiting"; the canvas stays in the DOM, hidden,
            because wall.ts paints it and a missing element would throw. */}
        <h3>hubble</h3>
        <HubbleVoice />
        <canvas width={460} height={460} hidden />
        <div className="dw-sub" hidden />
      </section>
      <section className="dw-panel dw-model">
        <h3>model stream · restricted jsx</h3>
        <div className="dw-pipeline" />
        <pre className="dw-code" />
        <div className="dw-sub" />
      </section>
      <section className="dw-panel dw-firehose">
        <h3>event firehose</h3>
        <div className="dw-feed" />
      </section>
      <section className="dw-panel dw-nums">
        {NUMS.map((n) => (
          <div key={n.key} className="dw-num">
            <span data-num={n.key}>—</span>
            <small>{n.label}</small>
          </div>
        ))}
      </section>
      <section className="dw-panel dw-cal">
        <h3>camera → table homography</h3>
        <pre className="dw-matrix" />
        <canvas width={420} height={240} />
        <div className="dw-sub" />
      </section>
    </div>
  )
}
