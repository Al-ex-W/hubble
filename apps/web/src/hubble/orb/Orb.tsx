import { useEffect, useRef, useState } from 'react'
import { BAND_COUNT, bandEnergy, createAutoGain, foldVoiceBands } from '../audio/spectrum.ts'
import { createOrbDynamics, type OrbState } from './dynamics.ts'
import { createOrbRenderer } from './gl.ts'

/**
 * Where the orb gets sound from. Both return the SDK's voice-range frequency
 * bytes, or null when there is no live conversation.
 */
export interface AudioTap {
  input(): Uint8Array | null
  output(): Uint8Array | null
}

export interface OrbProps {
  state: OrbState
  tap: AudioTap
  onClick?: () => void
}

/**
 * Canvas host. Runs its own requestAnimationFrame loop that pulls audio from
 * the tap, steps the dynamics and draws — so the orb animates at display rate
 * without a React render per frame. React re-renders only on state changes,
 * which reach the loop through a ref.
 */
export function Orb({ state, tap, onClick }: OrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const tapRef = useRef(tap)
  tapRef.current = tap
  const [unsupported, setUnsupported] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let renderer: ReturnType<typeof createOrbRenderer>
    try {
      renderer = createOrbRenderer(canvas)
    } catch (err) {
      console.error(err)
      renderer = null
    }
    if (!renderer) {
      setUnsupported(true)
      return
    }

    const dynamics = createOrbDynamics(stateRef.current)
    // Separate gain trackers: the user's mic and the agent's voice arrive at
    // very different levels, and each should span the orb's full range.
    const inputGain = createAutoGain()
    const outputGain = createAutoGain()
    const inputBands = new Float32Array(BAND_COUNT)
    const outputBands = new Float32Array(BAND_COUNT)
    let last = performance.now()
    let raf = 0

    const sample = (bytes: Uint8Array | null, bands: Float32Array) => {
      if (bytes) foldVoiceBands(bytes, bands)
      else bands.fill(0)
    }

    const frame = (now: number) => {
      const dtMs = now - last
      last = now
      const current = stateRef.current
      sample(tapRef.current.input(), inputBands)
      sample(tapRef.current.output(), outputBands)
      // Both trackers learn every frame, so neither is stale when the turn
      // flips between the user and the agent.
      const inputLevel = inputGain.update(bandEnergy(inputBands), dtMs)
      const outputLevel = outputGain.update(bandEnergy(outputBands), dtMs)
      // While the agent talks the orb follows *its* voice; otherwise the user's.
      const speaking = current === 'speaking'
      const level = speaking ? outputLevel : inputLevel
      const bands = speaking ? outputBands : inputBands

      const f = dynamics.step({ state: current, level, bands, dtMs })
      renderer!.render(f, canvas.clientWidth, canvas.clientHeight)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      renderer!.dispose()
    }
  }, [])

  if (unsupported) {
    // Without WebGL2 there is no orb, but the assistant still works; keep a
    // calm stand-in so the page is not just empty.
    return <div className={`orb-fallback ${state}`} onClick={onClick} aria-label={`assistant ${state}`} />
  }
  return <canvas ref={canvasRef} className="orb" onClick={onClick} aria-label={`assistant ${state}`} />
}
