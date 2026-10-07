import { useState } from 'react'
import { post, type Status } from '../operator/status.ts'
import type { ShowAssistant } from './ShowView.tsx'
import { runStep, type Io, type StepId } from './stepRuns.ts'
import { useUiSync } from './uiSync.ts'

/**
 * Show's step list (owner, 7 Oct): "first is we place the ipad on the table.
 * we click run it solves it. 2nd is we place the piano ... 3rd is the keyboard
 * with swipe and lidar." Five slots so the show has its final shape now;
 * 4 and 5 are placeholders until they are built.
 *
 * Only one step is active: the last one run. What Run does lives in
 * stepRuns.ts (tested); this only draws and keeps each step's status.
 */

type Phase = 'idle' | 'running' | 'done' | 'error'
interface StepState {
  phase: Phase
  text: string
  read?: string
}

const SONGS = [
  { id: 'twinkle', title: 'Twinkle Twinkle' },
  { id: 'ode-to-joy', title: 'Ode to Joy' },
]

const STEPS: { id: StepId | null; title: string; place: string }[] = [
  { id: 'math', title: 'Math on the iPad', place: 'Place the iPad on the table.' },
  { id: 'piano', title: 'Piano', place: 'Place the MiniLab on the table.' },
  // The keyboard step (swipe, pinch, lidar typing) left the show on 7 Oct
  // 14:20: the owner's call, no time to make it reliable on the real table.
  { id: null, title: 'Coming', place: 'Step 4 is not built yet.' },
  { id: null, title: 'Coming', place: 'Step 5 is not built yet.' },
]

const get = (url: string) => fetch(url).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }))

export function ShowSteps({ assistant, status: s, act }: { assistant: ShowAssistant; status: Status | null; act: (label: string, url: string, body?: unknown) => Promise<unknown> }) {
  const [localActive, setActive] = useState<StepId | null>(null)
  const [localState, setLocalState] = useState<Partial<Record<StepId, StepState>>>({})
  // TV 1's mirror draws the operator's active step and its status line; the
  // operator's page reports every change of them (uiSync.ts).
  const sync = useUiSync()
  const active = sync.mirror ? (sync.ui.step as StepId | null) : localActive
  const state: Partial<Record<StepId, StepState>> =
    sync.mirror && sync.ui.step ? { [sync.ui.step]: { phase: (sync.ui.stepPhase ?? 'idle') as Phase, text: sync.ui.stepText ?? '' } } : localState
  const setState = setLocalState
  const [song, setSong] = useState('twinkle')
  const [followUp, setFollowUp] = useState('')

  const io: Io = { post, get, ask: (t) => assistant.send(t).catch(() => {}) }

  const run = async (id: StepId) => {
    setActive(id)
    sync.report({ step: id, stepPhase: 'running', stepText: 'running…' })
    setState((m) => ({ ...m, [id]: { phase: 'running', text: 'running…' } }))
    try {
      const r = await runStep(id, io, { song })
      setState((m) => ({ ...m, [id]: { phase: r.ok ? 'done' : 'error', text: r.text, read: r.read } }))
      sync.report({ step: id, stepPhase: r.ok ? 'done' : 'error', stepText: r.text })
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e)
      setState((m) => ({ ...m, [id]: { phase: 'error', text } }))
      sync.report({ step: id, stepPhase: 'error', stepText: text })
    }
  }
  const reset = (id: StepId) => {
    setState((m) => ({ ...m, [id]: { phase: 'idle', text: 'idle' } }))
    sync.report({ step: id, stepPhase: 'idle', stepText: 'idle' })
    void act('clear table', '/api/operator/close-all')
  }

  // SEND goes to the puppet master, so the last thing typed is its last user turn.
  const typed = [...assistant.turns].reverse().find((t) => t.role === 'user')?.content

  return (
    <ol className="show-steps" aria-label="demo steps">
      {STEPS.map((step, i) => {
        const id = step.id
        const st = id ? state[id] : undefined
        return (
          <li key={i} className={`show-stepcard ${id && active === id ? 'active' : ''} ${id ? '' : 'coming'}`}>
            <span className="show-stepnum">{i + 1}</span>
            <div className="show-stepbody">
              <h2>{step.title}</h2>
              <p className="show-place">{step.place}</p>
              {id && (
                <div className="show-row">
                  <button className="show-run" disabled={st?.phase === 'running'} onClick={() => void run(id)}>
                    {st?.phase === 'running' ? 'Running…' : 'Run'}
                  </button>
                  <button onClick={() => reset(id)}>Reset</button>
                  {id === 'piano' && (
                    <select aria-label="song" value={song} onChange={(e) => setSong(e.target.value)}>
                      {SONGS.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.title}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
              {id && (
                <small className={`show-stepstatus ${st?.phase ?? 'idle'}`} role="status">
                  {st?.phase ?? 'idle'}
                  {st?.text && st.text !== 'idle' ? ` · ${st.text}` : ''}
                </small>
              )}
              {id === 'math' && active === 'math' && (
                <>
                  {st?.read && <pre className="show-read">{st.read}</pre>}
                  <form
                    className="show-ask"
                    onSubmit={(e) => {
                      e.preventDefault()
                      const t = followUp.trim()
                      if (!t || assistant.busy) return
                      setFollowUp('')
                      void assistant.send(t).catch(() => {})
                    }}
                  >
                    <input aria-label="follow-up" value={followUp} onChange={(e) => setFollowUp(e.target.value)} placeholder="Ask a follow-up…" />
                    <button type="submit" disabled={assistant.busy || !followUp.trim()}>
                      {assistant.busy ? '…' : 'ask'}
                    </button>
                  </form>
                </>
              )}
              {id === 'piano' && (
                <small>
                  keys detected: {s?.keys ?? 0}/25{s?.keySource ? ` (${s.keySource})` : ''}
                  {s?.lesson ? ` · ${s.lesson.song}: note ${s.lesson.index} of ${s.lesson.total}` : ''}
                </small>
              )}
              {id === 'keyboard' && (
                <small>
                  {/* Lidar touch has no on/off on main yet: it feeds the keyboard whenever the room's lidar is registered. */}
                  typed: {typed ?? '—'} · SEND: {assistant.busy ? `${assistant.activity || 'asking'}…` : 'ready'}
                </small>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
