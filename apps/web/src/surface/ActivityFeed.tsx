import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CHANNELS, feed, startFeedSources, type Channel, type FeedLine } from './feed.ts'
import type { ShowAssistant } from './ShowView.tsx'

/**
 * Show's live activity log (owner, 7 Oct: "all channels that is going in so we
 * can see what is happening"). The channels and their summaries are feed.ts's;
 * this only draws, filters and pauses.
 *
 * The assistant's tool calls and typed turns live only in the page's one
 * usePuppetAssistant hook (they are not on any server stream), so they are
 * read from its props here: each change of `activity` is a tool start/end, and
 * each new turn is a question (typed, preset, keyboard SEND or pinch) or an
 * answer.
 */

const hhmmss = (at: number) => new Date(at).toTimeString().slice(0, 8)

export function ActivityFeed({ assistant }: { assistant: Pick<ShowAssistant, 'activity' | 'turns' | 'error'> }) {
  // Off until asked for (7 Oct 15:20, live): its four live streams plus the
  // page's own three used all six of Chrome's connections to :5173, so every
  // Show button's request queued behind them and timed out ("nothing happens
  // when I click"). The streams open only while the feed is switched on.
  const [on, setOn] = useState(false)
  useEffect(() => (on ? startFeedSources() : undefined), [on])

  // Assistant-side events, logged once per change.
  const { activity, turns, error } = assistant
  useEffect(() => {
    if (activity) feed.push('assistant', activity.toLowerCase())
  }, [activity])
  const seenTurn = useRef(turns.at(-1)?.id ?? 0)
  useEffect(() => {
    for (const t of turns) {
      if (t.id <= seenTurn.current) continue
      seenTurn.current = t.id
      const text = String(t.content ?? '').replace(/\s+/g, ' ')
      feed.push('assistant', `${t.role === 'user' ? 'asked' : 'answered'}: ${text.length > 90 ? `${text.slice(0, 89)}…` : text}`)
    }
  }, [turns])
  useEffect(() => {
    if (error) feed.push('error', `assistant: ${error}`)
  }, [error])

  const live = useSyncExternalStore(feed.subscribe, feed.lines)
  const [paused, setPaused] = useState<FeedLine[] | null>(null)
  const [off, setOff] = useState<Set<Channel>>(() => new Set())
  // Errors are never filtered: a dropped channel must stay visible.
  const shown = (paused ?? live).filter((l) => l.channel === 'error' || !off.has(l.channel))

  // Follow the bottom unless the operator scrolled up to read.
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [shown.length, shown.at(-1)?.id])

  const toggle = (c: Channel) =>
    setOff((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })

  return (
    <section className="feed" aria-label="activity">
      <div className="feed-head">
        <h2>Activity</h2>
        <button onClick={() => setOn((o) => !o)}>{on ? 'stop feed' : 'show live feed'}</button>
        {CHANNELS.filter((c) => c !== 'error').map((c) => (
          <button key={c} className={`feed-chip ch-${c} ${off.has(c) ? 'off' : ''}`} aria-pressed={!off.has(c)} onClick={() => toggle(c)}>
            {c}
          </button>
        ))}
        <button className="feed-pause" onClick={() => setPaused((p) => (p ? null : feed.lines()))}>
          {paused ? '▶ resume' : '❚❚ pause'}
        </button>
      </div>
      <div
        className="feed-log"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {shown.length === 0 && <p className="feed-empty">Nothing yet. Every channel's events land here.</p>}
        {shown.map((l) => (
          <div key={l.id} className={`feed-line ch-${l.channel}`}>
            <time>{hhmmss(l.at)}</time>
            <span className="feed-tag">{l.channel}</span>
            <span className="feed-text">{l.text}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
