import { useEffect, useState, type ImgHTMLAttributes, type MouseEvent, type WheelEvent, useRef } from 'react'
import type { Surface, TableSurface } from '@hubble/stage'
import { BoxFrame } from '@hubble/stage-react'

/**
 * Draws a `web` surface (#31): the server's headless Chromium page,
 * streamed as MJPEG into the surface's box. The page was rendered at exactly
 * the box's projector-px size, so the picture is drawn 1:1 and a point on it
 * is the same point on the page.
 *
 * The page is never loaded here: the browser runs on the server (most sites
 * refuse iframes, and the Pi's Chromium has no budget for a second browser).
 * Displays only show frames; only the server reaches the internet.
 *
 * `onInput` is the bench's: a click or a wheel on the picture goes back to
 * the server's page. /table passes none (people touch the real table; hands,
 * #32, go through the same routes on the server).
 */
export type WebInput = { op: 'click'; x: number; y: number } | { op: 'scroll'; dy: number }

const STATUSES = ['loading', 'ready', 'error']

export function webRenderer(s: TableSurface, surface: Surface, onInput?: (id: string, input: WebInput) => void) {
  const st = (s.state ?? {}) as { url?: unknown; title?: unknown; status?: unknown; error?: unknown; stream?: unknown }
  // Only a state the server's openWeb could have written: a stream on our
  // own web route (never a URL a display would fetch from the internet).
  if (typeof st.stream !== 'string' || !st.stream.startsWith('/api/web/') || !STATUSES.includes(st.status as string)) return null
  const { w, h } = s.box
  // Click position in surface px. The box is laid out at projector size and
  // CSS-scaled by BoxFrame, so the click is measured against the element's
  // on-screen rectangle and mapped back, not taken from offsetX (which some
  // engines report before the transform and some after).
  const at = (e: MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / (r.width || 1)) * w, y: ((e.clientY - r.top) / (r.height || 1)) * h }
  }
  return (
    <BoxFrame box={s.box} surface={surface} style={{ background: '#fff', overflow: 'hidden' }}>
      <StreamImage
        src={st.stream}
        alt={typeof st.title === 'string' ? st.title : ''}
        width={w}
        height={h}
        draggable={false}
        data-web-surface={s.id}
        // The bench's projection ignores the pointer so objects under the
        // light stay draggable; a page that takes input opts back in.
        style={{ display: 'block', width: w, height: h, pointerEvents: onInput ? 'auto' : 'none' }}
        onClick={onInput ? (e) => onInput(s.id, { op: 'click', ...at(e) }) : undefined}
        onWheel={onInput ? (e: WheelEvent<HTMLElement>) => onInput(s.id, { op: 'scroll', dy: Math.max(-5000, Math.min(5000, e.deltaY)) }) : undefined}
      />
      {st.status !== 'ready' && (
        // Loading or failed: say so on the table instead of a frozen or
        // blank picture that looks like the page itself.
        <div data-web-status={st.status} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 12, font: '20px system-ui', color: '#fff', background: 'rgba(0,0,0,0.7)' }}>
          {st.status === 'loading' ? 'Loading…' : `Can't show this page${typeof st.error === 'string' ? `: ${st.error}` : ''}`}
        </div>
      )}
    </BoxFrame>
  )
}

/** The bench's input path: the same server routes hands and the swipe keyboard use. */
export function postWebInput(id: string, input: WebInput) {
  const { op, ...body } = input
  void fetch(`/api/web/${encodeURIComponent(id)}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {
    /* the surface state shows a failed page; a lost click needs no second report */
  })
}

/**
 * The stream <img>, re-attached when it fails. An MJPEG <img> that errors
 * (the server restarted, the page was replaced, a display connected in a
 * gap) never retries by itself, and React keeps the same element while the
 * surface's id and URL stay the same, so one failure left a broken picture
 * for the rest of the demo (review #46). A failed stream is asked for again
 * after a second, with a query that makes it a new request.
 */
const RETRY_MS = 1000
function StreamImage({ src, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  // Close the stream when the picture goes away. Why: Chrome keeps an MJPEG
  // <img>'s request open after the element leaves the DOM, and allows six
  // connections per host. On the bench (7 Oct) switching Show ↔ Setup a few
  // times left six dead streams holding every slot, so the new picture's
  // request never started and the page showed white. Clearing src is what
  // makes Chrome abort the request.
  const ref = useRef<HTMLImageElement | null>(null)
  // The element is captured when the effect runs: by the time an unmount's
  // cleanup runs, React has already detached the ref (ref.current is null).
  useEffect(() => {
    const el = ref.current
    return () => {
      if (el) el.src = ''
    }
  }, [])
  useEffect(() => {
    if (!failed) return
    const t = setTimeout(() => {
      setFailed(false)
      setAttempt((n) => n + 1)
    }, RETRY_MS)
    return () => clearTimeout(t)
  }, [failed])
  return <img {...rest} ref={ref} src={attempt ? `${src}?retry=${attempt}` : src} onError={() => setFailed(true)} />
}
