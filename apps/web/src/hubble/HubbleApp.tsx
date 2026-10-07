import { useEffect, useRef, useState } from 'react'
import { Orb } from './orb/Orb.tsx'
import { usePuppetAssistant } from './assistant/usePuppetAssistant.ts'
import { VoiceSelect } from './assistant/VoiceSelect.tsx'
import type { OrbState } from './orb/dynamics.ts'
import { createSyntheticVoiceTap, PREVIEW_CYCLE, readPreview } from './orb/preview.ts'
import './hubble.css'

// `import.meta.env.DEV` is false in production builds, so the preview is
// unreachable (and tree-shaken) outside `npm run dev`.
const PREVIEW = import.meta.env.DEV ? readPreview(window.location.search) : null

/**
 * App shell: the orb, a one-line status, the running transcript and a text box. The person
 * TYPES (there is no speech input, owner 7 Oct 2026); Hubble answers aloud, and the orb reacts
 * to it. Everything conversational lives in usePuppetAssistant.
 */
export function HubbleApp() {
  const assistant = usePuppetAssistant()
  const [health, setHealth] = useState<{ elevenlabs: boolean; llm: boolean } | null>(null)
  const transcriptEnd = useRef<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState('')

  // Surface missing server config before the user tries to talk to a broken setup.
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setHealth(d.config))
      .catch(() => setHealth(null))
  }, [])

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [assistant.turns])

  const preview = usePreviewState()
  const orbState = preview?.state ?? assistant.state
  const orbTap = preview?.tap ?? assistant.tap

  // send() resolves false when ignored (a turn is running): keep the text then, so nothing
  // the person wrote is lost. It rejects on failure; the hook has already shown the error.
  const submit = () => {
    const text = draft.trim()
    if (!text || assistant.busy) return
    void assistant.send(text).then(ran => { if (ran) setDraft('') }).catch(() => {})
  }

  return (
    <div className="hubble-root">
      <div className="app">
        <header className="header">
          <h1>hubble</h1>
        </header>

        <main className="stage">
          <Orb state={orbState} tap={orbTap} />
          <div className={`status ${orbState}`} aria-live="polite">
            {STATUS[orbState]}
          </div>

          {health && (!health.elevenlabs || !health.llm) && (
            <div className="warning">
              {!health.elevenlabs
                ? 'ELEVENLABS_API_KEY is missing from .env.'
                : 'HUBBLE_LLM_API_KEY is missing from .env.'}
            </div>
          )}
          {assistant.error && <div className="warning">{assistant.error}</div>}
        </main>

        <section className="transcript">
          {assistant.turns.length === 0 ? (
            <p className="hint">Type something to Hubble. It answers out loud.</p>
          ) : (
            assistant.turns.map((turn) => (
              <p key={`${turn.role}-${turn.id}`} className={`turn ${turn.role}`}>
                <span className="who">{turn.role === 'user' ? 'you' : 'hubble'}</span>
                {turn.content}
              </p>
            ))
          )}
          <div ref={transcriptEnd} />
        </section>

        <footer className="controls">
          <VoiceSelect assistant={assistant} className="voice-select" />
          <form className="composer" onSubmit={event => { event.preventDefault(); submit() }}>
            <input value={draft} maxLength={2000} aria-label="Message to Hubble" placeholder="Ask Hubble…" onChange={event => setDraft(event.target.value)} />
            {assistant.busy
              ? <button type="button" className="stop" onClick={() => assistant.stopTurn()}>stop</button>
              : <button type="submit" disabled={!draft.trim()}>send</button>}
          </form>
        </footer>
      </div>
    </div>
  )
}

function usePreviewState() {
  const [tap] = useState(createSyntheticVoiceTap)
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (PREVIEW !== 'cycle') return
    const timer = setInterval(() => setStep((s) => (s + 1) % PREVIEW_CYCLE.length), 4000)
    return () => clearInterval(timer)
  }, [])
  if (!PREVIEW) return null
  return { state: PREVIEW === 'cycle' ? PREVIEW_CYCLE[step] : PREVIEW, tap }
}

// OrbState, not AssistantState: the dev preview (?preview=cycle) still shows every orb face.
const STATUS: Record<OrbState, string> = {
  idle: 'ready',
  connecting: 'waking',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
}
