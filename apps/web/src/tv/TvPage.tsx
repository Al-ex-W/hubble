import { useEffect, useMemo, useState } from 'react'
import { Orb } from '../hubble/orb/Orb.tsx'
import { createSyntheticVoiceTap } from '../hubble/orb/preview.ts'
import { usePuppetInstance } from '../puppetInstance.ts'
import './tv.css'

/** How long a finished line stays on the TV before the bubble fades. */
export const BUBBLE_HOLD_MS = 6000

/**
 * What a TV shows: the Hubble orb and a talk bubble with the line being said.
 * MINIMAL first cut (7 Oct, rig window): whole line at once, no word timing
 * and no voice level yet (the orb uses the synthetic tap while a line shows).
 *
 * Why EventSource and nothing else: the TV is a passive kiosk page that makes
 * no request of its own; the browser's EventSource reconnects forever by
 * itself when venue Wi-Fi drops, and we never render an error state.
 * `?screen=2` mirrors the layout so two TVs side by side face each other.
 */
export function TvPage({ screen = new URLSearchParams(location.search).get('screen') }: { screen?: string | null }) {
  const [line, setLine] = useState<{ id: string; text: string } | null>(null)
  usePuppetInstance()
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
  return <main className={`tv-page${screen === '2' ? ' tv-mirror' : ''}`}>
    <div className="tv-orb"><Orb state={line ? 'speaking' : 'idle'} tap={tap} /></div>
    <div className={`tv-bubble${line ? ' tv-bubble-on' : ''}`} aria-live="polite">{line?.text}</div>
  </main>
}
