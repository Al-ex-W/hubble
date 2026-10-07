import { useCallback, useEffect, useRef, useState } from 'react'
import { usePuppetAssistant } from '../hubble/assistant/usePuppetAssistant.ts'
import { VoiceSelect } from '../hubble/assistant/VoiceSelect.tsx'
import type { ComponentDocument, StudioSnapshot } from './contract.ts'
import { EXAMPLES } from './examples.ts'
import * as UI from './kit.tsx'
import { CalibrationPattern } from './CalibrationPattern.tsx'
import { ProjectorModeSwitch } from './ProjectorModeSwitch.tsx'
import { useProjectorMode } from './projectorMode.ts'
import './liquid.css'
import './studio.css'

function useStudio() {
  const [documents, setDocuments] = useState<ComponentDocument[]>([])
  const [connected, setConnected] = useState(false)
  const [model, setModel] = useState('aixia-labs')
  const [configured, setConfigured] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/studio', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Studio unavailable')
      const data = await response.json()
      setModel(data.model); setConfigured(data.configured)
    }).catch(() => {})
    const events = new EventSource('/api/studio/events')
    events.onmessage = event => {
      const data = JSON.parse(event.data) as StudioSnapshot
      setDocuments(data.documents); setConnected(true)
    }
    events.onerror = () => setConnected(false)
    return () => { controller.abort(); events.close() }
  }, [])
  return { documents, connected, model, configured }
}

export function ComponentSurface({ document }: { document: ComponentDocument }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const latest = useRef(document)
  latest.current = document
  const ready = useRef(false)
  const [height, setHeight] = useState(320)
  const [error, setError] = useState('')
  const mount = useCallback(() => {
    setError('')
    frame.current?.contentWindow?.postMessage({ channel: 'hubble-component', type: 'mount', javascript: latest.current.javascript, revision: latest.current.revision }, '*')
  }, [])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null' || event.data?.channel !== 'hubble-component') return
      if (event.data.type === 'ready') { ready.current = true; mount() }
      if (event.data.type === 'height' && Number.isFinite(event.data.height)) setHeight(Math.max(60, Math.min(1800, event.data.height)))
      // Compilation replaces the running revision without replacing its frame.
      // A late error from the previous mount must not stain the new surface.
      if (event.data.type === 'error' && event.data.revision === latest.current.revision) setError(String(event.data.message))
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [mount])
  useEffect(() => { if (ready.current) mount() }, [document.revision, mount])
  return <div className="studio-component-body">
    <iframe ref={frame} title={document.title} src={`/api/studio/frame?origin=${encodeURIComponent(location.origin)}`} sandbox="allow-scripts" style={{ height }} />
    {error && <p className="studio-error" role="alert">{error}</p>}
  </div>
}

const SUGGESTIONS = [
  ['Explore an idea', 'Make an interactive Pythagorean theorem explorer with sliders and a diagram.'],
  ['Build a tiny tool', 'Create a thoughtful breathing exercise with a start button, a moving circle and a timer.'],
  ['Make it playful', 'Create an interactive flashcard quiz about space, with reveal and next controls.'],
]

export function StudioPage({ projector = false }: { projector?: boolean }) {
  const { documents, connected, model, configured } = useStudio()
  const assistant = usePuppetAssistant()
  // Only the projector view follows the server's mode (see projectorMode.ts).
  // ?calibrate=1 forces the pattern so it can be checked in a normal browser.
  const projectorMode = useProjectorMode()
  const calibrating = projector && (projectorMode.mode === 'calibrate' || new URLSearchParams(location.search).get('calibrate') === '1')
  const [prompt, setPrompt] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('Your table is ready. What shall we make?')
  const [editing, setEditing] = useState<ComponentDocument | null>(null)
  const [source, setSource] = useState('')
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [sourceError, setSourceError] = useState('')
  const editor = useRef<HTMLDialogElement>(null)
  const editorTrigger = useRef<HTMLButtonElement | null>(null)
  const editorSession = useRef(0)
  const savingSource = useRef<string | null>(null)
  const generationTarget = useRef<string | undefined>(undefined)
  const abort = useRef<AbortController | null>(null)
  const generating = useRef(false)
  const target = documents.find(document => document.id === selected)
  const sourceConflict = busy && Boolean(editing)
  const closeEditor = useCallback(() => { editorSession.current++; setEditing(null) }, [])
  const editingId = editing?.id
  useEffect(() => {
    if (!editingId || !editor.current) return
    const dialog = editor.current
    const trigger = editorTrigger.current
    // A native modal makes the rest of the page (including sandboxed frames)
    // inert. Keyboard handling alone would miss iframe focus and leave the
    // rest of the page reachable to assistive technology behind the modal.
    dialog.showModal()
    dialog.querySelector<HTMLButtonElement>('header button')?.focus()
    // Chrome can otherwise include its browser chrome at the modal's Tab
    // boundary. Keep that boundary within the editor while native modality
    // continues to isolate every background control and embedded frame.
    const containTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const controls = [...dialog.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]')]
        .filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && control.getClientRects().length > 0)
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    dialog.addEventListener('keydown', containTab)
    return () => {
      dialog.removeEventListener('keydown', containTab)
      dialog.close()
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [editingId])
  useEffect(() => {
    if (selected && !target) setSelected(null)
  }, [selected, target])
  useEffect(() => {
    return () => abort.current?.abort()
  }, [])

  const generate = useCallback(async (instruction: string, id?: string) => {
    if (!instruction.trim() || generating.current || (id && savingSource.current === id)) return
    generating.current = true
    generationTarget.current = id
    const controller = new AbortController(); abort.current = controller
    setBusy(true); setError(''); setMessage('Hubble is shaping a new component…')
    try {
      // send() resolves false when it was ignored (a turn is already running; the
      // agent is never interrupted). Keep the typed text so nothing the user wrote is lost.
      if (await assistant.send(instruction, id)) { setPrompt(''); setSelected(null) }
    } catch (reason) {
      if (controller.signal.aborted) setMessage('Generation stopped. Your table is still here.')
      else { setError(reason instanceof Error ? reason.message : 'Could not reach the studio.'); setMessage('Let’s try that again.') }
    } finally { generating.current = false; generationTarget.current = undefined; setBusy(false); abort.current = null }
  }, [assistant.send])
  useEffect(() => { assistant.select(selected ?? undefined) }, [selected])
  useEffect(() => {
    const last = assistant.turns.at(-1)
    if (last?.role === 'assistant') setMessage(last.content)
  }, [assistant.turns])
  useEffect(() => {
    if (assistant.busy) { setBusy(true); generationTarget.current = selected ?? undefined }
    else if (!generating.current) { setBusy(false); generationTarget.current = undefined }
  }, [assistant.busy, selected])

  const mutate = async (url: string, method: string, body?: unknown) => {
    setError('')
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? 'Could not update this component.')
    return data
  }
  const remove = (id: string) => void mutate(`/api/studio/components/${id}`, 'DELETE').catch(reason => setError(reason.message))
  const edit = (document: ComponentDocument, trigger: HTMLButtonElement) => {
    editorTrigger.current = trigger; editorSession.current++
    setError(''); setSourceError(''); setEditing(document); setSource(document.source); setTitle(document.title)
  }
  const save = async () => {
    // Refs close the same-render double-click race and arbitrate source writes
    // against refinements of this exact component, including voice requests.
    // Closing is still allowed while saving; the session token prevents an old
    // response from closing a newly opened editor or showing its errors there.
    if (!editing || savingSource.current || !connected || busy) return
    const session = editorSession.current
    savingSource.current = editing.id
    setSaving(true); setSourceError('')
    try {
      await mutate(`/api/studio/components/${editing.id}`, 'PUT', { title, source })
      if (editorSession.current === session) closeEditor()
      setMessage('Source compiled. The new version is running.')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Compilation failed.'
      if (editorSession.current === session) setSourceError(message)
      else setError(message)
    } finally { savingSource.current = null; setSaving(false) }
  }

  return <div className={`liquid-theme studio${projector ? ' studio--projector' : ''}`}>
    {calibrating && <CalibrationPattern since={projectorMode.since} />}
    <div className="studio-aurora" aria-hidden="true" />
    {!projector && <>
      <header className="studio-header">
        <a className="studio-brand" href="/studio"><span className="studio-mark">✳</span> hubble<span className="studio-brand-divider" />studio</a>
        <nav><a href="/">Render bench ↗</a><a href="/studio/projector" target="_blank" rel="noreferrer">Projector view ↗</a><ProjectorModeSwitch /><span className="studio-connection"><i className={connected ? 'is-connected' : ''} />{connected ? 'Surface connected' : 'Connecting to studio'}</span></nav>
      </header>
      <section className="studio-intro">
        <div><div className="studio-eyebrow">A PLACE FOR IDEAS TO BECOME REAL</div><h1>Think it.<br /><span>Make space for it.</span></h1><p>A living canvas for little tools, big questions,<br className="studio-desktop-break" /> and whatever comes next.</p></div>
        <div className="studio-intro-note"><span className="studio-note-orbit">◌</span><p>One shared design language.<br />Every component, a life of its own.</p><span>LIQUID SYSTEM / 01</span></div>
      </section>
    </>}
    <main className="studio-main">
      <section className="studio-canvas" aria-label="Live component canvas">
        {!projector && <div className="studio-section-label"><span>ON YOUR TABLE <small>{String(documents.length).padStart(2, '0')}</small></span><span>Persistent surface · React inside</span></div>}
        <div className="studio-grid">
          {documents.map(document => <article key={document.id} className={`studio-surface${selected === document.id ? ' is-selected' : ''}`}>
            {!projector && <div className="studio-surface-toolbar"><span>{document.title}</span><div><button onClick={() => setSelected(selected === document.id ? null : document.id)} aria-pressed={selected === document.id} aria-label={`Refine ${document.title}`} title="Refine with Hubble">✧</button><button onClick={event => edit(document, event.currentTarget)} aria-label={`Edit source for ${document.title}`} title="Edit source">〈/〉</button><button onClick={() => remove(document.id)} aria-label={`Remove ${document.title}`} title="Remove component">×</button></div></div>}
            <ComponentSurface document={document} />
            {!projector && <div className="studio-surface-footer"><span><i />Independent React component</span><span>v{document.revision}</span></div>}
          </article>)}
          {!projector && documents.length < 12 && <button className="studio-add-tile" onClick={() => { setSelected(null); document.getElementById('studio-prompt')?.focus() }}><span>＋</span><strong>Something new belongs here.</strong><small>Ask Hubble to make it.</small></button>}
        </div>
        {documents.length === 0 && projector && <p className="studio-empty">A little space for what comes next.</p>}
        {!projector && <div className="studio-library"><span>START WITH A SKETCH</span>{EXAMPLES.map(example => <button key={example.title} disabled={!connected} onClick={() => void mutate('/api/studio/examples', 'POST', { title: example.title }).catch(reason => setError(reason.message))}>{example.title} <span>＋</span></button>)}</div>}
      </section>
      {!projector && <aside className="studio-assistant" aria-label="Hubble component assistant">
        <div className="studio-assistant-top"><div className={`studio-assistant-orb${busy ? ' is-thinking' : ''}`} aria-hidden="true"><span /></div><div><h2>Hubble</h2><p>{busy ? 'Making something for you' : 'Your spatial assistant'}</p></div><UI.Badge>{model}</UI.Badge></div>
        <div className="studio-assistant-message" aria-live="polite">{message}</div>
         <p className="studio-assistant-caption">Type to Hubble. One agent can answer out loud and add, revise, remove, clear or reset your canvas.</p>
         {assistant.activity && <p className="studio-config-hint" role="status">{assistant.activity}</p>}
        <div className="studio-suggestions">{SUGGESTIONS.map(([label, instruction]) => <button key={label} disabled={busy || !connected} onClick={() => void generate(instruction)}><span>✧</span>{label}<span>↗</span></button>)}</div>
        <div className="studio-composer">
          {target && <div className="studio-refine">Refining: {target.title}<button aria-label="Generate a new component instead" onClick={() => setSelected(null)}>×</button></div>}
          <label className="studio-visually-hidden" htmlFor="studio-prompt">Describe a component</label>
          <textarea id="studio-prompt" value={prompt} maxLength={2000} placeholder={target ? 'How should this component change?' : '“Make me a tool to explore gravity…”'} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void generate(prompt, selected ?? undefined) } }} />
          <div className="studio-composer-bottom"><span>One agent · voice + canvas</span><VoiceSelect assistant={assistant} className="studio-voice-select" /><button aria-label={busy ? 'Stop generation' : 'Generate component'} disabled={!busy && (!prompt.trim() || !connected || assistant.busy)} onClick={() => busy ? (abort.current?.abort(), assistant.stopTurn()) : void generate(prompt, selected ?? undefined)}>{busy ? '■' : '↑'}</button></div>
        </div>
        {assistant.error && <p className="studio-error" role="alert">{assistant.error}</p>}
        {!configured && <p className="studio-config-hint">Examples are ready to play. Add your existing <code>HUBBLE_LLM_API_KEY</code> to enable generation.</p>}
        {error && <p className="studio-error" role="alert">{error}</p>}
        <div className="studio-assistant-foot"><span>✦</span> Built with your shared Liquid UI kit</div>
      </aside>}
    </main>
    {!projector && <footer className="studio-footer"><span>HUBBLE / LIQUID STUDIO</span><span>Living components. One uninterrupted page.</span><span>Session-only canvas</span></footer>}
    {projector && !connected && <p className="studio-projector-status" role="status">Reconnecting to the studio…</p>}
    {editing && <dialog ref={editor} className="studio-editor" aria-modal="true" aria-labelledby="studio-editor-title" aria-describedby="studio-editor-note" onCancel={event => { event.preventDefault(); closeEditor() }}><header><div><span className="studio-eyebrow">ACTUAL CODE. YOUR DESIGN.</span><h2 id="studio-editor-title">Component source</h2></div><button autoFocus aria-label="Close source editor" onClick={closeEditor}>×</button></header><UI.Input label="Component name" value={title} onChange={setTitle} /><label htmlFor="studio-source">React TSX · React and UI are provided</label><textarea id="studio-source" value={source} onChange={event => setSource(event.target.value)} spellCheck={false} />{sourceError && <p className="studio-error" role="alert">{sourceError}</p>}<div className="studio-editor-footer"><p id="studio-editor-note">{sourceConflict ? 'Wait for this component’s generation to finish before compiling.' : !connected ? 'Reconnect to the studio before compiling.' : 'Recompiling resets this component’s state. Other components keep running.'}</p><UI.Button disabled={saving || sourceConflict || !connected} onClick={() => void save()}>{saving ? 'Compiling…' : 'Compile & update'}</UI.Button></div></dialog>}
  </div>
}
