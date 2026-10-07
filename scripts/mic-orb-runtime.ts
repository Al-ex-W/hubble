import { createOrbRenderer } from '../apps/web/src/hubble/orb/gl.ts'
import { createOrbDynamics } from '../apps/web/src/hubble/orb/dynamics.ts'
import { BAND_COUNT, foldVoiceBands } from '../apps/web/src/hubble/audio/spectrum.ts'

// Reuse the actual Hubble shader and voice dynamics. Render at display cadence
// independently of arriving audio packets, so network jitter cannot freeze the
// animation. Native resolution is intentional: downscaling the complete wide
// canvas also made the orb small and blurry, then stretched it back to TV size.
const canvas = document.querySelector('canvas')!
  const renderer = createOrbRenderer(canvas)
if (!renderer) throw new Error('This demo needs WebGL2 for the Hubble orb.')
const dynamics = createOrbDynamics('listening')
const bands = new Float32Array(BAND_COUNT)
let latest = { rms: 0, seq: 0, spectrum: [] as number[] }
let last = performance.now(), count = 0, start = last
let arrival = 0
const target = window as typeof window & { draw: (frame: typeof latest) => void; orbFPS: number }
target.orbFPS = 0
target.draw = frame => {
  latest = frame; arrival = performance.now()
  document.querySelector('#level')!.textContent = Math.round(frame.rms * 100) + '%'
  document.querySelector('#seq')!.textContent = String(frame.seq)
}
function animate(now: number) {
  const dtMs = now - last; last = now
  const active = now - arrival < 300
  if (active && latest.spectrum?.length) foldVoiceBands(Uint8Array.from(latest.spectrum), bands)
  else bands.fill(0)
  // For a latency probe the measured mic envelope is more direct than a
  // multi-second adaptive gain tracker and a dB-spectrum energy proxy.
  const level = active ? Math.min(1, latest.rms * 12) : 0
  const frame = dynamics.step({ state: 'listening', level, bands, dtMs })
  // Keep the Hubble appearance but bypass its 380ms conversational release
  // envelope for this signal probe. Silence now clears the drive immediately.
  frame.energy = level
  frame.radius = 1 + level * .14
  renderer!.render(frame, canvas.clientWidth, canvas.clientHeight)
  count++
  if (now - start >= 1000) {
    const fps = count * 1000 / (now - start)
    target.orbFPS = fps
    const output = document.querySelector('#fps')
    if (output) output.textContent = fps.toFixed(1)
    document.querySelector('#quality')?.replaceChildren(`Native resolution · ${canvas.width}×${canvas.height}`)
    count = 0; start = now
  }
  requestAnimationFrame(animate)
}
requestAnimationFrame(animate)
