import { useState } from 'react'
import { LessonPanel } from '../lesson/LessonPanel.tsx'
import { useOperatorStatus, type Status } from '../operator/status.ts'
import { PianoPanel } from '../operator/PianoPanel.tsx'
import { VoiceSelect } from '../hubble/assistant/VoiceSelect.tsx'
import type { usePuppetAssistant } from '../hubble/assistant/usePuppetAssistant.ts'
import { PRESETS } from './presets.ts'
import { ProblemsMenu, shownPicks } from './ProblemsMenu.tsx'
import { ShowSteps } from './ShowSteps.tsx'
import { ScreensPreview } from './ScreensPreview.tsx'
import { ActivityFeed } from './ActivityFeed.tsx'
import { useUiSync } from './uiSync.ts'

/**
 * Show mode: the operating surface during a demo (#75).
 *
 * Built for one person who is talking to an audience and glancing at the
 * laptop. Everything is in show order (act 1, then act 2) and each act's steps
 * are numbered. Everything technical (the model picker, simulator tools,
 * calibration, the hand tracker, room rehearsal, debug) is in Setup. The
 * owner's brief: "I do not know how to control and demo stuff."
 *
 * This view only draws and sends. The device state is status.ts's (shared
 * with Setup's show column). Every question goes to the owner's puppet master
 * through the assistant hook, which OperatingSurface mounts ONCE and passes
 * down: the page is the conversation's home, so switching Show/Setup never
 * drops it. Owner, 7 Oct: "use MY assistant". Julius's /api/agent/turn is no
 * longer called from here (the route stays, so his merges apply cleanly).
 * There are no recorded backups either: owner, "no backups".
 */

/** The slice of usePuppetAssistant() this view reads; a prop so the page owns the one hook. */
export type ShowAssistant = Pick<ReturnType<typeof usePuppetAssistant>, 'state' | 'turns' | 'error' | 'busy' | 'activity' | 'notice' | 'stopTurn' | 'send' | 'voices' | 'voice' | 'setVoice'>

type Level = 'ok' | 'warn' | 'bad' | 'idle'

// id: what /api/operator/act takes; title: what the lesson reports back
// (apps/server/lesson/lesson.ts SONGS), so the playing song lights up.
const SONGS = [
  { id: 'ode-to-joy', title: 'Ode to Joy' },
  { id: 'twinkle', title: 'Twinkle Twinkle' },
]

/**
 * The camera light's text, naming which calibration is in use. A standard
 * (committed recording) map and a live measurement behave differently enough
 * on site that the operator must be able to tell them apart at a glance:
 * "calibrated" alone hid that the room was running on the fallback.
 */
function cameraText(c: Status['camera']): string {
  if (!c.calibrated) return 'not calibrated'
  const at = c.at?.slice(11, 16) // HH:MM of the ISO instant
  if (c.source === 'standard') return `calibrated (standard${at ? ` ${at}` : ''})`
  if (c.source === 'measured') return `calibrated (measured${at ? ` ${at}` : ''})`
  return 'calibrated'
}

function lights(s: Status | null, down: boolean): { name: string; level: Level; text: string }[] {
  // Down is expected under the Studio server (it has no devices), so it reads calm, not as a fault.
  if (down || !s) return [{ name: 'devices', level: down ? 'idle' : 'warn', text: down ? 'full server not running' : 'connecting…' }]
  const keys = s.keys ?? 0
  return [
    { name: 'model', level: s.brain.configured ? (s.brain.lastRender && !s.brain.lastRender.ok ? 'warn' : 'ok') : 'bad', text: s.brain.configured ? 'ready' : 'no key' },
    { name: 'room', level: s.room.ok ? 'ok' : s.room.kind === 'none' ? 'warn' : 'bad', text: s.room.kind === 'none' ? 'not connected' : s.room.ok ? s.room.kind : `${s.room.kind}: down` },
    { name: 'camera', level: s.camera.calibrated ? 'ok' : 'warn', text: cameraText(s.camera) },
    { name: 'keys', level: keys === 25 && s.keySource === 'camera' ? 'ok' : keys > 0 ? 'warn' : 'bad', text: keys > 0 ? `${keys}/25 · ${s.keySource ?? 'estimate'}` : 'not found' },
    { name: 'iPad', level: s.worksheet?.on ? (s.worksheet.error ? 'bad' : 'ok') : 'warn', text: s.worksheet?.on ? lightText(shownPicks(s.worksheet)) : 'off' },
  ]
}

/** One problem by name, as before #88; several by count, which fits a status light. */
const lightText = (picks: string[]) => (picks.length === 0 ? 'on' : picks.length === 1 ? picks[0]! : `${picks.length} problems`)

export function ShowView({ assistant }: { assistant: ShowAssistant }) {
  const { s, down, note, act, lessonControl } = useOperatorStatus()
  const [text, setText] = useState('')
  const [minilab, setMinilab] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  // TV 1's mirror opens and closes "More" with the operator (uiSync.ts).
  const sync = useUiSync()

  const { busy, turns, error, activity, notice, stopTurn, send } = assistant
  // send() rethrows a failed turn after setting `error`; the catch keeps that from becoming an
  // unhandled rejection. It resolves false when ignored (empty, or a turn already running).
  const ask = (q: string) => {
    const t = q.trim()
    if (!t || busy) return
    setText('')
    void send(t).catch(() => {})
  }
  const recent = turns.slice(-6)

  const sheet = s?.worksheet ?? null
  const output = s?.output
  const inLesson = s?.act === 'lesson'

  return (
    <div className="show">
      <section className="show-status" aria-label="status">
        {lights(s, down).map((l) => (
          <span key={l.name} className={`show-light ${l.level}`} title={l.text}>
            <b>{l.name}</b> {l.text}
          </span>
        ))}
        {output?.requiresArm && (
          // The owner's go for room writes, as a switch: "safe" until armed.
          <button className={`show-arm ${output.active ? 'armed' : ''}`} onClick={() => void act(output.active ? 'room output off' : 'room output on', '/api/operator/room', { armed: !output.active })}>
            room output: {output.active ? 'ARMED' : 'safe'}
          </button>
        )}
        {/* The reference markers (#91, iPad camera) and pinch typing (#75)
            left Show on 7 Oct 14:20 (owner: "remove the keyboard completely
            and the iPad camera, we do not have time to make that work").
            Their code stays; Setup still reaches the markers. */}
        <span className="show-note">{note}</span>
        {down && <p className="show-offline">The full server (room, projector, iPad worksheet) is not running. Hubble still answers; the table preview and device controls need it.</p>}
      </section>

      {/* What the projector and both TVs show right now (owner, 7 Oct). */}
      <ScreensPreview />

      {/* Steps on the left, the live activity feed on the right (below on
          narrow screens). The feed owns its own store, so its lines never
          re-render this view. */}
      <div className="show-main">
      <div className="show-main-steps">
      {/* The demo runner (owner, 7 Oct): one step per act, in show order. */}
      <ShowSteps assistant={assistant} status={s} act={act} />

      {/* Everything Show had before the steps, moved here, not deleted. */}
      <details
        className="show-more"
        {...(sync.mirror ? { open: sync.ui.more } : {})}
        onToggle={(e) => {
          const o = (e.currentTarget as HTMLDetailsElement).open
          setMoreOpen(o)
          if (!sync.mirror) sync.report({ more: o })
        }}
      >
        <summary>More: presets, conversation, piano panel, preview</summary>
      <div className="show-body">
        <div className="show-acts">
          <section className={`show-act ${inLesson ? '' : 'live'}`}>
            <h2>
              Act 1 · Math {!inLesson && <em>live</em>}
            </h2>
            <ol>
              <li>
                <span className="show-step">iPad problems</span>
                {sheet ? (
                  <>
                    <ProblemsMenu sheet={sheet} send={(taskIds) => act('iPad problems', '/api/operator/worksheet', { on: true, taskIds })} />
                    {sheet.on && <small className="show-url">iPad: {sheet.url ?? 'no LAN address: is the laptop on the room network?'}</small>}
                    {sheet.error && <small className="show-err">{sheet.error}</small>}
                  </>
                ) : (
                  <small>no worksheet on this server</small>
                )}
              </li>
              <li>
                <span className="show-step">Ask</span>
                <form
                  className="show-ask"
                  onSubmit={(e) => {
                    e.preventDefault()
                    ask(text)
                  }}
                >
                  <input aria-label="question" value={text} onChange={(e) => setText(e.target.value)} placeholder="type a question, or press one below…" />
                  <button type="submit" className="show-primary" disabled={busy || !text.trim()}>
                    {busy ? '…' : 'ask'}
                  </button>
                </form>
                <div className="show-presets">
                  {PRESETS.map((p) => (
                    <button key={p.label} disabled={busy} onClick={() => ask(p.text)}>
                      {p.label}
                    </button>
                  ))}
                </div>
                {busy && (
                  <div className="show-activity" role="status">
                    <span>{activity || 'Working'}…</span>
                    <button className="danger" onClick={stopTurn}>
                      Stop
                    </button>
                  </div>
                )}
                {/* Keyboard / pinch text that arrived while Hubble was busy is dropped (one turn
                    at a time, like a second typed turn); this says so instead of losing it silently. */}
                {notice && <small role="status">{notice}</small>}
                {error && (
                  <small className="show-err" role="alert">
                    Hubble could not answer: {error}
                  </small>
                )}
                {recent.length > 0 && (
                  <div className="show-convo" aria-label="conversation">
                    {recent.map((t) => (
                      <p key={t.id} className={t.role === 'user' ? 'you' : 'hubble'}>
                        <b>{t.role === 'user' ? 'You' : 'Hubble'}:</b> {t.content}
                      </p>
                    ))}
                  </div>
                )}
                <VoiceSelect assistant={assistant} className="show-voice" />
              </li>
            </ol>
          </section>

          <section className={`show-act ${inLesson ? 'live' : ''}`}>
            <h2>
              Act 2 · Keyboard {inLesson && <em>live</em>}
            </h2>
            <ol>
              <li>
                <span className="show-step">Keys</span>
                {/* Show and Setup mount separately; both consume the same
                    server state. The demo needs its enable control here too,
                    otherwise default-off detection looks like a lost camera. */}
                <PianoPanel />
              </li>
              <li>
                <span className="show-step">Play</span>
                <div className="show-row">
                  {SONGS.map((song) => (
                    <button key={song.id} className={inLesson && s?.lesson?.song === song.title ? 'on' : ''} onClick={() => void act(`keyboard: ${song.title}`, '/api/operator/act', { act: 'lesson', song: song.id })}>
                      ▶ {song.title}
                    </button>
                  ))}
                  <button disabled={!inLesson} onClick={() => void act('back to math', '/api/operator/act', { act: 'math' })}>
                    ■ stop, back to math
                  </button>
                </div>
                {s?.lesson && (
                  <small>
                    {s.lesson.song}: note {s.lesson.index} of {s.lesson.total}
                  </small>
                )}
              </li>
              <li>
                <span className="show-step">Practice</span>
                <button className="show-link" onClick={() => setMinilab((v) => !v)}>
                  {minilab ? 'hide' : 'show'} the virtual MiniLab
                </button>
              </li>
            </ol>
            {/* Mounted only when opened, and only in Show: it is the page's
                one LessonPanel (each forwards every MIDI key), and Setup's
                show column has the other, never on screen together. */}
            {minilab && <LessonPanel control={lessonControl} />}
          </section>
        </div>

        <section className="show-stage">
          <div className="show-stage-head">
            <h2>On the table now</h2>
            <small>the projector's own page</small>
          </div>
          {/* The projector's page itself, not a re-drawing of it: what the Pi
              shows is what this shows, by construction. */}
          {/* Only while the drawer is open: a <details> keeps its children
              mounted when closed, and this hidden /table held its streams
              against Chrome's six-per-host limit (7 Oct: a web page on the
              owner's /table tab stayed white). */}
          {moreOpen && <iframe className="show-preview" title="projector preview" src="/table" />}
          <div className="show-row">
            <button onClick={() => void act('clear table', '/api/operator/close-all')}>clear the table</button>
            <button className="danger" onClick={() => void act('reset', '/api/operator/reset')}>
              reset the show
            </button>
          </div>
        </section>
      </div>
      </details>
      </div>
      <ActivityFeed assistant={assistant} />
      </div>
    </div>
  )
}
