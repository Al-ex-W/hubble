import { useEffect, useRef, useState } from 'react'
import type { Surface, TouchLine } from '@hubble/stage'
import { subscribeStage } from './stageStream.ts'

/**
 * Rings of light spreading out from where a finger touched the table (#89).
 * The server's spatial service finds the finger through the lidar; the runtime
 * sends a `touch` line; this only draws.
 *
 * The look comes from the research H46 forwarded on 2026-10-07 (plan
 * docs/plans/2026-10-07-lidar-touch.md, Ruling 9):
 *
 * - Light on black, at full intensity. The table is WHITE: the projector can only
 *   add light, so "black" is simply no light, and a dim or dark ring would be
 *   invisible. Cyan matches the keyboard cursor (keyboardInput.ts), so it reads
 *   as the same system's feedback.
 * - Two rings, 12 → 70 mm radius, 4 mm stroke, 600 ms. Sizes are physical (mm
 *   through the Surface's mm/px, AGENTS.md rule 5): when the room is measured
 *   and mm/px changes, the ripple stays the size of a fingertip's
 *   neighbourhood, not a pixel count that happened to look right on one setup.
 * - Animated with transform and opacity only, so the browser can run it on the
 *   compositor without re-laying-out the answer under it. The Pi 5 drives a
 *   1920×1200 page; a ring that re-lays-out every frame would stutter the
 *   answer's own pen animation.
 * - At most 8 alive: a palm or a run of noisy scans can't flood the page with
 *   ripples; the oldest goes first.
 *
 * Only `down` ripples. `move`/`up`/`cancel` are on the wire for later consumers
 * (a held glow, the keyboard); ripples on move would draw a trail of rings that
 * reads as noise, not as "I felt that".
 */

export const RIPPLE = {
  startMm: 12,
  endMm: 70,
  strokeMm: 4,
  durationMs: 600,
  /** The second ring follows the first, so it reads as a wave, not a blink. */
  ringDelayMs: 150,
  rings: 2,
  max: 8,
  /** Liquid's lavender accent (liquid.css --liquid-accent), the same hue as the
   *  stage's corners, so a touch reads as "the table answered", not a new UI. */
  color: '#becaff',
  /**
   * A white flash ring under the lavender ones (#lidar-wizard): on the white
   * table lavender light is a faint tint, while full white is the brightest the
   * projector can add, so the touch is seen even in a lit hall. Short, so it
   * reads as a flash and the lavender wave is what lingers.
   */
  flashColor: '#ffffff',
  flashMs: 350,
  flashStrokeMm: 8,
} as const

/** The ripple in projector px for this surface; the one place mm become px. */
export function rippleGeometry(surface: Pick<Surface, 'mmPerPx'>) {
  const px = (mm: number) => mm / surface.mmPerPx
  return { endR: px(RIPPLE.endMm), startScale: RIPPLE.startMm / RIPPLE.endMm, strokePx: px(RIPPLE.strokeMm) }
}

interface Ripple {
  key: number
  x: number
  y: number
}

/** The ripple list, fed by the shared stage stream. Exported for the test. */
export function useTouchRipples(): Ripple[] {
  const [ripples, setRipples] = useState<Ripple[]>([])
  const next = useRef(0)
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const off = subscribeStage({
      // A reconnect starts clean: whatever was rippling belonged to touches the
      // server will never send an end for on this connection.
      open: () => setRipples([]),
      line: (line) => {
        if (line.kind !== 'touch') return
        const t = line as unknown as TouchLine
        if (t.phase !== 'down' || !Number.isFinite(t.p?.x) || !Number.isFinite(t.p?.y)) return
        const key = next.current++
        setRipples((prev) => [...prev, { key, x: t.p.x, y: t.p.y }].slice(-RIPPLE.max))
        // Removal by timer, not `animationend`: that event doesn't fire in a
        // hidden tab or when animations are disabled, and then ripples would
        // pile up to the cap and stay drawn forever.
        const life = RIPPLE.durationMs + RIPPLE.ringDelayMs * (RIPPLE.rings - 1) + 50
        const timer = setTimeout(() => {
          timers.delete(timer)
          setRipples((prev) => prev.filter((r) => r.key !== key))
        }, life)
        timers.add(timer)
      },
    })
    return () => {
      off()
      for (const t of timers) clearTimeout(t)
    }
  }, [])
  return ripples
}

const KEYFRAMES = `@keyframes hubble-ripple { from { transform: scale(var(--start)); opacity: 1 } to { transform: scale(1); opacity: 0 } }`

export function TouchRipples({ surface }: { surface: Surface }) {
  const ripples = useTouchRipples()
  const g = rippleGeometry(surface)
  // An SVG in projector px with a viewBox, like OverlayLayer: whatever size
  // the page is, a touch at page px (x, y) lands on the same spot as the
  // overlays and surfaces drawn from the same frame.
  return (
    <svg
      data-testid="touch-ripples"
      viewBox={`0 0 ${surface.widthPx} ${surface.heightPx}`}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
    >
      <style>{KEYFRAMES}</style>
      {ripples.map((r) => (
        <circle
          key={`${r.key}-flash`}
          data-flash={r.key}
          cx={r.x}
          cy={r.y}
          r={g.endR * 0.6}
          fill="none"
          stroke={RIPPLE.flashColor}
          strokeWidth={RIPPLE.flashStrokeMm / surface.mmPerPx}
          style={{
            ['--start' as string]: g.startScale,
            transformBox: 'fill-box',
            transformOrigin: 'center',
            opacity: 0,
            animation: `hubble-ripple ${RIPPLE.flashMs}ms ease-out both`,
          }}
        />
      ))}
      {ripples.flatMap((r) =>
        Array.from({ length: RIPPLE.rings }, (_, i) => (
          <circle
            key={`${r.key}-${i}`}
            data-ripple={r.key}
            cx={r.x}
            cy={r.y}
            r={g.endR}
            fill="none"
            stroke={RIPPLE.color}
            // The stroke scales with the ring: thin at 12 mm, 4 mm at full
            // size. Keeping it 4 mm throughout would need either animating `r`
            // (layout work every frame, which the compositor-only rule forbids)
            // or `vector-effect: non-scaling-stroke`, which measures the stroke
            // in SCREEN px and so breaks the mm sizing under the viewBox scale.
            strokeWidth={g.strokePx}
            style={{
              ['--start' as string]: g.startScale,
              transformBox: 'fill-box',
              transformOrigin: 'center',
              opacity: 0,
              animation: `hubble-ripple ${RIPPLE.durationMs}ms cubic-bezier(0.2, 0.6, 0.3, 1) ${i * RIPPLE.ringDelayMs}ms both`,
            }}
          />
        )),
      )}
    </svg>
  )
}
