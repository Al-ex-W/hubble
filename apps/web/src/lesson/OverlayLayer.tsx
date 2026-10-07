import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { OverlayLine } from '@hubble/stage'
import { subscribeStage } from '../table/stageStream.ts'
import { REFERENCE_LAYER, REFERENCE_TTL_MS } from '../../../shared/markers/layout.ts'
import { LIDAR_TARGET_LAYER, LIDAR_TARGET_TTL_MS, TARGET_MM, type LidarTargetLine } from '../../../shared/lidarTarget.ts'

/**
 * Layers that live under a display lease: dropped here when the server's
 * refresh stops coming. Both are calibration light on a shared projector
 * (the reference grid, the lidar wizard's target) that must never outlive a
 * dead server. The lesson's keys and the keyboard trail are NOT leased (see
 * below).
 */
const LEASED: Record<string, number> = { [REFERENCE_LAYER]: REFERENCE_TTL_MS, [LIDAR_TARGET_LAYER]: LIDAR_TARGET_TTL_MS }

/**
 * Draws the runtime's overlay layers (the lesson's lit keys) over the
 * projection, in projector pixels, scaled like the StageView it sits on.
 *
 * Its own component and its own subscription rather than part of StageView:
 * the light changes per keypress and belongs to no answer, so it must neither
 * restart the answer's animation nor disappear when a new answer arrives.
 */
export function useOverlays(): OverlayLine[] {
  const [layers, setLayers] = useState<Record<string, OverlayLine>>({})
  useEffect(() => {
    // The reference grid's lease (layout.ts REFERENCE_TTL_MS; review of #95,
    // finding 3): each reference line restarts this timer, and if no refresh
    // comes in time the layer is dropped HERE, on the display. That is the
    // only part that still works when the server has died or the Wi-Fi has
    // dropped mid-run, which is exactly when a clear can't arrive. Only the
    // reference layer: the lesson's keys and the keyboard trail are product
    // state the server re-sends on change, not every few seconds, and a TTL
    // would make a lit key go dark mid-lesson.
    const expiry = new Map<string, ReturnType<typeof setTimeout>>()
    const drop = (layer: string) => setLayers((prev) => {
      if (!(layer in prev)) return prev
      const { [layer]: _gone, ...rest } = prev
      return rest
    })
    // Shared with every other stage hook on the page (stageStream.ts).
    const unsubscribe = subscribeStage({
      // Reconnect is a complete snapshot. The hub omits cleared layers, so
      // keeping the old map would leave a keyboard trail (or lesson light)
      // forever when its clear happened while this display was disconnected.
      open: () => setLayers({}),
      line: (line) => {
        if (line.kind !== 'overlay') return
        const o = line as unknown as OverlayLine
        setLayers((prev) => ({ ...prev, [o.layer]: o }))
        const ttl = LEASED[o.layer]
        if (ttl !== undefined) {
          const old = expiry.get(o.layer)
          if (old) clearTimeout(old)
          expiry.delete(o.layer)
          if (o.shapes.length) expiry.set(o.layer, setTimeout(() => drop(o.layer), ttl))
        }
      },
    })
    return () => {
      for (const t of expiry.values()) clearTimeout(t)
      unsubscribe()
    }
  }, [])
  return Object.values(layers)
}

export function OverlayLayer({ lines, surface }: { lines: OverlayLine[]; surface: { widthPx: number; heightPx: number; mmPerPx?: number } }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => setScale(el.clientWidth / surface.widthPx)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [surface.widthPx])
  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <svg width={surface.widthPx * scale} height={surface.heightPx * scale} viewBox={`0 0 ${surface.widthPx} ${surface.heightPx}`} style={{ position: 'absolute', left: 0, top: 0 }}>
        <defs>
          <filter id="key-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* Reference markers (#91) are drawn last and crisp: on top of every
            other light, fully opaque, no glow. The glow and the 85 % opacity
            that make a lit key look soft would blur a marker's cell edges
            and let light through its black cells, and the detector reads
            exactly those edges (to a fraction of a camera pixel). */}
        {[...lines.filter((l) => l.layer !== REFERENCE_LAYER), ...lines.filter((l) => l.layer === REFERENCE_LAYER)].flatMap((l) =>
          l.shapes.map((s, i) =>
            l.layer === REFERENCE_LAYER ? (
              <polygon key={`${l.layer}-${i}`} points={s.points.map((p) => `${p.x},${p.y}`).join(' ')} fill={s.color} shapeRendering="crispEdges" />
            ) : (
              <polygon key={`${l.layer}-${i}`} points={s.points.map((p) => `${p.x},${p.y}`).join(' ')} fill={s.color} fillOpacity={0.85 * (s.intensity ?? 1)} filter="url(#key-glow)" />
            ),
          ),
        )}
        {/* The lidar wizard's words under its dot ("hold a finger here"):
            white light, real size, so the person at the table knows the dot
            is for them. The stage protocol has no text shape; the label
            rides on the line (shared/lidarTarget.ts). */}
        {lines.filter((l) => l.layer === LIDAR_TARGET_LAYER && (l as LidarTargetLine).label && l.shapes[0]).map((l) => {
          const pts = l.shapes[0]!.points
          const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
          const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
          const px = (mm: number) => mm / (surface.mmPerPx ?? 0.8073)
          // Below the ring, or above it when the dot is near the bottom edge.
          const below = cy + px(TARGET_MM.ringR + 30) < surface.heightPx - px(TARGET_MM.label)
          return (
            <text key="lidar-target-label" x={Math.min(Math.max(cx, px(90)), surface.widthPx - px(90))} y={below ? cy + px(TARGET_MM.ringR + 25) : cy - px(TARGET_MM.ringR + 12)} textAnchor="middle" fill="#ffffff" fontSize={px(TARGET_MM.label)} fontFamily="system-ui, sans-serif" fontWeight={700}>
              {(l as LidarTargetLine).label}
            </text>
          )
        })}
      </svg>
    </div>
  )
}
