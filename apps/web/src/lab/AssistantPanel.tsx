import { useEffect, useRef, useState } from 'react'
import type { LabEvent } from '../../../server/puppetLab.ts'
import { VoiceSelect } from '../hubble/assistant/VoiceSelect.tsx'
import { readNdjson } from './ndjson.ts'

interface Voice { id: string; label: string }
type Timing = Extract<LabEvent, { type: 'timing' }>
const PATH_LABEL = {
  forced: 'forced (provider honoured toolChoice)',
  'auto-instructed': 'instructed (toolChoice auto; the model obeyed the say-only instruction)',
  fallback: 'fallback (model answered in text; the server wrapped it in say)',
} as const

/**
 * Panel 2: one model call that is made to speak through the `say` tool, with the
 * model's reasoning, the tool call and the audio shown as they happen. The page
 * only renders what the server streamed: no reasoning is ever invented here.
 */
export function AssistantPanel() {
  const [text, setText] = useState('Say hello and tell me what 17 times 23 is.')
  const [thinking, setThinking] = useState(true)
  const [voices, setVoices] = useState<Voice[]>([])
  const [voice, setVoice] = useState('')
  const [running, setRunning] = useState(false)
  const [reasoning, setReasoning] = useState('')
  const [plain, setPlain] = useState('')
  const [call, setCall] = useState<Extract<LabEvent, { type: 'tool-call' }> | null>(null)
  const [timing, setTiming] = useState<Timing | null>(null)
  const [audioMs, setAudioMs] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [finished, setFinished] = useState(false)
  const audio = useRef<HTMLAudioElement>(null)
  const abort = useRef<AbortController | null>(null)
  const t0 = useRef(0)

  useEffect(() => {
    void fetch('/api/puppet/voices').then(r => r.json()).then(d => { setVoices(d.voices); setVoice(d.default) }).catch(() => setError('Could not load voices.'))
    return () => abort.current?.abort()
  }, [])

  async function run() {
    abort.current?.abort()
    const controller = new AbortController(); abort.current = controller
    setRunning(true); setError(''); setReasoning(''); setPlain(''); setCall(null); setTiming(null); setAudioMs(null); setFinished(false)
    audio.current?.pause()
    // Click is the user gesture that lets the audio element autoplay later,
    // after the model and TTS round trips. Priming it here keeps Safari/Chrome happy.
    void audio.current?.play().catch(() => {})
    t0.current = performance.now()
    try {
      const response = await fetch('/api/puppet/lab/run', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ text, thinking, voice: voice || undefined }),
      })
      if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({}))).error ?? `Run failed (HTTP ${response.status}).`)
      for await (const event of readNdjson<LabEvent>(response.body, e => e.type === 'done' || e.type === 'error')) {
        if (event.type === 'reasoning') setReasoning(r => r + event.delta)
        else if (event.type === 'text') setPlain(p => p + event.delta)
        else if (event.type === 'tool-call') setCall(event)
        else if (event.type === 'timing') setTiming(event)
        else if (event.type === 'error') setError(event.message)
        else if (event.type === 'done') setFinished(true)
        else if (event.type === 'speech' && event.audio && audio.current) {
          audio.current.src = `/api/puppet/lab/speech/${event.id}`
          void audio.current.play().catch(() => setError('The browser blocked autoplay. Press play on the player.'))
        }
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Run failed.')
    } finally { setRunning(false) }
  }

  const ms = (v?: number) => v === undefined ? '–' : `${v} ms`
  return <section className="liquid-card lab-panel" aria-labelledby="lab-a-title">
    <span className="liquid-badge">DEMO 2</span>
    <h2 id="lab-a-title" className="liquid-heading">Forced speech with visible reasoning</h2>
    <p className="liquid-text liquid-muted">The assistant must answer by calling its say tool. Watch it think, call the tool, then speak.</p>
    <div className="liquid-field"><label htmlFor="lab-text">what the person says</label>
      <textarea id="lab-text" className="lab-textarea" rows={3} value={text} onChange={e => setText(e.target.value)} /></div>
    <div className="liquid-row">
      <label className="lab-check"><input type="checkbox" checked={thinking} onChange={e => setThinking(e.target.checked)} /> thinking</label>
      <VoiceSelect className="lab-voice" assistant={{ voices, voice, setVoice }} />
      <button className="liquid-button liquid-button--primary" disabled={running || !text.trim()} onClick={() => void run()}>{running ? 'Running…' : 'Run'}</button>
    </div>
    {error && <p className="lab-error" role="alert">{error}</p>}

    <h3 className="lab-h3">Reasoning</h3>
    <pre className="lab-pre" aria-live="polite">{reasoning || (finished || timing ? 'The model returned no reasoning.' : running ? '…' : '')}</pre>

    <h3 className="lab-h3">Tool call</h3>
    {call ? <pre className="lab-pre">{call.name}({JSON.stringify(call.input, null, 2)}){call.synthesized ? '\n(synthesized by the server from plain text)' : ''}</pre> : <p className="liquid-text liquid-muted">{running ? '…' : 'none yet'}</p>}
    {plain.trim() && <><h3 className="lab-h3">Plain text from the model</h3><pre className="lab-pre">{plain}</pre></>}

    <h3 className="lab-h3">Spoken</h3>
    <p className="lab-live">{call?.input.text ?? <span className="liquid-muted">…</span>}</p>
    <audio ref={audio} controls className="lab-audio" onPlaying={() => setAudioMs(v => v ?? Math.round(performance.now() - t0.current))} />

    <h3 className="lab-h3">Timings</h3>
    <dl className="lab-timings">
      <dt>path</dt><dd>{timing ? PATH_LABEL[timing.path] : '–'}</dd>
      <dt>first reasoning token</dt><dd>{ms(timing?.firstReasoningMs)}</dd>
      <dt>tool call</dt><dd>{ms(timing?.toolCallMs)}</dd>
      <dt>audio playing (browser)</dt><dd>{audioMs === null ? '–' : `${audioMs} ms`}</dd>
      <dt>model total</dt><dd>{ms(timing?.totalMs)}</dd>
      <dt>reasoning size</dt><dd>{timing ? `${timing.reasoningChars} chars` : '–'}</dd>
    </dl>
  </section>
}
