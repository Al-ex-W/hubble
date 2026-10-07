import { useEffect, useState } from 'react'

/**
 * TV 2: our recorded pitch, looping (owner, 7 Oct 14:41: "the second tv will
 * show a youtube link unlisted video and it will be loop where we record our
 * pitch").
 *
 * Why these embed flags:
 * - `mute=1`: the TV is a kiosk Chromium that never gets a click, and browsers
 *   only autoplay MUTED video without one. The room has no sound anyway.
 * - `loop=1&playlist=<id>`: YouTube's embed only loops a single video when it
 *   is also named as the playlist.
 * - youtube-nocookie: no consent banner on a screen nobody can click.
 *
 * Which video comes from the server (`GET /api/pitch`, room.config.json
 * `pitch.youtube`), not this file, so swapping the video is a config edit and a
 * reload, never a code change on demo day. `?v=<id or url>` overrides it for a
 * quick test.
 */
export function youtubeId(input: string): string | null {
  const s = input.trim()
  if (/^[\w-]{11}$/.test(s)) return s
  try {
    const u = new URL(s)
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1, 12) || null
    const v = u.searchParams.get('v')
    if (v) return v
    const m = u.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{11})/)
    return m ? m[1]! : null
  } catch {
    return null
  }
}

export function PitchPage() {
  const [id, setId] = useState<string | null>(() => {
    const q = new URLSearchParams(location.search).get('v')
    return q ? youtubeId(q) : null
  })
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    if (id) return
    fetch('/api/pitch')
      .then((r) => r.json())
      .then((b: { youtube?: string | null }) => {
        const got = b.youtube ? youtubeId(b.youtube) : null
        if (got) setId(got)
        else setMissing(true)
      })
      .catch(() => setMissing(true))
  }, [id])
  const style = { position: 'fixed' as const, inset: 0, background: '#000', border: 0, width: '100vw', height: '100vh' }
  if (!id)
    return (
      <main style={{ ...style, display: 'grid', placeItems: 'center', color: '#a8aec8', font: '28px system-ui' }}>
        {missing ? 'Set pitch.youtube in room.config.json' : ''}
      </main>
    )
  const src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}&controls=0&modestbranding=1&rel=0&playsinline=1`
  return <iframe title="Hubble pitch" src={src} style={style} allow="autoplay; encrypted-media; fullscreen" />
}
